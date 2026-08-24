import test from "node:test";
import assert from "node:assert/strict";
import { loadConfiguration, loadEnvironment, loadStrategyConfig } from "../src/config.js";

const REQUIRED_ENV = Object.freeze({
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_ALLOWED_USER_ID: "1",
  DATABASE_URL: "postgres://user:pass@localhost:5432/test",
  DATABASE_SSL: "false",
  NODE_ENV: "test",
  DXTRADE_REST_BASE_URL: "https://dx.tradeifycrypto.co/dxsca-web",
  DXTRADE_USERNAME: "test-user",
  DXTRADE_DOMAIN: "test-domain",
  DXTRADE_PASSWORD: "test-password",
  DXTRADE_ACCOUNT_CODE: "test-account"
});

function installEnv(overrides = {}) {
  const keys = [...Object.keys(REQUIRED_ENV), "APP_MODE", "AUTO_EXECUTE"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, REQUIRED_ENV, overrides);
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test("final SOL strategy can be deployed armed while Railway execution remains off", async () => {
  const restore = installEnv({ APP_MODE: "stage-a", AUTO_EXECUTE: "false" });
  try {
    const strategy = await loadStrategyConfig();
    assert.equal(strategy.strategyId, "sol-outer-heavy-v1");
    assert.equal(strategy.strategyStatus, "production-live-approved");
    assert.equal(strategy.execution.autoExecute, true);

    const configuration = await loadConfiguration();
    assert.equal(configuration.environment.appMode, "stage-a");
    assert.equal(configuration.environment.autoExecute, false);
    assert.equal(configuration.strategy.execution.autoExecute, true);
  } finally {
    restore();
  }
});

test("AUTO_EXECUTE=true is accepted only with APP_MODE=live", () => {
  let restore = installEnv({ APP_MODE: "stage-a", AUTO_EXECUTE: "true" });
  try {
    assert.throws(() => loadEnvironment(), /AUTO_EXECUTE=true requires APP_MODE=live/);
  } finally {
    restore();
  }

  restore = installEnv({ APP_MODE: "live", AUTO_EXECUTE: "true" });
  try {
    const environment = loadEnvironment();
    assert.equal(environment.appMode, "live");
    assert.equal(environment.autoExecute, true);
  } finally {
    restore();
  }
});

test("full final activation configuration loads with both live controls enabled", async () => {
  const restore = installEnv({ APP_MODE: "live", AUTO_EXECUTE: "true" });
  try {
    const configuration = await loadConfiguration();
    assert.equal(configuration.environment.appMode, "live");
    assert.equal(configuration.environment.autoExecute, true);
    assert.equal(configuration.strategy.execution.autoExecute, true);
    assert.equal(configuration.instrument.dxtradeSymbol, "SOL/USD");
    assert.equal(configuration.instrument.binanceSymbol, "SOLUSDT");
  } finally {
    restore();
  }
});
