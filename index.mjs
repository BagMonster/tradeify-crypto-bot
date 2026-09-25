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
import { createRingExecutionGuard, accountOrderEpoch } from "./src/execution/ringExecutionGuard.js";
import { createSolanaLiveCanary } from "./src/execution/solanaCanary.js";
import { createDxtradeAccountMonitor } from "./src/account/dxtradeAccountMonitor.js";
import { trustedSignedNetFor } from "./src/account/dxtradeSignedNet.js";
import { formatDxtradeAccountDiagnostic } from "./src/account/dxtradeDiagnostics.js";
import { createSolanaPersistence } from "./src/state/solanaPersistence.js";
import { createHaltWarningCycle } from "./src/state/haltWarningCycle.js";
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
import { runReconciliationPass } from "./src/runtime/hybridAbsorber.js";
import { startTelegramBot } from "./src/telegramBot.js";
import { describeAccountProfile } from "./src/config/accountProfile.js";
import { createExposureGate, formatExposurePoolLine } from "./src/risk/exposureGate.js";
import { createLivenessStore, createLivenessHeartbeat } from "./src/monitoring/livenessStore.js";
import { createDailyDustCleanupCoordinator } from "./src/risk/dailyDustCleanup.js";

const money = (v) => (Number.isFinite(v) ? `${v < 0 ? "-$" : "$"}${Math.abs(v).toFixed(2)}` : "unavailable");

const configuration = await loadConfiguration();
const { account, environment } = configuration;

// Account-size numbers (limits, ladder, harvest, per-coin cap) come from the
// profile named by the ACCOUNT_PROFILE Railway variable, already applied by
// loadConfiguration(). This is the profile-applied copy of config/instruments.json.
const instrumentsFile = configuration.instrumentsRaw;
console.log(describeAccountProfile(configuration.profile));
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

// Every client order code carries this, so codes can never collide with those the
// same DXtrade login already used on a previous account (2026-09-22 incident).
const orderCodeEpoch = accountOrderEpoch(environment.dxtrade.accountCode);

const database = createDatabase(environment);
await database.init(account);

// Deadman switch, bot side. The bot records when a risk evaluation last completed and
// writes it to Postgres every 30 seconds; watchdog/deadman.mjs, a separate Railway
// service, reads it and pages the owner directly if it goes stale. See
// src/monitoring/livenessStore.js.
const livenessStore = createLivenessStore({ databaseUrl: environment.databaseUrl, databaseSsl: environment.databaseSsl });
await livenessStore.init();
const liveness = createLivenessHeartbeat({
  store: livenessStore,
  profile: configuration.profile?.name ?? null,
  // Seconds since each book's last Binance trade. Read lazily: stacks exist by the
  // time the first flush runs.
  getFeeds: () => Object.fromEntries(stacks.map((stack) => {
    const at = Date.parse(stack.lastTrade?.tradeTime ?? "");
    return [stack.cfg.instrument, Number.isFinite(at) ? Math.max(0, Math.round((Date.now() - at) / 1000)) : null];
  })),
  onWriteError: (error, failures) => {
    if (failures === 1 || failures % 10 === 0) {
      console.error(`Deadman heartbeat write failed (${failures} in a row): ${error?.message ?? "unknown error"}. The watchdog will report the bot as silent if this continues.`);
    }
  }
});
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
          await requestNonHarvestHalt({
            key: `ACCOUNT_LOCKOUT:${reasonCode}`,
            reasonCode: "ACCOUNT_LOCKOUT",
            reason: snapshot.invariantError,
            correction: "Inspect /status and DXtrade positions. Clear the unexpected broker-position condition, or send /pausehalt to defer the durable halt."
          });
        }
      }
    } else {
      accountLockLatched = false;
      await clearNonHarvestHalt("ACCOUNT_LOCKOUT:FOREIGN_POSITION");
      await clearNonHarvestHalt("ACCOUNT_LOCKOUT:POSITION_COUNT_MISMATCH");
    }
  },
  onError: (error) => {
    if (!accountErrorLogged) {
      accountErrorLogged = true;
      console.error(`DXtrade account state is unavailable; new actions remain blocked on every instrument. ${formatDxtradeAccountDiagnostic(error)}`);
    }
  }
});

// Account-wide exposure pool: one gate shared by every book, in front of every new
// entry. Built only when the active account profile defines exposurePool; with no
// pool (the 50k profile) entries behave exactly as before. See src/risk/exposureGate.js.
//
// Exposure is the same broker-notional figure riskSupervisor and /status report. If
// broker account data is not healthy this throws, and the gate refuses the entry:
// unknown exposure is never treated as zero.
function readAccountExposure() {
  const status = accountMonitor.getSnapshot();
  if (status?.healthy !== true || !status.snapshot) throw new Error("Broker account data is unavailable");
  const exposureUsd = enabledInstruments.reduce((sum, cfg) => sum + bookExposure(status.snapshot, cfg.instrument), 0);
  return { exposureUsd, observedAtMs: Number(status.snapshot.fetchedAtMs) };
}

const exposureGate = accountRisk.exposurePool
  ? createExposureGate({
    softUsd: accountRisk.exposurePool.softUsd,
    hardUsd: accountRisk.exposurePool.hardUsd,
    readExposure: readAccountExposure,
    notifications: liveNotifications,
    addEvent: database.addEvent
  })
  : null;
console.log(exposureGate
  ? `Exposure pool: ARMED. No new entries at or above $${accountRisk.exposurePool.softUsd.toLocaleString()} account exposure; no single fill past $${accountRisk.exposurePool.hardUsd.toLocaleString()}.`
  : "Exposure pool: NOT SET in the active account profile. New entries are not limited by account exposure.");

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
    orderCodeEpoch,
    strategyId: definition.strategyId,
    adapter,
    client: quantityClient,
    persistence,
    protectiveOrdersBypassSlippageCap: accountRisk.protectiveOrdersBypassSlippageCap ?? true,
    addEvent: database.addEvent,
    // Blocked-entry/exit and recovery alerts (2026-09-21).
    notifications: liveNotifications,
    // Account-wide exposure pool, shared by every book (null when not configured).
    exposureGate
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
const startupDustCleanupDayKey = accountDayKey(Date.now());

const dailyDustCleanup = createDailyDustCleanupCoordinator({
  accountRisk,
  books: stacks.map((stack) => Object.freeze({
    instrument: stack.cfg.instrument,
    isExecutionEnabled: () => stack.execution.isEnabled(),
    isMarketReady: () => Number.isFinite(Number(stack.lastTrade?.price)) &&
      stack.feedState.connected === true && stack.feedState.stale !== true,
    runDustCleanup: (args) => stack.runtime.executeDustCleanup({ ...args, markPrice: stack.lastTrade?.price })
  })),
  store: database,
  addEvent: database.addEvent,
  notifications: liveNotifications
});

async function runDailyDustCleanup({ immediate = false } = {}) {
  if (maintenanceBusy || stacks.some((stack) => stack.draining)) return Object.freeze({ action: "BUSY" });
  maintenanceBusy = true;
  try {
    return await dailyDustCleanup.run({ immediate });
  } finally {
    maintenanceBusy = false;
    for (const stack of stacks) {
      if (stack.pendingTrade && !stack.runtimeErrorLatched) void drainLatestTrades(stack);
    }
  }
}

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
// Balance captured at the last 22:00 UTC rollover. Day P&L is measured against it.
let dayOpenBalance = null;
let dayOpenBalanceKey = null;

function accountMetrics() {
  const accountStatus = accountMonitor.getSnapshot();
  if (accountStatus?.healthy !== true) throw new Error("Broker account data is unavailable");
  const snapshot = accountStatus.snapshot;
  if (!snapshot || typeof snapshot !== "object") throw new Error("Broker account snapshot is unavailable");

  const equity = Number(snapshot.equity);
  const balance = Number(snapshot.balance);
  if (!Number.isFinite(equity) || !Number.isFinite(balance)) {
    throw new Error("Broker equity or balance is not a finite number");
  }

  // DXtrade's /metrics payload does not use the field names openPl or dayClosedPl on
  // this account, so both parse as 0 and the ladder saw a flat book while positions
  // were open. equity and balance DO parse, and everything needed follows from them:
  //
  //   unrealised = equity - balance
  //   realised today = balance - balance at the last rollover
  //   day P&L = unrealised + realised = equity - balance at the last rollover
  //
  // A named field is still preferred if the broker ever supplies a real one.
  const namedOpenPl = Number(snapshot.openPl);
  const openPl = Number.isFinite(namedOpenPl) && namedOpenPl !== 0 ? namedOpenPl : equity - balance;

  const key = accountDayKey(Date.now());
  if (dayOpenBalanceKey !== key) {
    dayOpenBalanceKey = key;
    dayOpenBalance = balance;
  }

  const namedDayClosedPl = Number(snapshot.dayClosedPl);
  const dayClosedPl = Number.isFinite(namedDayClosedPl) && namedDayClosedPl !== 0
    ? namedDayClosedPl
    : balance - dayOpenBalance;

  return { snapshot, equity, balance, openPl, dayClosedPl, dayOpenBalance };
}

function bookNetUnits(snapshot, instrument) {
  const units = Number(snapshot.signedNetByInstrument?.[instrument]?.netUnits ?? 0);
  return Number.isFinite(units) ? Math.abs(units) : 0;
}

let haltWarnings = null;
async function requestNonHarvestHalt(input) {
  if (!haltWarnings) throw new Error("halt-warning controller is not initialized");
  return haltWarnings.request(input);
}
async function clearNonHarvestHalt(key) {
  if (!haltWarnings) return false;
  return haltWarnings.clear(key);
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
    setTrancheExitsPaused: (on) => s.runtime.setTrancheExitsPaused(on),
    executeProtectiveCut: (args) => s.runtime.executeProtectiveCut(args),
    executeProtectiveFlatten: (args) => s.runtime.executeProtectiveFlatten(args)
  })),
  addEvent: database.addEvent,
  notifications: liveNotifications,
  harvestStore: Object.freeze({
    get: (dayKey) => database.getSessionHarvestState(dayKey),
    save: (state) => database.saveSessionHarvestState(state)
  }),
  getCombinedDayPnlUsd: () => {
    const { openPl, dayClosedPl } = accountMetrics();
    return openPl + dayClosedPl;
  },
  setSafetyHalt: (reason) => database.setSafetyHalt(reason),
  clearSafetyHaltIfReason: (reason) => database.clearSafetyHaltIfReason(reason),
  getSafetyHaltState: () => database.getState(),
  requestHaltWarning: requestNonHarvestHalt
});

haltWarnings = createHaltWarningCycle({
  store: {
    get: () => database.getHaltWarningCycle(),
    save: (cycle) => database.saveHaltWarningCycle(cycle),
    clear: (key) => database.clearHaltWarningCycle(key)
  },
  notifications: liveNotifications,
  addEvent: database.addEvent,
  onDue: async (cycle) => {
    if (cycle.reasonCode === "D060_ACCOUNT_FULL_FLATTEN") {
      return riskSupervisor.executeDeferredFullFlatten({ dayKey: accountDayKey(Date.now()) });
    }
    if (cycle.reasonCode === "RUNTIME_ERROR") {
      const stack = stackByInstrument.get(cycle.instrument);
      if (stack) stack.runtimeErrorLatched = true;
    }
    await database.setSafetyHalt(cycle.reason);
    await database.addEvent("ERROR", "OWNER_WARNING_CYCLE_SAFETY_HALT", {
      reasonCode: cycle.reasonCode,
      instrument: cycle.instrument,
      reason: cycle.reason
    });
    liveNotifications.enqueue({
      kind: "SAFETY_HALT",
      eventKey: `HALT-FIRED:${cycle.key}:${cycle.haltAt.replaceAll(/[-:.TZ]/g, "")}`,
      reasonCode: cycle.reasonCode,
      instrument: cycle.instrument
    });
    return Object.freeze({ action: "HALT" });
  }
});
await haltWarnings.prime();

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

  const day = accountDayKey(Date.now()).replaceAll("-", "");
  await requestNonHarvestHalt({
    key: `D049:${stack.cfg.orderPrefix}:${day}:${reasonCode}`,
    reasonCode,
    instrument: stack.cfg.instrument,
    reason,
    correction: "Inspect /status and DXtrade before taking the documented recovery path. Send /pausehalt to defer this safety halt for another 25-minute warning cycle."
  });
}

async function applyReconciliationBlocked(stack, result) {
  // Hybrid mode owns this decision now. The hybrid reconciliation pass compares
  // every book against the broker each minute, identifies manual fills from the
  // order history and absorbs them; only a divergence it cannot explain opens a
  // halt-warning cycle (HYBRID_UNEXPLAINED_NET). The old behaviour here warned
  // and halted on ANY mismatch, which fired on every deliberate manual trade
  // because it had no way to tell an owner fill from a broker-side problem.
  const recon = result.reconciliation;
  if (!recon || !Number.isFinite(recon.actual) || !Number.isFinite(recon.expected)) return;
  const version = Number.isSafeInteger(result.stateVersion)
    ? result.stateVersion
    : (Number.isSafeInteger(result.state?.version) ? result.state.version : 0);
  await database.addEvent("WARN", "RECONCILIATION_MISMATCH_OBSERVED", {
    instrument: stack.cfg.instrument,
    expected: Number(recon.expected),
    actual: Number(recon.actual),
    stateVersion: version,
    note: "recorded only; the hybrid reconciliation pass decides whether this needs owner attention"
  });
}

async function processLatestTrade(stack, trade) {
  const preflight = await riskSupervisor.evaluate({ dayKey: accountDayKey(Date.now()) });
  liveness.noteEvaluation(preflight);
  if (["FLATTEN", "CUT", "HARVEST_PENDING", "HARVEST_CONFIRMED", "HARVEST_HALTED", "ACCOUNT_DATA_UNAVAILABLE"].includes(preflight.action)) {
    return preflight;
  }
  const result = await stack.runtime.processTrade(trade);
  if (result.status === "RECONCILIATION_BLOCKED") {
    await applyReconciliationBlocked(stack, result);
  } else {
    stack.reconciliationWarning = null;
    await clearNonHarvestHalt(`RECONCILIATION_MISMATCH:${stack.cfg.orderPrefix}`);
  }
  if (["D049_PARTIAL_CUT_UNCONFIRMED", "D049_FULL_FLATTEN_UNCONFIRMED", "D049_BASELINE_MISMATCH"].includes(result.status)) {
    await persistD049SafetyHalt(stack, result);
  } else {
    const day = accountDayKey(Date.now()).replaceAll("-", "");
    for (const code of ["D049_PARTIAL_CUT_UNCONFIRMED", "D049_FULL_FLATTEN_UNCONFIRMED", "D049_BASELINE_MISMATCH"]) {
      await clearNonHarvestHalt(`D049:${stack.cfg.orderPrefix}:${day}:${code}`);
    }
  }
  liveness.noteEvaluation(await riskSupervisor.evaluate({ dayKey: accountDayKey(Date.now()) }));
  await clearNonHarvestHalt(`RUNTIME_ERROR:${stack.cfg.orderPrefix}`);
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
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`${stack.cfg.instrument} runtime error; owner warning cycle requested before a durable safety halt.`);
      console.error(detail);
      if (error instanceof Error && error.stack) console.error(error.stack);
      try {
        await requestNonHarvestHalt({
          key: `RUNTIME_ERROR:${stack.cfg.orderPrefix}`,
          reasonCode: "RUNTIME_ERROR",
          instrument: stack.cfg.instrument,
          // The reason must END with the canonical tail or /rerun cannot clear the
          // halt: isRuntimeErrorHalt() tests endsWith("production runtime error;
          // owner review required"). Putting the detail first keeps it visible in
          // /status while leaving the tail in the position the predicate needs.
          reason: `${stack.cfg.instrument} [${detail.slice(0, 120)}] production runtime error; owner review required`,
          correction: "Inspect /status and Railway logs. If the error clears, the pending warning cycle clears automatically; otherwise send /pausehalt to defer the durable halt."
        });
        await database.addEvent("ERROR", "RUNTIME_ERROR", {
          instrument: stack.cfg.instrument,
          action: "HALT_WARNING_PENDING",
          message: detail.slice(0, 500)
        });
      } catch {
        console.error(`Could not persist the ${stack.cfg.instrument} runtime warning cycle.`);
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
  minimumHoldSeconds: account.minimumHoldSeconds,
  orderCodeEpoch
});

// Every DXtrade session in the process, in one place.
//
// dxtradeClient is the ACCOUNT MONITOR session - the one /status reads.
// stack.quantityClient is the EXECUTION session - the one that places orders,
// and the one the ring execution guard reads positions through.
//
// On 2026-09-19 the execution sessions were rejected with 401 and the monitor
// session was not, so /status reported "risk reads: 5/5 OK" for eighty minutes
// while every protective cut failed silently. Anything claiming to report
// health has to exercise the execution clients specifically.
function allDxtradeSessions() {
  return [
    { name: "account-monitor", client: dxtradeClient },
    ...stacks.map((s) => ({ name: `${s.cfg.instrument} execution`, client: s.quantityClient }))
  ];
}

async function reloginAllSessions() {
  const results = [];
  for (const { name, client } of allDxtradeSessions()) {
    if (typeof client?.forceRelogin !== "function") {
      results.push({ name, ok: false, error: "client does not support forceRelogin" });
      continue;
    }
    try {
      await client.forceRelogin();
      results.push({ name, ok: true });
    } catch (error) {
      results.push({ name, ok: false, error: error?.message ?? "re-login failed" });
    }
  }
  await database.addEvent(
    results.every((r) => r.ok) ? "WARN" : "ERROR",
    "DXTRADE_SESSION_ROTATION",
    { results }
  );
  return results;
}

// Probe the client that actually places orders. A successful read here is the
// only evidence that the protective ladder can execute at all.
async function probeExecutionClient() {
  const stack = stacks[0];
  if (!stack?.quantityClient) return { ok: false, error: "no execution client is configured" };
  try {
    const payload = await stack.quantityClient.getOpenPositions();
    const positions = Array.isArray(payload?.positions) ? payload.positions.length : null;
    const info = stack.quantityClient.getSessionInfo?.() ?? {};
    return { ok: true, positionCount: positions, reauthCount: info.reauthCount ?? 0 };
  } catch (error) {
    return { ok: false, error: error?.message ?? "position read failed" };
  }
}

async function flattenEveryBook() {
  const results = [];
  for (const stack of stacks) {
    try {
      const result = await stack.runtime.executeProtectiveFlatten({
        reason: "owner /flatall",
        dayKey: accountDayKey(Date.now()),
        bypassSlippageCap: true
      });
      results.push({
        instrument: stack.cfg.instrument,
        status: result?.status ?? "UNKNOWN",
        reason: result?.reason ?? null
      });
    } catch (error) {
      results.push({
        instrument: stack.cfg.instrument,
        status: "THREW",
        reason: error?.message ?? "flatten threw"
      });
    }
  }
  await database.addEvent("WARN", "OWNER_FLATTEN_ALL", { results });
  return results;
}

const service = createMultiInstrumentOwnerService({
  // Exposure pool usage and state, directly under "combined exposure" in /status.
  exposurePoolLine: () => formatExposurePoolLine({ gate: exposureGate, readExposure: readAccountExposure }),
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
      (gap === null ? "" : `  unrealised ${money(gap)}`) +
      `  day-open balance ${money(Number(dayOpenBalance))}` +
      `  realised today ${money(Number.isFinite(bal) && Number.isFinite(Number(dayOpenBalance)) ? bal - Number(dayOpenBalance) : NaN)}`;
  },
  instrumentConfigs: enabledInstruments,
  riskSupervisor,
  haltWarnings,
  // Required by /re-run. Without `database` the rerun handlers degrade to
  // "Re-run is not configured on this deployment." and the command does nothing.
  database,
  // A latched runtime error also lives in memory on each stack, so clearing only
  // the Postgres safety_halt would leave the books blocked. Both must clear.
  onRuntimeHaltCleared: () => {
    for (const stack of stacks) stack.runtimeErrorLatched = false;
  },
  reloginAll: reloginAllSessions,
  flattenAll: flattenEveryBook,
  executionHealth: probeExecutionClient,
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
const startupRisk = await riskSupervisor.evaluate({ dayKey: accountDayKey(Date.now()) });
liveness.noteEvaluation(startupRisk);
console.log(`D-064 startup account-day evaluation: ${startupRisk.action}.`);
const startupRecovery = await service.recoverVerifiedD064AtStartup();
console.log(`D-064 verified startup recovery: ${startupRecovery.action}.`);
for (const stack of stacks) stack.feed.start();

// Run once for the account day in which this deployment starts, as requested by
// the owner. If feeds have not become fresh yet it returns WAITING and the minute
// timer retries. On following account days only the 22:03 UTC schedule is eligible.
void runDailyDustCleanup({ immediate: true })
  .then((result) => console.log(`Daily dust cleanup startup check: ${result.action}.`))
  .catch((error) => console.error(`Daily dust cleanup startup check failed: ${error.message}`));

const DAILY_DUST_CLEANUP_CHECK_MS = 60_000;
const dailyDustCleanupTimer = setInterval(() => {
  const immediate = accountDayKey(Date.now()) === startupDustCleanupDayKey;
  void runDailyDustCleanup({ immediate })
    .then((result) => {
      if (!["NOT_DUE", "ALREADY_COMPLETED", "BUSY"].includes(result.action)) {
        console.log(`Daily dust cleanup check: ${result.action}.`);
      }
    })
    .catch((error) => console.error(`Daily dust cleanup check failed: ${error.message}`));
}, DAILY_DUST_CLEANUP_CHECK_MS);
dailyDustCleanupTimer.unref?.();
console.log(`Daily ring dust cleanup armed: deploy-day catch-up, then ${String(dailyDustCleanup.scheduledMinuteUtc).padStart(2, "0")} minutes after the 22:00 UTC account rollover.`);

// Daily DXtrade session rotation.
//
// This is a canary, not the fix - reactive re-auth inside the clients is the
// fix. What the rotation buys is that the credentials get proven at a known
// hour rather than during an incident, and the re-auth path gets exercised on
// a schedule so it cannot rot silently between failures.
//
// 22:15 UTC, deliberately offset from the 22:00 rollover so a session swap is
// never stacked on top of the day-key change, harvest reset and baseline
// re-derivation that all fire at once on the hour.
const SESSION_ROTATION_UTC_HOUR = 22;
const SESSION_ROTATION_UTC_MINUTE = 15;
let lastRotationDayKey = null;

const sessionRotationTimer = setInterval(async () => {
  const nowDate = new Date();
  const pastRotationTime = nowDate.getUTCHours() > SESSION_ROTATION_UTC_HOUR ||
    (nowDate.getUTCHours() === SESSION_ROTATION_UTC_HOUR &&
     nowDate.getUTCMinutes() >= SESSION_ROTATION_UTC_MINUTE);
  if (!pastRotationTime) return;
  const rotationDayKey = accountDayKey(Date.now());
  if (lastRotationDayKey === rotationDayKey) return;
  lastRotationDayKey = rotationDayKey;
  try {
    const results = await reloginAllSessions();
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      // A failed rotation has just manufactured the exact state that closed
      // the funded account, so it is an alert, never a log line.
      console.error(`Daily DXtrade session rotation failed for: ${failed.map((f) => f.name).join(", ")}`);
      liveNotifications.enqueue?.({
        kind: "SESSION_ROTATION_FAILED",
        eventKey: `SESSION-ROT-FAIL:${rotationDayKey}`,
        failed: failed.map((f) => ({ name: f.name, error: f.error }))
      });
    } else {
      console.log(`Daily DXtrade session rotation complete for ${results.length} sessions.`);
    }
  } catch (error) {
    console.error(`Daily DXtrade session rotation threw: ${error?.message ?? "unknown error"}`);
  }
}, 60_000);
sessionRotationTimer.unref?.();
console.log(`Daily DXtrade session rotation armed for ${SESSION_ROTATION_UTC_HOUR}:${String(SESSION_ROTATION_UTC_MINUTE).padStart(2, "0")} UTC.`);

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

// Deadman heartbeat: copy the latest completed-evaluation time to Postgres. The timer
// only writes what the evaluation path recorded, so a hung evaluation still reads as
// stale to the watchdog even though this timer keeps firing.
const LIVENESS_WRITE_MS = 30 * 1000;
const livenessTimer = setInterval(() => void liveness.flush(), LIVENESS_WRITE_MS);
livenessTimer.unref?.();
void liveness.flush();
console.log("Deadman heartbeat: writing bot_liveness every 30s for the external watchdog.");
void heartbeat.checkOnce().catch(() => console.error("Initial heartbeat check failed."));

const HALT_WARNING_CHECK_MS = 30 * 1000;
const haltWarningTimer = setInterval(() => {
  void haltWarnings.advance().catch((error) => console.error(`Owner halt-warning cycle check failed: ${error.message}`));
}, HALT_WARNING_CHECK_MS);
haltWarningTimer.unref?.();
void haltWarnings.advance().catch((error) => console.error(`Initial owner halt-warning cycle check failed: ${error.message}`));

const HYBRID_RECONCILE_MS = 60 * 1000;
const HYBRID_HALT_SIGNATURE = "diverged from the DXtrade book and no manual fill explains it";
let lastHybridHaltReason = null;

async function runHybridReconcileOnce() {
  const books = typeof service.hybridBooks === "function" ? service.hybridBooks() : {};
  if (Object.keys(books).length === 0) {
    console.log("HYBRID: no books expose a hybrid surface; pass skipped.");
    return;
  }

  let orderCount = -1;
  const report = await runReconciliationPass({
    inspectBooks: () => service.inspectBooks(),
    recentOrders: async () => {
      const orders = await service.recentOrderHistory(50);
      orderCount = Array.isArray(orders) ? orders.length : -1;
      return orders;
    },
    // The execution ledger has no bulk listing, so the ledger signal is a no-op
    // here and origin is decided by the order-code prefix and the audit
    // user-agent. Both were present on every bot order observed on this
    // account; an order missing either is UNKNOWN and escalates.
    knownClientOrderIds: async () => new Set(),
    loadWatermarks: () => database.getHybridWatermarks(),
    saveWatermark: (w) => database.saveHybridWatermark(w),
    books,
    absorbEnabled: true
  });

  const verdicts = report.decisions
    .map((d) => `${d.instrument}=${d.verdict}${d.delta ? `(${d.delta})` : ""}`)
    .join(" ");
  console.log(`HYBRID: books=${Object.keys(books).length} orders=${orderCount} ${verdicts} severity=${report.severity}`);
  for (const d of report.decisions) {
    if (d.reason) console.log(`HYBRID:   ${d.instrument} ${d.verdict}: ${d.reason}`);
  }
  for (const outcome of report.absorbed) {
    console.log(`HYBRID:   ${outcome.instrument} absorb ${outcome.result}${outcome.reason ? `: ${outcome.reason}` : ""}`);
  }

  for (const outcome of report.absorbed) {
    if (outcome.result !== "APPLIED") continue;
    await database.addEvent("WARN", "HYBRID_MANUAL_ACTIVITY_ABSORBED", {
      instrument: outcome.instrument,
      applied: outcome.applied,
      watermark: outcome.watermark
    });
  }

  if (report.escalations.length === 0) {
    await clearNonHarvestHalt("hybrid-reconciliation");
    // Clearing the pending warning cycle is not enough once it has converted to
    // a durable safety halt. Match on the stored reason rather than an in-memory
    // variable: a restart wipes the variable, and a halt that only this pass can
    // recognise would otherwise survive with no command able to release it.
    if (typeof database.clearSafetyHaltIfReason === "function") {
      try {
        const current = await database.getState();
        const reason = typeof current?.halt_reason === "string" ? current.halt_reason : null;
        if (current?.safety_halt === true && reason && reason.includes(HYBRID_HALT_SIGNATURE)) {
          const cleared = await database.clearSafetyHaltIfReason(reason);
          if (cleared) console.log("HYBRID: every book agrees; cleared the hybrid safety halt.");
          else console.warn("HYBRID: hybrid safety halt changed before it could be cleared; will retry next pass.");
        }
      } catch (error) {
        console.error(`HYBRID: could not clear the hybrid safety halt: ${error.message}`);
      }
    }
    lastHybridHaltReason = null;
    return;
  }

  const first = report.escalations[0];
  const names = report.escalations.map((e) => e.instrument).join(", ");
  // The suffix matters: /rerun only clears halts whose reason ends with the
  // runtime-error tail. Without it this halt would have no release path.
  const haltReason = report.accountWide
    ? `${names} diverged from the DXtrade book at the same time and no manual fill explains it; production runtime error; owner review required`
    : `${first.instrument} diverged from the DXtrade book and no manual fill explains it: ${first.reason}; production runtime error; owner review required`;
  lastHybridHaltReason = haltReason;
  await database.addEvent("ERROR", "HYBRID_UNEXPLAINED_NET", {
    escalations: report.escalations,
    accountWide: report.accountWide
  });
  await requestNonHarvestHalt({
    key: "hybrid-reconciliation",
    reasonCode: "HYBRID_UNEXPLAINED_NET",
    reason: haltReason,
    instrument: report.accountWide ? null : first.instrument,
    correction: "Inspect /status and /rawhistory, then reconcile in DXtrade. /pausehalt defers this for a fresh 25-minute warning cycle, and /rerun clears it once every book matches."
  });
}

const hybridTimer = setInterval(() => {
  void runHybridReconcileOnce().catch((error) => console.error(`Hybrid reconciliation pass failed: ${error.message}`));
}, HYBRID_RECONCILE_MS);
hybridTimer.unref?.();
void runHybridReconcileOnce().catch((error) => console.error(`Initial hybrid reconciliation pass failed: ${error.message}`));

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
  clearInterval(livenessTimer);
  clearInterval(haltWarningTimer);
  clearInterval(dailyDustCleanupTimer);
  telegramBot.stopDevCompanionDelivery?.();
  for (const stack of stacks) stack.feed.stop();
  accountMonitor.stop();
  clearInterval(sessionRotationTimer);
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
    await Promise.allSettled([database.close(), persistence.close(), devCompanion.close(), livenessStore.close()]);
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
