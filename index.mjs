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
import { createSolanaHeartbeat } from "./src/runtime/solanaHeartbeat.js";
import { createLiveTelegramNotifications } from "./src/notifications/liveTelegramNotifications.js";
import { accountDayKey } from "./src/risk/dailyRiskLadder.js";
import { createRiskSupervisor } from "./src/risk/riskSupervisor.js";
import { buildGridDefinition } from "./src/strategies/ringGridDefinition.js";
import { createRingGrid } from "./src/strategies/ringGrid.js";
import { createSolanaOwnerService } from "./src/solanaOwnerService.js";
import { createMultiInstrumentOwnerService } from "./src/multiInstrumentOwnerService.js";
import { startTelegramBot } from "./src/telegramBot.js";

const configuration = await loadConfiguration();
const { account, environment } = configuration;

// ---------------------------------------------------------------------------
// D-060: instruments come from config, not from a frozen single-asset check.
// ---------------------------------------------------------------------------
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

// Shared across every instrument. Persistence is keyed by (strategyId, instrument)
// per D-060 §4, so one store serves all books.
const persistence = createSolanaPersistence(environment);
await persistence.init();

const liveNotifications = createLiveTelegramNotifications({
  persistence,
  addEvent: database.addEvent
});

// ---------------------------------------------------------------------------
// Account monitor is account-wide, not per instrument. It must accept every
// enabled instrument as legitimate; anything else is still a foreign position.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// One stack per instrument. Each stack is the single-instrument production
// pipeline, instantiated with its own geometry. A fault in one book cannot
// reach another.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Account-level risk supervisor. Owns the D-049 ladder across every book:
// brake per instrument, 50% cut proportional to loss, account-wide flatten.
// ---------------------------------------------------------------------------
const riskSupervisor = createRiskSupervisor({
  config: accountRisk,
  instruments: stacks.map((s) => Object.freeze({
    instrument: s.cfg.instrument,
    getUnrealisedUsd: () => s.runtime.getUnrealisedUsd(),
    getDayPnlUsd: () => s.runtime.getDayPnlUsd(),
    getExposureUsd: () => s.runtime.getExposureUsd(),
    setEntryBrake: (on) => s.runtime.setEntryBrake(on),
    executeProtectiveCut: (args) => s.runtime.executeProtectiveCut(args),
    executeProtectiveFlatten: (args) => s.runtime.executeProtectiveFlatten(args)
  })),
  addEvent: database.addEvent,
  notifications: liveNotifications
});

for (const stack of stacks) stack.runtime.attachRiskSupervisor(riskSupervisor);

// ---------------------------------------------------------------------------
// Trade draining, per instrument. maintenanceBusy stays global because the
// heartbeat must not run while any book is mid-trade.
// ---------------------------------------------------------------------------
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

async function processLatestTrade(stack, trade) {
  const result = await stack.runtime.processTrade(trade);
  if (result.status === "RECONCILIATION_BLOCKED" && !stack.reconciliationHaltLatched) {
    stack.reconciliationHaltLatched = true;
    await database.setSafetyHalt(`${stack.cfg.instrument} virtual-lot state does not reconcile to the DXtrade net position; owner review required`);
    await database.addEvent("ERROR", "RECONCILIATION_SAFETY_HALT", { instrument: stack.cfg.instrument, action: "SAFETY_HALT" });
    const recon = result.reconciliation;
    if (recon && Number.isFinite(recon.actual)) {
      liveNotifications.enqueue({
        kind: "RECONCILIATION_MISMATCH",
        eventKey: `RECON:${stack.cfg.orderPrefix}:${result.state.version}:${Number(recon.expected).toFixed(8)}:${Number(recon.actual).toFixed(8)}`,
        instrument: stack.cfg.instrument,
        stateVersion: result.state.version,
        expectedVirtualNetUnits: recon.expected,
        brokerNetUnits: recon.actual
      });
    }
  }
  if (["D049_PARTIAL_CUT_UNCONFIRMED", "D049_FULL_FLATTEN_UNCONFIRMED", "D049_BASELINE_MISMATCH"].includes(result.status)) {
    await persistD049SafetyHalt(stack, result);
  }
  // The ladder is evaluated on combined equity after every processed trade.
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
  } catch {
    if (!stack.runtimeErrorLatched) {
      stack.runtimeErrorLatched = true;
      console.error(`${stack.cfg.instrument} runtime error; new strategy actions are being halted for that instrument.`);
      try {
        await database.setSafetyHalt(`${stack.cfg.instrument} production runtime error; owner review required`);
        await database.addEvent("ERROR", "RUNTIME_ERROR", { instrument: stack.cfg.instrument, action: "SAFETY_HALT" });
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

// ---------------------------------------------------------------------------
// One Binance feed per instrument.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Inactivity heartbeat is an ACCOUNT-level obligation, not a per-instrument one.
// One round trip on the first enabled instrument satisfies it for the account.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Canary runs on one instrument only, and only while execution is OFF.
// ---------------------------------------------------------------------------
const liveCanary = createSolanaLiveCanary({
  adapter: heartbeatStack.adapter,
  client: heartbeatStack.quantityClient,
  persistence,
  addEvent: database.addEvent,
  automaticExecutionEnabled: heartbeatStack.execution.isEnabled,
  minimumHoldSeconds: account.minimumHoldSeconds
});

// ---------------------------------------------------------------------------
// Telegram: one owner service per instrument, fanned out by the wrapper.
// ---------------------------------------------------------------------------
const service = createMultiInstrumentOwnerService({
  instrumentConfigs: enabledInstruments,
  riskSupervisor,
  buildOwnerService: (cfg) => {
    const stack = stackByInstrument.get(cfg.instrument);
    return createSolanaOwnerService({
      database,
      account,
      // The legacy owner/tradeify services still call resolveInstrumentProfile(strategy),
      // which reads strategy.instruments and requires exactly one enabled entry. Give
      // each per-instrument service a strategy object of that shape so it resolves its
      // own profile. strategyStatus and execution are read by those services too.
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

// Start live inputs only after the owner notification destination is ready.
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
