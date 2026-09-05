import { readFile } from "node:fs/promises";
import { loadConfiguration } from "./src/config.js";
import { createDatabase } from "./src/database.js";
import { createDevCompanionStore } from "./src/devCompanionStore.js";
import { wrapCompanionWithChronicleControl } from "./src/devCompanionChronicleWiring.js";
import { createBinanceLiveFeed } from "./src/market/binanceLiveFeed.js";
import { createBinanceDailyMaProvider } from "./src/market/binanceDailyMa.js";
import { DxtradeExecutionClient } from "./src/execution/dxtradeExecutionClient.js";
import { createPinnedDxtradeFetch } from "./src/execution/pinnedDxtradeFetch.js";
import { SolanaQuantityClient } from "./src/execution/solanaQuantityClient.js";
import { createSolanaQuantityAdapter } from "./src/execution/solanaQuantityAdapter.js";
import { createRingExecutionGuard } from "./src/execution/ringExecutionGuard.js";
import { createSolanaLiveCanary } from "./src/execution/solanaCanary.js";
import { createDxtradeAccountMonitor } from "./src/account/dxtradeAccountMonitor.js";
import { trustedSignedNetFor } from "./src/account/dxtradeSignedNet.js";
import { formatDxtradeAccountDiagnostic } from "./src/account/dxtradeDiagnostics.js";
import { createSolanaPersistence } from "./src/state/solanaPersistence.js";
import { createSolanaRuntime } from "./src/runtime/solanaRuntime.js";
import { clearLatchedBaselineMismatchHalt } from "./src/runtime/d049BaselineHaltClear.js";
import { nextReconciliationWarning } from "./src/runtime/reconciliationWarning.js";
import { createSolanaHeartbeat } from "./src/runtime/solanaHeartbeat.js";
import { createLiveTelegramNotifications } from "./src/notifications/liveTelegramNotifications.js";
import { accountDayKey } from "./src/risk/dailyRiskLadder.js";
import { createRiskSupervisor } from "./src/risk/riskSupervisor.js";
import { buildGridDefinition } from "./src/strategies/ringGridDefinition.js";
import { createRingGrid } from "./src/strategies/ringGrid.js";
import { createSolanaOwnerService } from "./src/solanaOwnerService.js";
import { createMultiInstrumentOwnerService } from "./src/multiInstrumentOwnerService.js";
import { startTelegramBot } from "./src/telegramBot.js";

const money = (v) => (Number.isFinite(v) ? `${v < 0 ? "-$" : "$"}${Math.abs(v).toFixed(2)}` : "unavailable");

const configuration = await loadConfiguration();
const { account, environment } = configuration;

const instrumentsFile = JSON.parse(await readFile(new URL("./config/instruments.json", import.meta.url), "utf8"));
const accountRisk = instrumentsFile.accountRisk;
const enabledInstruments = instrumentsFile.instruments.filter((entry) => entry.enabled === true);

if (enabledInstruments.length === 0) throw new Error("config/instruments.json enables no instruments");
for (const field of ["entryBrakeUsd", "entryBrakeScope", "partialCutUsd", "partialCutFraction", "fullFlattenUsd", "dailyLossLimitUsd"]) {
  if (accountRisk?.[field] === undefined) throw new Error(`config/instruments.json accountRisk.${field} is missing`);
}
const seenPrefixes = new Set();
for (const cfg of enabledInstruments) {
  if (seenPrefixes.has(cfg.orderPrefix)) throw new Error(`Duplicate orderPrefix "${cfg.orderPrefix}"`);
  seenPrefixes.add(cfg.orderPrefix);
  if (!Number.isFinite(cfg.sizing?.lotStep) || cfg.sizing.lotStep <= 0) {
    throw new Error(`${cfg.instrument}: sizing.lotStep must be a positive number read from the DXtrade platform`);
  }
  buildGridDefinition(cfg);
}

const database = createDatabase(environment);
await database.init(account);
await clearLatchedBaselineMismatchHalt(database);

const companionStore = createDevCompanionStore({
  databaseUrl: environment.databaseUrl,
  databaseSsl: environment.databaseSsl
});
await companionStore.init();
const devCompanion = wrapCompanionWithChronicleControl(companionStore);

const persistence = createSolanaPersistence(environment);
await persistence.init();

const liveNotifications = createLiveTelegramNotifications({
  persistence,
  addEvent: database.addEvent
});

const dxtradeClient = new DxtradeExecutionClient({
  restBaseUrl: environment.dxtrade.restBaseUrl,
  username: environment.dxtrade.username,
  domain: environment.dxtrade.domain,
  password: environment.dxtrade.password,
  accountCode: environment.dxtrade.accountCode,
  instrument: enabledInstruments[0].instrument,
  fetchImpl: createPinnedDxtradeFetch()
});

function accountLockReasonCode(invariantError) {
  if (typeof invariantError !== "string") return null;
  if (invariantError.startsWith("A foreign position exists")) return "FOREIGN_POSITION";
  if (invariantError === "DXtrade open-position count does not match position metrics") return "POSITION_COUNT_MISMATCH";
  return null;
}

let accountErrorLogged = false;
let accountLockLatched = false;
const accountMonitor = createDxtradeAccountMonitor({
  client: dxtradeClient,
  startingBalance: account.startingBalance,
  instruments: enabledInstruments.map((cfg) => cfg.instrument),
  getPersistedPeakClosedBalance: database.getPersistedPeakClosedBalance,
  onSnapshot: async (snapshot) => {
    accountErrorLogged = false;
    await database.syncAccountSnapshot(snapshot, account);
    if (snapshot.accountLocked) {
      if (!accountLockLatched) {
        accountLockLatched = true;
        const reasonCode = accountLockReasonCode(snapshot.invariantError);
        if (reasonCode) {
          const day = snapshot.fetchedAt.slice(0, 10).replaceAll("-", "");
          liveNotifications.enqueue({
            kind: "ACCOUNT_LOCKOUT",
            eventKey: `ACCOUNT-LOCK:${day}:${reasonCode}`,
            reasonCode
          });
        }
      }
    } else {
      accountLockLatched = false;
    }
  },
  onError: (error) => {
    if (!accountErrorLogged) {
      accountErrorLogged = true;
      console.error(`DXtrade account state is unavailable; new actions remain blocked on every instrument. ${formatDxtradeAccountDiagnostic(error)}`);
    }
  }
});

let maintenanceBusy = false;

async function buildInstrumentStack(cfg) {
  const definition = buildGridDefinition(cfg);

  const maProvider = createBinanceDailyMaProvider({
    marketSymbol: cfg.marketSymbol,
    days: cfg.geometry.maDays
  });
  await maProvider.refresh();

  const quantityClient = new SolanaQuantityClient({
    restBaseUrl: environment.dxtrade.restBaseUrl,
    username: environment.dxtrade.username,
    domain: environment.dxtrade.domain,
    password: environment.dxtrade.password,
    accountCode: environment.dxtrade.accountCode,
    instrument: cfg.instrument,
    fetchImpl: createPinnedDxtradeFetch()
  });

  const adapter = createSolanaQuantityAdapter({
    client: quantityClient,
    persistence,
    instrument: cfg.instrument
  });

  const execution = createRingExecutionGuard({
    autoExecute: environment.autoExecute,
    strategyAutoExecute: cfg.execution?.autoExecute ?? true,
    instrument: cfg.instrument,
    orderPrefix: cfg.orderPrefix,
    strategyId: definition.strategyId,
    adapter,
    client: quantityClient,
    persistence,
    protectiveOrdersBypassSlippageCap: accountRisk.protectiveOrdersBypassSlippageCap ?? true,
    addEvent: database.addEvent
  });

  const stack = {
    cfg,
    definition,
    maProvider,
    quantityClient,
    adapter,
    execution,
    runtime: null,
    feed: null,
    pendingTrade: null,
    draining: false,
    lastTrade: null,
    feedState: Object.freeze({ running: false, connected: false, stale: true }),
    persistedFeedStale: true,
    runtimeErrorLatched: false,
    reconciliationHaltLatched: false,
    reconciliationWarning: null,
    haltNotifications: new Set()
  };

  const grid = createRingGrid(definition);
  stack.runtime = createSolanaRuntime({
    instrument: cfg.instrument,
    strategyId: definition.strategyId,
    gridDefinition: definition,
    stateStore: persistence.createStateStore(grid),
    riskLadderStore: persistence,
    riskLadderConfig: accountRisk,
    maProvider,
    minimumHoldSeconds: account.minimumHoldSeconds,
    execution,
    addEvent: database.addEvent,
    notifications: liveNotifications,
    getRiskSnapshot: async () => {
      const accountStatus = accountMonitor.getSnapshot();
      const snapshot = accountStatus.snapshot;
      const book = snapshot?.signedNetByInstrument?.[cfg.instrument] ?? null;
      return Object.freeze({
        accountDataFresh: accountStatus.healthy === true,
        brokerNetUnits: trustedSignedNetFor(accountStatus, cfg.instrument),
        instrumentUnrealisedUsd: book?.openPl,
        instrumentDayPnlUsd: book ? Number(book.dayClosedPl) + Number(book.openPl) : null,
        instrumentExposureUsd: book?.notional
      });
    }
  });
  await stack.runtime.init();

  return stack;
}

const stacks = [];
for (const cfg of enabledInstruments) stacks.push(await buildInstrumentStack(cfg));
const stackByInstrument = new Map(stacks.map((s) => [s.cfg.instrument, s]));

// The account ladder reads the BROKER, not the strategy's per-tick cache.
//
// DXtrade's /positions payload is a position LIST: code, symbol, quantity, open price.
// It carries neither P&L nor markPrice. signedNetByInstrument therefore reports
// openPl 0 and notional 0 for every row, which is why the ladder saw $0.00 while real
// positions were open. Nets survived only because quantity and symbol have fallbacks.
//
// P&L for the whole account comes from /metrics, which is exact and is what the cut
// and flatten act on. Per-instrument figures are needed only for the proportional
// allocation and the per-instrument brake, so the account figure is apportioned by
// each book's share of live exposure. Exposure is computed from broker net units at
// the book's own last traded price, because the broker gives no mark.
//
// D-054 is preserved: an unread account THROWS. The supervisor catches it, marks the
// books unreadable, and brakes. Unknown is never reported as zero.
function accountMetrics() {
  const accountStatus = accountMonitor.getSnapshot();
  if (accountStatus?.healthy !== true) throw new Error("Broker account data is unavailable");
  const snapshot = accountStatus.snapshot;
  if (!snapshot || typeof snapshot !== "object") throw new Error("Broker account snapshot is unavailable");
  const openPl = Number(snapshot.openPl);
  const dayClosedPl = Number(snapshot.dayClosedPl ?? 0);
  if (!Number.isFinite(openPl) || !Number.isFinite(dayClosedPl)) {
    throw new Error("Broker account P&L is not a finite number");
  }
  return { snapshot, openPl, dayClosedPl };
}

function bookNetUnits(snapshot, instrument) {
  const units = Number(snapshot.signedNetByInstrument?.[instrument]?.netUnits ?? 0);
  return Number.isFinite(units) ? Math.abs(units) : 0;
}

// Broker notional when the broker supplies one; otherwise net units at this book's
// own last traded price. Exposure is reported, never used to trigger a rung, so a
// price that is a few seconds old is acceptable here.
function bookExposure(snapshot, instrument) {
  const brokerNotional = Number(snapshot.signedNetByInstrument?.[instrument]?.notional ?? 0);
  if (Number.isFinite(brokerNotional) && brokerNotional > 0) return Math.abs(brokerNotional);
  const stack = stackByInstrument.get(instrument);
  const price = Number(stack?.lastTrade?.price);
  const units = bookNetUnits(snapshot, instrument);
  if (!Number.isFinite(price) || price <= 0 || units === 0) return 0;
  return units * price;
}

// Share of account P&L attributed to one book. Exposure-weighted when exposure is
// known; otherwise split equally across the books that actually hold a position, so
// the per-instrument figures always sum to the exact account P&L rather than to zero.
function plShare(snapshot, instrument) {
  const totalExposure = stacks.reduce((sum, s) => sum + bookExposure(snapshot, s.cfg.instrument), 0);
  if (totalExposure > 0) return bookExposure(snapshot, instrument) / totalExposure;
  const holding = stacks.filter((s) => bookNetUnits(snapshot, s.cfg.instrument) > 0);
  if (holding.length === 0) return 0;
  return bookNetUnits(snapshot, instrument) > 0 ? 1 / holding.length : 0;
}

function instrumentPl(instrument, field) {
  const { snapshot, openPl, dayClosedPl } = accountMetrics();
  const direct = Number(snapshot.signedNetByInstrument?.[instrument]?.[field]);
  if (Number.isFinite(direct) && direct !== 0) return direct;   // broker gave a real figure
  return (field === "openPl" ? openPl : dayClosedPl) * plShare(snapshot, instrument);
}

const riskSupervisor = createRiskSupervisor({
  config: accountRisk,
  instruments: stacks.map((s) => Object.freeze({
    instrument: s.cfg.instrument,
    getUnrealisedUsd: () => instrumentPl(s.cfg.instrument, "openPl"),
    getDayPnlUsd: () => instrumentPl(s.cfg.instrument, "dayClosedPl") + instrumentPl(s.cfg.instrument, "openPl"),
    getExposureUsd: () => bookExposure(accountMetrics().snapshot, s.cfg.instrument),
    setEntryBrake: (on) => s.runtime.setEntryBrake(on),
    executeProtectiveCut: (args) => s.runtime.executeProtectiveCut(args),
    executeProtectiveFlatten: (args) => s.runtime.executeProtectiveFlatten(args)
  })),
  addEvent: database.addEvent,
  notifications: liveNotifications
});

for (const stack of stacks) stack.runtime.attachRiskSupervisor(riskSupervisor);

async function persistD049SafetyHalt(stack, result) {
  const code = result.status;
  const reasonCode = ["D049_PARTIAL_CUT_UNCONFIRMED", "D049_FULL_FLATTEN_UNCONFIRMED", "D049_BASELINE_MISMATCH"].includes(code)
    ? code
    : null;
  if (!reasonCode) return;

  const reason = reasonCode === "D049_PARTIAL_CUT_UNCONFIRMED"
    ? `D-049 protective partial cut did not confirm on ${stack.cfg.instrument}; owner review required`
    : reasonCode === "D049_FULL_FLATTEN_UNCONFIRMED"
      ? `D-049 protective full flatten did not confirm flat on ${stack.cfg.instrument}; manual intervention required`
      : `D-049 persisted daily baseline does not match fresh DXtrade account data; owner review required`;

  await database.setSafetyHalt(reason);
  await database.addEvent("ERROR", "D049_SAFETY_HALT", { instrument: stack.cfg.instrument, reasonCode, status: code });
  const day = accountDayKey(Date.now()).replaceAll("-", "");
  const eventKey = `D049-HALT:${stack.cfg.orderPrefix}:${day}:${reasonCode}`;
  if (!stack.haltNotifications.has(eventKey)) {
    stack.haltNotifications.add(eventKey);
    liveNotifications.enqueue({ kind: "SAFETY_HALT", eventKey, reasonCode, instrument: stack.cfg.instrument });
  }
}

async function applyReconciliationBlocked(stack, result) {
  const decision = nextReconciliationWarning(stack.reconciliationWarning, { now: Date.now(), mismatched: true });
  stack.reconciliationWarning = decision.state;
  const recon = result.reconciliation;
  const version = Number.isSafeInteger(result.stateVersion)
    ? result.stateVersion
    : (Number.isSafeInteger(result.state?.version) ? result.state.version : 0);
  if (decision.action === "ALERT" && recon && Number.isFinite(recon.actual) && Number.isFinite(recon.expected)) {
    liveNotifications.enqueue({
      kind: "RECONCILIATION_MISMATCH",
      eventKey: `RECON-WARN:${stack.cfg.orderPrefix}:${decision.alertNumber}:${version}`,
      instrument: stack.cfg.instrument,
      stage: "WARNING",
      warningNumber: decision.alertNumber,
      stateVersion: version,
      expectedVirtualNetUnits: recon.expected,
      brokerNetUnits: recon.actual
    });
    await database.addEvent("WARN", "RECONCILIATION_MISMATCH_WARNING", {
      instrument: stack.cfg.instrument,
      alertNumber: decision.alertNumber,
      expectedVirtualNetUnits: recon.expected,
      brokerNetUnits: recon.actual
    });
  }
  if (decision.action === "HALT" && !stack.reconciliationHaltLatched) {
    stack.reconciliationHaltLatched = true;
    await database.setSafetyHalt(`${stack.cfg.instrument} virtual-lot state does not reconcile to the DXtrade net position after 15 minutes; owner review required`);
    await database.addEvent("ERROR", "RECONCILIATION_SAFETY_HALT", { instrument: stack.cfg.instrument, action: "SAFETY_HALT" });
    if (recon && Number.isFinite(recon.actual) && Number.isFinite(recon.expected)) {
      liveNotifications.enqueue({
        kind: "RECONCILIATION_MISMATCH",
        eventKey: `RECON-HALT:${stack.cfg.orderPrefix}:${version}:${Number(recon.expected).toFixed(8)}:${Number(recon.actual).toFixed(8)}`,
        instrument: stack.cfg.instrument,
        stage: "HALT",
        stateVersion: version,
        expectedVirtualNetUnits: recon.expected,
        brokerNetUnits: recon.actual
      });
    }
  }
}

async function processLatestTrade(stack, trade) {
  const result = await stack.runtime.processTrade(trade);
  if (result.status === "RECONCILIATION_BLOCKED") {
    await applyReconciliationBlocked(stack, result);
  } else {
    stack.reconciliationWarning = null;
  }
  if (["D049_PARTIAL_CUT_UNCONFIRMED", "D049_FULL_FLATTEN_UNCONFIRMED", "D049_BASELINE_MISMATCH"].includes(result.status)) {
    await persistD049SafetyHalt(stack, result);
  }
  await riskSupervisor.evaluate({ dayKey: accountDayKey(Date.now()) });
}

async function drainLatestTrades(stack) {
  if (stack.draining || maintenanceBusy) return;
  stack.draining = true;
  try {
    while (stack.pendingTrade && !maintenanceBusy) {
      const trade = stack.pendingTrade;
      stack.pendingTrade = null;
      await processLatestTrade(stack, trade);
    }
  } catch (error) {
    if (!stack.runtimeErrorLatched) {
      stack.runtimeErrorLatched = true;
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`${stack.cfg.instrument} runtime error; new strategy actions are being halted for that instrument.`);
      console.error(detail);
      if (error instanceof Error && error.stack) console.error(error.stack);
      try {
        await database.setSafetyHalt(`${stack.cfg.instrument} production runtime error; owner review required`);
        await database.addEvent("ERROR", "RUNTIME_ERROR", {
          instrument: stack.cfg.instrument,
          action: "SAFETY_HALT",
          message: detail.slice(0, 500)
        });
        const hour = new Date().toISOString().slice(0, 13).replaceAll("-", "").replace("T", "-");
        liveNotifications.enqueue({
          kind: "SAFETY_HALT",
          eventKey: `RUNTIME-HALT:${stack.cfg.orderPrefix}:${hour}`,
          reasonCode: "RUNTIME_ERROR",
          instrument: stack.cfg.instrument
        });
      } catch {
        console.error(`Could not persist the ${stack.cfg.instrument} runtime safety halt.`);
      }
    }
  } finally {
    stack.draining = false;
    if (stack.pendingTrade && !stack.runtimeErrorLatched && !maintenanceBusy) void drainLatestTrades(stack);
  }
}

for (const stack of stacks) {
  stack.feed = createBinanceLiveFeed({
    symbol: stack.cfg.marketSymbol,
    onPrice: (trade) => {
      stack.lastTrade = trade;
      stack.pendingTrade = trade;
      if (!stack.draining && !maintenanceBusy && !stack.runtimeErrorLatched) void drainLatestTrades(stack);
    },
    onState: (state) => {
      stack.feedState = state;
      const stale = state.connected !== true || state.stale === true;
      if (stale !== stack.persistedFeedStale) {
        stack.persistedFeedStale = stale;
        void database.setFeedStale(stale, stack.cfg.instrument)
          .catch(() => console.error(`Could not persist ${stack.cfg.marketSymbol} feed-health state.`));
      }
    },
    onError: () => {
      console.error(`Binance ${stack.cfg.marketSymbol} live-feed message was rejected; feed freshness controls remain active.`);
    }
  });
}

const heartbeatStack = stacks[0];
const heartbeat = createSolanaHeartbeat({
  persistence,
  adapter: heartbeatStack.adapter,
  instrument: heartbeatStack.cfg.instrument,
  isExecutionEnabled: heartbeatStack.execution.isEnabled,
  isRiskLadderHalted: async () => {
    const ladder = riskSupervisor.getSnapshot();
    return ladder?.flattenedToday === true && ladder.dayKey === accountDayKey(Date.now());
  },
  triggerDays: accountRisk.heartbeatDays ?? 25,
  acquireMaintenance: async () => {
    if (maintenanceBusy || stacks.some((s) => s.draining)) return false;
    maintenanceBusy = true;
    return true;
  },
  releaseMaintenance: async () => {
    maintenanceBusy = false;
    for (const stack of stacks) {
      if (stack.pendingTrade && !stack.runtimeErrorLatched) void drainLatestTrades(stack);
    }
  },
  addEvent: database.addEvent,
  notifications: liveNotifications
});

const liveCanary = createSolanaLiveCanary({
  adapter: heartbeatStack.adapter,
  client: heartbeatStack.quantityClient,
  persistence,
  addEvent: database.addEvent,
  automaticExecutionEnabled: heartbeatStack.execution.isEnabled,
  minimumHoldSeconds: account.minimumHoldSeconds
});

const service = createMultiInstrumentOwnerService({
  // Surfaces the raw /metrics figures in /status. equity - balance is the account's
  // open P&L; if that gap is non-zero while combined day P&L reads $0.00, the ladder
  // is not reading the broker and the numbers above it cannot be trusted.
  brokerAccountLine: () => {
    const accountStatus = accountMonitor.getSnapshot();
    if (accountStatus?.healthy !== true) return "  broker: account data unavailable";
    const snap = accountStatus.snapshot ?? {};
    const eq = Number(snap.equity);
    const bal = Number(snap.balance);
    const gap = Number.isFinite(eq) && Number.isFinite(bal) ? eq - bal : null;
    return `  broker /metrics: equity ${money(eq)}  balance ${money(bal)}` +
      `  openPl ${money(Number(snap.openPl))}  dayClosedPl ${money(Number(snap.dayClosedPl ?? 0))}` +
      (gap === null ? "" : `  (equity-balance ${money(gap)})`);
  },
  instrumentConfigs: enabledInstruments,
  riskSupervisor,
  // Required by /re-run. Without `database` the rerun handlers degrade to
  // "Re-run is not configured on this deployment." and the command does nothing.
  database,
  // A latched runtime error also lives in memory on each stack, so clearing only
  // the Postgres safety_halt would leave the books blocked. Both must clear.
  onRuntimeHaltCleared: () => {
    for (const stack of stacks) stack.runtimeErrorLatched = false;
  },
  buildOwnerService: (cfg) => {
    const stack = stackByInstrument.get(cfg.instrument);
    return createSolanaOwnerService({
      database,
      account,
      strategy: {
        ...cfg,
        strategyId: stack.definition.strategyId,
        strategyType: "moving-ma-outer-heavy-grid",
        strategyStatus: "active",
        instruments: { [cfg.instrument]: { enabled: true } },
        execution: { autoExecute: cfg.execution?.autoExecute ?? true },
        riskLadder: accountRisk
      },
      environment,
      instrument: cfg.instrument,
      gridDefinition: stack.definition,
      dxtradeClient,
      persistence,
      maProvider: stack.maProvider,
      execution: stack.execution,
      canary: cfg.instrument === heartbeatStack.cfg.instrument ? liveCanary : null,
      accountMonitor,
      onBooksRematched: async () => {
        stack.reconciliationHaltLatched = false;
        stack.reconciliationWarning = null;
      },
      getLiveMarketSnapshot: () => Object.freeze({
        price: stack.lastTrade?.price ?? null,
        tradeTime: stack.lastTrade?.tradeTime ?? null,
        stale: stack.feedState.connected !== true || stack.feedState.stale === true
      })
    });
  }
});

const telegramBot = await startTelegramBot({
  environment,
  service,
  notifications: liveNotifications,
  devCompanion
});

await accountMonitor.start();
for (const stack of stacks) stack.feed.start();

const HEARTBEAT_CHECK_MS = 60 * 60 * 1000;
const heartbeatTimer = setInterval(() => {
  void heartbeat.checkOnce().catch(async () => {
    console.error("Inactivity heartbeat check failed; owner review may be required before the inactivity deadline.");
    try {
      await database.addEvent("ERROR", "HEARTBEAT_CHECK_FAILED", { action: "REVIEW" });
    } catch {
      console.error("Could not persist heartbeat failure event.");
    }
  });
}, HEARTBEAT_CHECK_MS);
heartbeatTimer.unref?.();
void heartbeat.checkOnce().catch(() => console.error("Initial heartbeat check failed."));

const executionLive = stacks.every((s) => s.execution.isEnabled());
const anyExecutionLive = stacks.some((s) => s.execution.isEnabled());
console.log(anyExecutionLive
  ? "Production multi-instrument runtime started with automatic execution LIVE."
  : "Production multi-instrument runtime started ARMED with automatic execution still blocked by the Railway control.");
console.log(`Instruments enabled: ${stacks.length}`);
for (const stack of stacks) {
  const d = stack.definition;
  console.log(`  ${stack.cfg.instrument.padEnd(9)} ${d.levels} rings/side, ±${(d.innermostDistance * 100).toFixed(1)}% .. ±${(d.outermostDistance * 100).toFixed(1)}% of ${stack.cfg.geometry.maDays}d MA, $${stack.cfg.sizing.capUsd.toLocaleString()} cap, feed ${stack.cfg.marketSymbol}`);
}
console.log(`Account risk ladder: entry brake -$${accountRisk.entryBrakeUsd} per instrument, ${Math.round(accountRisk.partialCutFraction * 100)}% cut -$${accountRisk.partialCutUsd} account-wide (proportional to loss), full flatten -$${accountRisk.fullFlattenUsd} account-wide until rollover.`);
console.log(`Daily loss limit: -$${accountRisk.dailyLossLimitUsd}. Rollover ${accountRisk.rolloverHourUtc ?? 22}:00 UTC.`);
console.log("Live-touch semantics: exits before entries. One-sided per instrument (D-059).");
console.log("Owner Telegram broker-confirmed trade and safety notifications: armed.");
console.log("Owner Telegram OpenAI development mode: queue bridge armed; companion processing runs in the separate Railway worker.");
console.log(anyExecutionLive
  ? "Owner-triggered lifecycle canary is disabled while automatic execution is ON."
  : `Owner-triggered 0.01-lot lifecycle canary remains available on ${heartbeatStack.cfg.instrument} while automatic execution is OFF.`);
console.log(`${accountRisk.heartbeatDays ?? 25}-day inactivity heartbeat: armed on ${heartbeatStack.cfg.instrument}.`);
console.log(`Automatic execution: ${executionLive ? "ON" : anyExecutionLive ? "PARTIAL" : "OFF"} (Railway=${environment.autoExecute ? "ON" : "OFF"}, mode=${environment.appMode}).`);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down cleanly.`);
  clearInterval(heartbeatTimer);
  telegramBot.stopDevCompanionDelivery?.();
  for (const stack of stacks) stack.feed.stop();
  accountMonitor.stop();
  try {
    await telegramBot.stopPolling();
  } finally {
    try { await liveNotifications.drain(); } catch { console.error("Telegram notification queue did not drain cleanly."); }
    try { await dxtradeClient.logout(); } catch { console.error("DXtrade account-monitor logout did not complete cleanly."); }
    for (const stack of stacks) {
      try {
        await stack.quantityClient.logout();
      } catch {
        console.error(`DXtrade ${stack.cfg.instrument} execution logout did not complete cleanly.`);
      }
    }
    await Promise.allSettled([database.close(), persistence.close(), devCompanion.close()]);
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
