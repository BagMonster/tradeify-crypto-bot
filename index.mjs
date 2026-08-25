import { loadConfiguration } from "./src/config.js";
import { createDatabase } from "./src/database.js";
import { createDevCompanionStore } from "./src/devCompanionStore.js";
import { createBinanceLiveFeed } from "./src/market/binanceLiveFeed.js";
import { createBinanceDailyMaProvider } from "./src/market/binanceDailyMa.js";
import { DxtradeExecutionClient } from "./src/execution/dxtradeExecutionClient.js";
import { createPinnedDxtradeFetch } from "./src/execution/pinnedDxtradeFetch.js";
import { SolanaQuantityClient } from "./src/execution/solanaQuantityClient.js";
import { createSolanaQuantityAdapter } from "./src/execution/solanaQuantityAdapter.js";
import { createSolanaExecutionGuard } from "./src/execution/solanaExecutionGuard.js";
import { createSolanaLiveCanary } from "./src/execution/solanaCanary.js";
import { createDxtradeAccountMonitor } from "./src/account/dxtradeAccountMonitor.js";
import { formatDxtradeAccountDiagnostic } from "./src/account/dxtradeDiagnostics.js";
import { createSolanaPersistence } from "./src/state/solanaPersistence.js";
import { createSolanaRuntime } from "./src/runtime/solanaRuntime.js";
import { createSolanaHeartbeat } from "./src/runtime/solanaHeartbeat.js";
import { createLiveTelegramNotifications } from "./src/notifications/liveTelegramNotifications.js";
import { accountDayKey } from "./src/risk/dailyRiskLadder.js";
import { GRID_DEFINITION } from "./src/strategies/solanaGrid.js";
import { createSolanaTradeifyService } from "./src/solanaTradeifyService.js";
import { startTelegramBot } from "./src/telegramBot.js";

const configuration = await loadConfiguration();
const { account, strategy, environment, instrument } = configuration;

if (instrument.asset !== "SOL" || instrument.dxtradeSymbol !== "SOL/USD" || instrument.binanceSymbol !== "SOLUSDT") {
  throw new Error("The active production worker is frozen for SOL/USD with Binance SOLUSDT");
}
if (strategy.strategyId !== GRID_DEFINITION.strategyId) {
  throw new Error(`strategy.strategyId must equal ${GRID_DEFINITION.strategyId}`);
}
if (typeof strategy.strategyStatus === "string" && strategy.strategyStatus.startsWith("pending-")) {
  throw new Error("The SOL strategy may not start while strategyStatus is pending");
}

const database = createDatabase(environment);
await database.init(account);

const devCompanion = createDevCompanionStore({
  databaseUrl: environment.databaseUrl,
  databaseSsl: environment.databaseSsl
});
await devCompanion.init();

const solPersistence = createSolanaPersistence(environment);
await solPersistence.init();

const liveNotifications = createLiveTelegramNotifications({
  persistence: solPersistence,
  addEvent: database.addEvent
});

const maProvider = createBinanceDailyMaProvider({ marketSymbol: instrument.binanceSymbol, days: 200 });
await maProvider.refresh();

const dxtradeClient = new DxtradeExecutionClient({
  restBaseUrl: environment.dxtrade.restBaseUrl,
  username: environment.dxtrade.username,
  domain: environment.dxtrade.domain,
  password: environment.dxtrade.password,
  accountCode: environment.dxtrade.accountCode,
  instrument: instrument.dxtradeSymbol,
  fetchImpl: createPinnedDxtradeFetch()
});

const solanaQuantityClient = new SolanaQuantityClient({
  restBaseUrl: environment.dxtrade.restBaseUrl,
  username: environment.dxtrade.username,
  domain: environment.dxtrade.domain,
  password: environment.dxtrade.password,
  accountCode: environment.dxtrade.accountCode,
  instrument: instrument.dxtradeSymbol,
  fetchImpl: createPinnedDxtradeFetch()
});

const solanaQuantityAdapter = createSolanaQuantityAdapter({
  client: solanaQuantityClient,
  persistence: solPersistence
});

const solanaExecution = createSolanaExecutionGuard({
  autoExecute: environment.autoExecute,
  strategyAutoExecute: strategy.execution.autoExecute,
  adapter: solanaQuantityAdapter,
  client: solanaQuantityClient,
  persistence: solPersistence,
  protectiveOrdersBypassSlippageCap: strategy.riskLadder.protectiveOrdersBypassSlippageCap,
  addEvent: database.addEvent
});

const liveCanary = createSolanaLiveCanary({
  adapter: solanaQuantityAdapter,
  client: solanaQuantityClient,
  persistence: solPersistence,
  addEvent: database.addEvent,
  automaticExecutionEnabled: solanaExecution.isEnabled,
  minimumHoldSeconds: account.minimumHoldSeconds
});

function accountLockReasonCode(invariantError) {
  if (typeof invariantError !== "string") return null;
  if (invariantError.startsWith("A non-SOL/USD position exists")) return "FOREIGN_POSITION";
  if (invariantError === "More than one open position exists on the Tradeify account") return "MULTIPLE_POSITIONS";
  if (invariantError === "DXtrade open-position count does not match position metrics") return "POSITION_COUNT_MISMATCH";
  return null;
}

let accountErrorLogged = false;
let accountLockLatched = false;
const accountMonitor = createDxtradeAccountMonitor({
  client: dxtradeClient,
  startingBalance: account.startingBalance,
  instrument: instrument.dxtradeSymbol,
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
            eventKey: `SOL-ACCOUNT-LOCK:${day}:${reasonCode}`,
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
      console.error(`DXtrade account state is unavailable; new SOL actions remain blocked. ${formatDxtradeAccountDiagnostic(error)}`);
    }
  }
});

let liveFeedState = Object.freeze({
  running: false,
  connected: false,
  stale: true,
  lastTradeAt: null,
  lastTradeId: null,
  reconnectAttempt: 0
});
let lastLiveTrade = null;
let persistedFeedStale = true;
let runtimeErrorLatched = false;
let reconciliationHaltLatched = false;
const d049HaltNotifications = new Set();

const solanaRuntime = createSolanaRuntime({
  stateStore: solPersistence.state,
  riskLadderStore: solPersistence,
  riskLadderConfig: strategy.riskLadder,
  maProvider,
  minimumHoldSeconds: account.minimumHoldSeconds,
  execution: solanaExecution,
  addEvent: database.addEvent,
  notifications: liveNotifications,
  getRiskSnapshot: async () => {
    const [botState, accountStatus] = await Promise.all([
      database.getState(),
      Promise.resolve(accountMonitor.getSnapshot())
    ]);
    const snapshot = accountStatus.snapshot;
    return Object.freeze({
      startingBalance: account.startingBalance,
      maxLossOffset: account.maxLossOffset,
      peakClosedBalance: snapshot?.peakClosedBalance ?? botState.high_water,
      payoutTaken: botState.payout_taken,
      previousDayClosingBalance: snapshot?.previousDayClosingBalance ?? botState.prev_day_close,
      dailyLossLimit: account.dailyLossLimit,
      liveEquity: snapshot?.equity ?? botState.equity,
      currentNotional: snapshot?.currentNotional ?? 0,
      maxNotional: account.maxNotional,
      operatorPaused: botState.operator_killed,
      safetyHalt: botState.safety_halt,
      accountLocked: snapshot?.accountLocked ?? true,
      feedHealthy: liveFeedState.connected === true && liveFeedState.stale === false,
      accountDataFresh: accountStatus.fresh === true,
      nettingConfirmed: true,
      brokerNetUnits: snapshot?.instrumentPosition?.quantity ?? 0
    });
  }
});
await solanaRuntime.init();

let pendingTrade = null;
let drainingTrades = false;
let maintenanceBusy = false;

async function persistD049SafetyHalt(result) {
  const code = result.status;
  const reasonCode = code === "D049_PARTIAL_CUT_UNCONFIRMED"
    ? "D049_PARTIAL_CUT_UNCONFIRMED"
    : code === "D049_FULL_FLATTEN_UNCONFIRMED"
      ? "D049_FULL_FLATTEN_UNCONFIRMED"
      : code === "D049_BASELINE_MISMATCH"
        ? "D049_BASELINE_MISMATCH"
        : null;
  if (!reasonCode) return;

  const reason = reasonCode === "D049_PARTIAL_CUT_UNCONFIRMED"
    ? "D-049 protective partial cut did not confirm; owner review required"
    : reasonCode === "D049_FULL_FLATTEN_UNCONFIRMED"
      ? "D-049 protective full flatten did not confirm flat; manual intervention required"
      : "D-049 persisted daily baseline does not match fresh DXtrade account data; owner review required";

  await database.setSafetyHalt(reason);
  await database.addEvent("ERROR", "SOL_D049_SAFETY_HALT", { reasonCode, status: code });
  const day = accountDayKey(Date.now()).replaceAll("-", "");
  const eventKey = `SOL-D049-HALT:${day}:${reasonCode}`;
  if (!d049HaltNotifications.has(eventKey)) {
    d049HaltNotifications.add(eventKey);
    liveNotifications.enqueue({ kind: "SAFETY_HALT", eventKey, reasonCode });
  }
}

async function processLatestTrade(trade) {
  const result = await solanaRuntime.processTrade(trade);
  if (result.status === "RECONCILIATION_BLOCKED" && !reconciliationHaltLatched) {
    reconciliationHaltLatched = true;
    await database.setSafetyHalt("SOL virtual-lot state does not reconcile to the DXtrade net SOL position; owner review required");
    await database.addEvent("ERROR", "SOL_RECONCILIATION_SAFETY_HALT", { action: "SAFETY_HALT" });
    const recon = result.reconciliation;
    if (recon && Number.isFinite(recon.actual)) {
      liveNotifications.enqueue({
        kind: "RECONCILIATION_MISMATCH",
        eventKey: `SOL-RECON:${result.state.version}:${Number(recon.expected).toFixed(8)}:${Number(recon.actual).toFixed(8)}`,
        stateVersion: result.state.version,
        expectedVirtualNetUnits: recon.expected,
        brokerNetUnits: recon.actual
      });
    }
  }
  if (new Set(["D049_PARTIAL_CUT_UNCONFIRMED", "D049_FULL_FLATTEN_UNCONFIRMED", "D049_BASELINE_MISMATCH"]).has(result.status)) {
    await persistD049SafetyHalt(result);
  }
}

async function drainLatestTrades() {
  if (drainingTrades || maintenanceBusy) return;
  drainingTrades = true;
  try {
    while (pendingTrade && !maintenanceBusy) {
      const trade = pendingTrade;
      pendingTrade = null;
      await processLatestTrade(trade);
    }
  } catch {
    if (!runtimeErrorLatched) {
      runtimeErrorLatched = true;
      console.error("SOL production runtime error; new strategy actions are being halted.");
      try {
        await database.setSafetyHalt("SOL production runtime error; owner review required");
        await database.addEvent("ERROR", "SOL_RUNTIME_ERROR", { action: "SAFETY_HALT" });
        const hour = new Date().toISOString().slice(0, 13).replaceAll("-", "").replace("T", "-");
        liveNotifications.enqueue({
          kind: "SAFETY_HALT",
          eventKey: `SOL-RUNTIME-HALT:${hour}`,
          reasonCode: "SOL_RUNTIME_ERROR"
        });
      } catch {
        console.error("Could not persist the SOL runtime safety halt.");
      }
    }
  } finally {
    drainingTrades = false;
    if (pendingTrade && !runtimeErrorLatched && !maintenanceBusy) void drainLatestTrades();
  }
}

const heartbeat = createSolanaHeartbeat({
  persistence: solPersistence,
  adapter: solanaQuantityAdapter,
  isExecutionEnabled: solanaExecution.isEnabled,
  isRiskLadderHalted: async () => {
    const ladder = solanaRuntime.getRiskLadderState();
    return ladder?.haltedForDay === true && ladder.dayKey === accountDayKey(Date.now());
  },
  triggerDays: strategy.solOuterHeavy.heartbeatDays,
  acquireMaintenance: async () => {
    if (maintenanceBusy || drainingTrades) return false;
    maintenanceBusy = true;
    return true;
  },
  releaseMaintenance: async () => {
    maintenanceBusy = false;
    if (pendingTrade && !runtimeErrorLatched) void drainLatestTrades();
  },
  addEvent: database.addEvent,
  notifications: liveNotifications
});

const binanceFeed = createBinanceLiveFeed({
  symbol: instrument.binanceSymbol,
  onPrice: (trade) => {
    lastLiveTrade = trade;
    pendingTrade = trade;
    if (!drainingTrades && !maintenanceBusy && !runtimeErrorLatched) void drainLatestTrades();
  },
  onState: (state) => {
    liveFeedState = state;
    const stale = state.connected !== true || state.stale === true;
    if (stale !== persistedFeedStale) {
      persistedFeedStale = stale;
      void database.setFeedStale(stale).catch(() => console.error("Could not persist Binance feed-health state."));
    }
  },
  onError: () => {
    console.error(`Binance ${instrument.binanceSymbol} live-feed message was rejected; feed freshness controls remain active.`);
  }
});

const service = createSolanaTradeifyService({
  database,
  account,
  strategy,
  environment,
  dxtradeClient,
  persistence: solPersistence,
  maProvider,
  execution: solanaExecution,
  canary: liveCanary,
  getLiveMarketSnapshot: () => Object.freeze({
    price: lastLiveTrade?.price ?? null,
    tradeTime: lastLiveTrade?.tradeTime ?? null,
    stale: liveFeedState.connected !== true || liveFeedState.stale === true
  })
});

const telegramBot = await startTelegramBot({
  environment,
  service,
  notifications: liveNotifications,
  devCompanion
});

// Start live inputs only after the owner notification destination is ready.
await accountMonitor.start();
binanceFeed.start();

const HEARTBEAT_CHECK_MS = 60 * 60 * 1000;
const heartbeatTimer = setInterval(() => {
  void heartbeat.checkOnce().catch(async () => {
    console.error("SOL inactivity heartbeat check failed; owner review may be required before the inactivity deadline.");
    try {
      await database.addEvent("ERROR", "SOL_HEARTBEAT_CHECK_FAILED", { action: "REVIEW" });
    } catch {
      console.error("Could not persist heartbeat failure event.");
    }
  });
}, HEARTBEAT_CHECK_MS);
heartbeatTimer.unref?.();
void heartbeat.checkOnce().catch(() => console.error("Initial SOL heartbeat check failed."));

const executionLive = solanaExecution.isEnabled();
console.log(executionLive
  ? "Production SOL outer-heavy runtime started with automatic execution LIVE."
  : "Production SOL outer-heavy runtime started ARMED with automatic execution still blocked by the Railway control.");
console.log("Market source: Binance SOLUSDT. Account source: DXtrade SOL/USD.");
console.log("D-049 geometry: 10 rings per side from ±13.5% through ±54%, $6,600 gross virtual-exposure ceiling.");
console.log("D-049 daily risk ladder: entry brake -$300, 50% cut -$1,000, full flatten -$1,250.");
console.log("Live-touch semantics: exits before entries.");
console.log("Owner Telegram broker-confirmed trade and safety notifications: armed.");
console.log("Owner Telegram OpenAI development mode: queue bridge armed; companion processing runs in the separate Railway worker.");
if (executionLive) {
  console.log("Owner-triggered lifecycle canary is disabled while automatic grid execution is ON.");
} else {
  console.log("Owner-triggered 0.01 SOL lifecycle canary remains available while automatic execution is OFF.");
}
console.log(`${strategy.solOuterHeavy.heartbeatDays}-day inactivity heartbeat: armed for 0.01 SOL round trips after live activation.`);
console.log(`Automatic execution: ${executionLive ? "ON" : "OFF"} (Railway=${environment.autoExecute ? "ON" : "OFF"}, strategy=${strategy.execution.autoExecute ? "ON" : "OFF"}, mode=${environment.appMode}).`);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down cleanly.`);
  clearInterval(heartbeatTimer);
  telegramBot.stopDevCompanionDelivery?.();
  binanceFeed.stop();
  accountMonitor.stop();
  try {
    await telegramBot.stopPolling();
  } finally {
    try { await liveNotifications.drain(); } catch { console.error("Telegram notification queue did not drain cleanly."); }
    try { await dxtradeClient.logout(); } catch { console.error("DXtrade account-monitor logout did not complete cleanly."); }
    try { await solanaQuantityClient.logout(); } catch { console.error("DXtrade SOL execution logout did not complete cleanly."); }
    await Promise.allSettled([database.close(), solPersistence.close(), devCompanion.close()]);
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
