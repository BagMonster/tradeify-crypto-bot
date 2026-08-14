import { loadConfiguration } from "./src/config.js";
import { createDatabase } from "./src/database.js";
import { backfillBinanceHistory } from "./src/binanceBackfill.js";
import { createTradeifyService } from "./src/tradeifyService.js";
import { startTelegramBot } from "./src/telegramBot.js";

const configuration = await loadConfiguration();
const database = createDatabase(configuration.environment);
await database.init(configuration.account);

try {
  const backfill = await backfillBinanceHistory({ database });
  const counts = backfill.timeframes
    .map(({ timeframe, expectedCount }) => `${timeframe}=${expectedCount}`)
    .join(", ");
  console.log(`Binance BTCUSDT historical coverage ready (${counts}).`);
} catch (error) {
  console.error(`Binance historical backfill is not ready: ${error.message}`);
  console.error("Signals and execution remain blocked; the Stage A worker will continue safely.");
}

const service = createTradeifyService({
  database,
  account: configuration.account,
  strategy: configuration.strategy,
  environment: configuration.environment
});

const telegramBot = await startTelegramBot({
  environment: configuration.environment,
  service
});

console.log("Tradeify worker started in Stage A simulation mode.");
console.log("Auto-execution is locked OFF.");

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down cleanly.`);
  try {
    await telegramBot.stopPolling();
  } finally {
    await database.close();
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
