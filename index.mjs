import { loadConfiguration } from "./src/config.js";
import { createDatabase } from "./src/database.js";
import { createBinanceLiveFeed } from "./src/market/binanceLiveFeed.js";
import { DxtradeExecutionClient } from "./src/execution/dxtradeExecutionClient.js";
import { createPinnedDxtradeFetch } from "./src/execution/pinnedDxtradeFetch.js";
import { createDxtradeOrderAdapter } from "./src/execution/dxtradeOrderAdapter.js";
import { createGuardedExecution } from "./src/execution/orderGuard.js";
import { createDxtradeAccountMonitor } from "./src/account/dxtradeAccountMonitor.js";
import { formatDxtradeAccountDiagnostic } from "./src/account/dxtradeDiagnostics.js";
import { createGridRuntime } from "./src/runtime/gridRuntime.js";
import { createTradeifyService } from "./src/tradeifyService.js";
import { startTelegramBot } from "./src/telegramBot.js";

const configuration = await loadConfiguration();
const { account, strategy, environment } = configuration;
const database = createDatabase(environment);
await database.init(account);

const dxtradeClient = new DxtradeExecutionClient({
  restBaseUrl: environment.dxtrade.restBaseUrl,
  username: environment.dxtrade.username,
  domain: environment.dxtrade.domain,
  password: environment.dxtrade.password,
  accountCode: environment.dxtrade.accountCode,
  fetchImpl: createPinnedDxtradeFetch()
});

const dxtradeOrderAdapter = createDxtradeOrderAdapter({
  client: dxtradeClient,
  ledger: database.executionLedger
});

const guardedExecution = createGuardedExecution({
  autoExecute: environment.autoExecute,
  strategyAutoExecute: strategy.execution.autoExecute,
  placeMarketOrder: dxtradeOrderAdapter.placeMarketOrder,
  // D-038 permits building the write path now, but this deployment remains
  // impossible to activate because config.js rejects either execution lock.
  // A broker-verified automatic protective flatten is added before canary/live approval.
  flattenPosition: async () => {
    throw new Error("Automatic protective flatten is not enabled in the locked production build");
  },
  addEvent: database.addEvent
});

let accountErrorLogged = false;
const accountMonitor = createDxtradeAccountMonitor({
  client: dxtradeClient,
  startingBalance: account.startingBalance,
  getPersistedPeakClosedBalance: database.getPersistedPeakClosedBalance,
  onSnapshot: async (snapshot) => {
    accountErrorLogged = false;
    await database.syncAccountSnapshot(snapshot, account);
  },
  onError: (error) => {
    if (!accountErrorLogged) {
      accountErrorLogged = true;
      console.error(
        `DXtrade account state is unavailable; new grid actions remain blocked. ${formatDxtradeAccountDiagnostic(error)}`
      );
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

const gridRuntime = createGridRuntime({
  stateStore: database.gridState,
  minimumHoldSeconds: account.minimumHoldSeconds,
  execution: guardedExecution,
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
      // Netting mode was owner-verified before the production-grid build.
      nettingConfirmed: true
    });
  }
});

let pendingTrade = null;
let drainingTrades = false;
let existingPositionHaltLatched = false;

async function processLatestTrade(trade) {
  const existingGridState = await database.gridState.load();
  if (!existingGridState) {
    const accountStatus = accountMonitor.getSnapshot();
    if (!accountStatus.healthy || !accountStatus.snapshot) return;

    if (accountStatus.snapshot.btcPosition) {
      if (!existingPositionHaltLatched) {
        existingPositionHaltLatched = true;
        await database.setSafetyHalt(
          "BTC position existed before the production grid reference was initialized; owner reconciliation required"
        );
        await database.addEvent("ERROR", "GRID_INITIALIZATION_BLOCKED_EXISTING_POSITION", {
          symbol: "BTC/USD"
        });
      }
      return;
    }

    const initialized = await gridRuntime.initialize(trade.price);
    await database.addEvent("INFO", "GRID_REFERENCE_ANCHORED_FROM_BINANCE", {
      source: trade.source,
      symbol: trade.symbol,
      referencePrice: initialized.referencePrice,
      stateVersion: initialized.version,
      tradeTime: trade.tradeTime
    });
    return;
  }

  await gridRuntime.processTrade(trade);
}

async function drainLatestTrades() {
  if (drainingTrades) return;
  drainingTrades = true;
  try {
    while (pendingTrade) {
      const trade = pendingTrade;
      pendingTrade = null;
      await processLatestTrade(trade);
    }
  } catch {
    if (!runtimeErrorLatched) {
      runtimeErrorLatched = true;
      console.error("Production grid runtime error; new grid actions are being halted.");
      try {
        await database.setSafetyHalt("Production grid runtime error; owner review required");
        await database.addEvent("ERROR", "GRID_RUNTIME_ERROR", { action: "SAFETY_HALT" });
      } catch {
        console.error("Could not persist the production grid safety halt.");
      }
    }
  } finally {
    drainingTrades = false;
    if (pendingTrade && !runtimeErrorLatched) void drainLatestTrades();
  }
}

const binanceFeed = createBinanceLiveFeed({
  onPrice: (trade) => {
    pendingTrade = trade;
    if (!drainingTrades && !runtimeErrorLatched) void drainLatestTrades();
  },
  onState: (state) => {
    liveFeedState = state;
    const stale = state.connected !== true || state.stale === true;
    if (stale !== persistedFeedStale) {
      persistedFeedStale = stale;
      void database.setFeedStale(stale).catch(() => {
        console.error("Could not persist Binance feed-health state.");
      });
    }
  },
  onError: () => {
    // Detailed remote payloads are intentionally not logged here.
    console.error("Binance BTCUSDT live-feed message was rejected; feed freshness controls remain active.");
  }
});

await accountMonitor.start();
binanceFeed.start();

const service = createTradeifyService({
  database,
  account,
  strategy,
  environment
});

const telegramBot = await startTelegramBot({
  environment,
  service
});

console.log("Production BTC grid runtime started in locked Stage A mode.");
console.log("Market source: Binance BTCUSDT. Account source: DXtrade.");
console.log("Auto-execution is locked OFF by both configuration gates.");

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down cleanly.`);
  binanceFeed.stop();
  accountMonitor.stop();
  try {
    await telegramBot.stopPolling();
  } finally {
    try {
      await dxtradeClient.logout();
    } catch {
      console.error("DXtrade logout did not complete cleanly.");
    }
    await database.close();
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
