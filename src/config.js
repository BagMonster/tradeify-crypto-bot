import "dotenv/config";
import { readFile } from "node:fs/promises";

function requireText(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function parseBoolean(name, value, defaultValue) {
  if (value === undefined || value === "") return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function requirePositive(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
}

function requireNumber(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function loadAccountConfig(path = "config/account.json") {
  const account = await readJson(path);
  const provider = requireText("account.provider", account.provider);
  const accountType = requireText("account.accountType", account.accountType);
  if (provider !== "tradeify-crypto") {
    throw new Error("account.provider must equal tradeify-crypto");
  }
  if (accountType !== "instant-funding") {
    throw new Error("account.accountType must equal instant-funding");
  }
  for (const key of [
    "startingBalance",
    "dailyLossLimit",
    "maxLossOffset",
    "maxLossFloorCap",
    "leverage",
    "maxNotional",
    "consistencyMax",
    "minimumPayout",
    "profitSplit",
    "minimumHoldSeconds"
  ]) {
    requirePositive(`account.${key}`, account[key]);
  }
  requireText("account.dailySnapshotUtc", account.dailySnapshotUtc);
  if (account.consistencyMax > 1) throw new Error("account.consistencyMax must be <= 1");
  if (account.profitSplit > 1) throw new Error("account.profitSplit must be <= 1");
  if (account.maxLossFloorCap !== account.startingBalance) {
    throw new Error("account.maxLossFloorCap must equal account.startingBalance");
  }
  if (account.minimumHoldSeconds < 25) {
    throw new Error("account.minimumHoldSeconds must be at least 25 seconds for the production grid");
  }
  return account;
}

export async function loadStrategyConfig(path = "config/strategy.json") {
  const strategy = await readJson(path);
  if (!strategy.instruments?.["BTC/USD"] || !strategy.instruments?.["SOL/USD"]) {
    throw new Error("strategy must define BTC/USD and SOL/USD");
  }

  const numericValues = {
    "signal.bbPeriod": strategy.signal?.bbPeriod,
    "signal.bbStdDev": strategy.signal?.bbStdDev,
    "signal.rsiPeriod": strategy.signal?.rsiPeriod,
    "signal.rsiLongThreshold": strategy.signal?.rsiLongThreshold,
    "signal.rsiShortThreshold": strategy.signal?.rsiShortThreshold,
    "signal.atrPeriod": strategy.signal?.atrPeriod,
    "signal.stopAtrMultiple": strategy.signal?.stopAtrMultiple,
    "signal.timeStopBars": strategy.signal?.timeStopBars,
    "regime.minDailyAtrPct": strategy.regime?.minDailyAtrPct,
    "regime.maxDailyAtrPct": strategy.regime?.maxDailyAtrPct,
    "regime.adxPeriod": strategy.regime?.adxPeriod,
    "regime.adxMax": strategy.regime?.adxMax,
    "regime.adxStandDown": strategy.regime?.adxStandDown,
    "regime.rangeBandStdDev": strategy.regime?.rangeBandStdDev,
    "risk.stage1RiskCap": strategy.risk?.stage1RiskCap,
    "risk.stage2RiskCap": strategy.risk?.stage2RiskCap,
    "risk.stage2Threshold": strategy.risk?.stage2Threshold,
    "risk.dailySoftStop": strategy.risk?.dailySoftStop,
    "risk.dailyHardStop": strategy.risk?.dailyHardStop,
    "risk.stage1ProfitCeiling": strategy.risk?.stage1ProfitCeiling,
    "risk.stage2ProfitCeiling": strategy.risk?.stage2ProfitCeiling,
    "risk.maxNotional": strategy.risk?.maxNotional,
    "risk.floorSafetyMargin": strategy.risk?.floorSafetyMargin,
    "execution.minHoldSeconds": strategy.execution?.minHoldSeconds,
    "execution.slippageCapPct": strategy.execution?.slippageCapPct
  };
  for (const [name, value] of Object.entries(numericValues)) requireNumber(name, value);

  if (typeof strategy.signal.requireCloseInsideBand !== "boolean") {
    throw new Error("signal.requireCloseInsideBand must be boolean");
  }
  if (typeof strategy.execution.autoExecute !== "boolean") {
    throw new Error("execution.autoExecute must be boolean");
  }
  requireText("execution.hardFlatUtc", strategy.execution.hardFlatUtc);
  if (strategy.risk.dailyHardStop >= strategy.risk.dailySoftStop) {
    throw new Error("dailyHardStop must be more negative than dailySoftStop");
  }
  if (strategy.regime.adxStandDown <= strategy.regime.adxMax) {
    throw new Error("adxStandDown must be greater than adxMax");
  }
  if (strategy.execution.minHoldSeconds < 25) {
    throw new Error("execution.minHoldSeconds must be at least 25");
  }
  return strategy;
}

export function loadEnvironment() {
  const allowedUserId = Number(process.env.TELEGRAM_ALLOWED_USER_ID ?? "0");
  if (!Number.isSafeInteger(allowedUserId) || allowedUserId < 0) {
    throw new Error("TELEGRAM_ALLOWED_USER_ID must be a non-negative integer");
  }

  const environment = {
    telegramToken: requireText("TELEGRAM_BOT_TOKEN", process.env.TELEGRAM_BOT_TOKEN),
    telegramAllowedUserId: allowedUserId,
    databaseUrl: requireText("DATABASE_URL", process.env.DATABASE_URL),
    databaseSsl: parseBoolean("DATABASE_SSL", process.env.DATABASE_SSL, false),
    appMode: process.env.APP_MODE ?? "stage-a",
    autoExecute: parseBoolean("AUTO_EXECUTE", process.env.AUTO_EXECUTE, false),
    nodeEnv: process.env.NODE_ENV ?? "production",
    dxtrade: Object.freeze({
      restBaseUrl: requireText("DXTRADE_REST_BASE_URL", process.env.DXTRADE_REST_BASE_URL),
      username: requireText("DXTRADE_USERNAME", process.env.DXTRADE_USERNAME),
      domain: requireText("DXTRADE_DOMAIN", process.env.DXTRADE_DOMAIN),
      password: requireText("DXTRADE_PASSWORD", process.env.DXTRADE_PASSWORD),
      accountCode: requireText("DXTRADE_ACCOUNT_CODE", process.env.DXTRADE_ACCOUNT_CODE)
    })
  };

  if (environment.appMode !== "stage-a") {
    throw new Error("The production grid remains in APP_MODE=stage-a until the final live activation decision");
  }
  if (environment.autoExecute) {
    throw new Error("AUTO_EXECUTE must remain false until the final D-038 live activation approval");
  }
  return Object.freeze(environment);
}

export async function loadConfiguration() {
  const [account, strategy] = await Promise.all([
    loadAccountConfig(),
    loadStrategyConfig()
  ]);
  const environment = loadEnvironment();
  if (strategy.execution.autoExecute) {
    throw new Error("config/strategy.json execution.autoExecute must remain false");
  }
  return { account, strategy, environment };
}
