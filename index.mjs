import { loadConfiguration } from "./src/config.js";
import { createDatabase } from "./src/database.js";
import { createBinanceLiveFeed } from "./src/market/binanceLiveFeed.js";
import { createBinanceDailyMaProvider } from "./src/market/binanceDailyMa.js";
import { DxtradeExecutionClient } from "./src/execution/dxtradeExecutionClient.js";
import { createPinnedDxtradeFetch } from "./src/execution/pinnedDxtradeFetch.js";
import { SolanaQuantityClient } from "./src/execution/solanaQuantityClient.js";
import { createSolanaQuantityAdapter } from "./src/execution/solanaQuantityAdapter.js";
import { createSolanaExecutionGuard } from "./src/execution/solanaExecutionGuard.js";
import { createDxtradeAccountMonitor } from "./src/account/dxtradeAccountMonitor.js";
import { formatDxtradeAccountDiagnostic } from "./src/account/dxtradeDiagnostics.js";
import { createSolanaPersistence } from "./src/state/solanaPersistence.js";
import { createSolanaRuntime } from "./src/runtime/solanaRuntime.js";
import { createSolanaHeartbeat } from "./src/runtime/solanaHeartbeat.js";
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

const solPersistence = createSolanaPersistence(environment);
await solPersistence.init();

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
  addEvent: database.addEvent
});

let accountErrorLogged = false;
const accountMonitor = createDxtradeAccountMonitor({
  client: dxtradeClient,
  startingBalance: account.startingBalance,
  instrument: instrument.dxtradeSymbol,
  getPersistedPeakClosedBalance: database.getPersistedPeakClosedBalance,
  onSnapshot: async (snapshot) => {
    accountErrorLogged = false;
    await database.syncAccountSnapshot(snapshot, account);
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
let persistedFeedStale = true;
let runtimeErrorLatched = false;
let reconciliationHaltLatched = false;

const solanaRuntime = createSolanaRuntime({
  stateStore: solPersistence.state,
  maProvider,
  minimumHoldSeconds: account.minimumHoldSeconds,
  execution: solanaExecution,
  addEvent: database.addEvent,
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

async function processLatestTrade(trade) {
  const result = await solanaRuntime.processTrade(trade);
  if (result.status === "RECONCILIATION_BLOCKED" && !reconciliationHaltLatched) {
    reconciliationHaltLatched = true;
    await database.setSafetyHalt("SOL virtual-lot state does not reconcile to the DXtrade net SOL position; owner review required");
    await database.addEvent("ERROR", "SOL_RECONCILIATION_SAFETY_HALT", { action: "SAFETY_HALT" });
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
  acquireMaintenance: async () => {
    if (maintenanceBusy || drainingTrades) return false;
    maintenanceBusy = true;
    return true;
  },
  releaseMaintenance: async () => {
    maintenanceBusy = false;
    if (pendingTrade && !runtimeErrorLatched) void drainLatestTrades();
  },
  addEvent: database.addEvent
});

const binanceFeed = createBinanceLiveFeed({
  symbol: instrument.binanceSymbol,
  onPrice: (trade) => {
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

const service = createSolanaTradeifyService({
  database,
  account,
  strategy,
  environment,
  dxtradeClient,
  persistence: solPersistence,
  maProvider,
  execution: solanaExecution
});

const telegramBot = await startTelegramBot({ environment, service });

console.log("Production SOL outer-heavy runtime started in locked Stage A mode.");
console.log("Market source: Binance SOLUSDT. Account source: DXtrade SOL/USD.");
console.log("Live-touch semantics: exits before entries.");
console.log("25-day inactivity heartbeat: armed for 0.01 SOL round trips after live activation.");
console.log("Automatic execution remains OFF; both execution settings remain false.");

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down cleanly.`);
  clearInterval(heartbeatTimer);
  binanceFeed.stop();
  accountMonitor.stop();
  try {
    await telegramBot.stopPolling();
  } finally {
    try { await dxtradeClient.logout(); } catch { console.error("DXtrade account-monitor logout did not complete cleanly."); }
    try { await solanaQuantityClient.logout(); } catch { console.error("DXtrade SOL execution logout did not complete cleanly."); }
    await Promise.allSettled([database.close(), solPersistence.close()]);
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
