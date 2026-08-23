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
const { account, strategy, environment, instrument } = configuration;
const strategyPending = typeof strategy.strategyStatus === "string" && strategy.strategyStatus.startsWith("pending-");
const strategyId = typeof strategy.strategyId === "string" && strategy.strategyId.trim()
  ? strategy.strategyId.trim()
  : strategyPending
    ? strategy.strategyStatus
    : null;
if (!strategyId) throw new Error("strategy.strategyId is required before a production strategy can run");

const database = createDatabase(environment);
await database.init(account);
database.gridState.setIdentity({ strategyId, instrument: instrument.dxtradeSymbol });

const dxtradeClient = new DxtradeExecutionClient({
  restBaseUrl: environment.dxtrade.restBaseUrl,
  username: environment.dxtrade.username,
  domain: environment.dxtrade.domain,
  password: environment.dxtrade.password,
  accountCode: environment.dxtrade.accountCode,
  instrument: instrument.dxtradeSymbol,
  fetchImpl: createPinnedDxtradeFetch()
});

const dxtradeOrderAdapter = createDxtradeOrderAdapter({
  client: dxtradeClient,
  ledger: database.executionLedger,
  instrument: instrument.dxtradeSymbol
});

const guardedExecution = createGuardedExecution({
  autoExecute: environment.autoExecute,
  strategyAutoExecute: strategy.execution.autoExecute,
  instrument: instrument.dxtradeSymbol,
  marketSymbol: instrument.binanceSymbol,
  orderCodePrefix: `${instrument.asset}GRID`,
  placeMarketOrder: dxtradeOrderAdapter.placeMarketOrder,
  // The strategy transition remains locked. A broker-verified automatic
  // protective flatten is still required before any later canary/live approval.
  flattenPosition: async () => {
    throw new Error("Automatic protective flatten is not enabled in the locked production build");
  },
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

async function loadActiveGridStrategy() {
  if (strategyPending) return null;
  const module = instrument.asset === "BTC"
    ? await import("./src/strategies/grid.js")
    : await import("./src/strategies/solanaGrid.js");
  const definition = module.GRID_DEFINITION ?? module.FROZEN_GRID;
  if (!definition || definition.strategyId !== strategyId) {
    throw new Error("active grid strategy definition does not match strategy.strategyId");
  }
  for (const name of [
    "createInitialGridState",
    "evaluateGridIntent",
    "applyConfirmedGridFill",
    "resetGridAfterProtectiveFlatten"
  ]) {
    if (typeof module[name] !== "function") throw new Error(`active grid strategy is missing ${name}`);
  }
  return Object.freeze({ module, definition });
}

const activeGrid = await loadActiveGridStrategy();
const gridRuntime = activeGrid ? createGridRuntime({
  stateStore: database.gridState,
  marketSymbol: instrument.binanceSymbol,
  gridStrategy: activeGrid.module,
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
      nettingConfirmed: true
    });
  }
}) : null;

let pendingTrade = null;
let drainingTrades = false;
let existingPositionHaltLatched = false;

async function processLatestTrade(trade) {
  if (!gridRuntime) return;
  const existingGridState = await database.gridState.load();
  if (!existingGridState) {
    const accountStatus = accountMonitor.getSnapshot();
    if (!accountStatus.healthy || !accountStatus.snapshot) return;

    if (accountStatus.snapshot.instrumentPosition) {
      if (!existingPositionHaltLatched) {
        existingPositionHaltLatched = true;
        await database.setSafetyHalt(
          `${instrument.dxtradeSymbol} position existed before the production grid reference was initialized; owner reconciliation required`
        );
        await database.addEvent("ERROR", "GRID_INITIALIZATION_BLOCKED_EXISTING_POSITION", {
          symbol: instrument.dxtradeSymbol
        });
      }
      return;
    }

    const initialized = await gridRuntime.initialize(trade.price);
    await database.addEvent("INFO", "GRID_REFERENCE_ANCHORED_FROM_BINANCE", {
      source: trade.source,
      symbol: trade.symbol,
      instrument: instrument.dxtradeSymbol,
      strategyId,
      referencePrice: initialized.referencePrice,
      stateVersion: initialized.version,
      tradeTime: trade.tradeTime
    });
    return;
  }

  await gridRuntime.processTrade(trade);
}

async function drainLatestTrades() {
  if (drainingTrades || !gridRuntime) return;
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
        await database.addEvent("ERROR", "GRID_RUNTIME_ERROR", { action: "SAFETY_HALT", strategyId });
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
  symbol: instrument.binanceSymbol,
  onPrice: (trade) => {
    if (!gridRuntime) return;
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
    console.error(`Binance ${instrument.binanceSymbol} live-feed message was rejected; feed freshness controls remain active.`);
  }
});

await accountMonitor.start();
binanceFeed.start();

const service = createTradeifyService({
  database,
  account,
  strategy,
  environment,
  dxtradeClient,
  gridDefinition: activeGrid?.definition
});

const telegramBot = await startTelegramBot({
  environment,
  service
});

if (strategyPending) {
  console.log(`${instrument.asset} transition worker started in locked Stage A mode; strategy is pending.`);
} else {
  console.log(`Production ${instrument.asset} grid runtime started in locked Stage A mode.`);
}
console.log(`Market source: Binance ${instrument.binanceSymbol}. Account source: DXtrade ${instrument.dxtradeSymbol}.`);
console.log("Automatic execution remains OFF; both execution settings remain false.");

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
