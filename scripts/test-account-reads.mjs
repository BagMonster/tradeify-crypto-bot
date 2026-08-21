#!/usr/bin/env node
/**
 * scripts/test-account-reads.mjs
 * Read-only checks for account endpoints.
 * Does NOT place, modify, or cancel orders.
 */
import "dotenv/config";
import { DxtradeReadOnlyClient } from "../src/dxtradeClient.js";

function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function summarize(label, value) {
  console.log(`\n=== ${label} ===`);
  if (value === null || value === undefined) {
    console.log("(empty)");
    return;
  }
  // Print structure safely
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const accountCode = requireEnv("DXTRADE_ACCOUNT_CODE");
  // Expect something like default:I50K2163174

  const client = new DxtradeReadOnlyClient({
    restBaseUrl: requireEnv("DXTRADE_REST_BASE_URL"),
    marketDataUrl: requireEnv("DXTRADE_MARKETDATA_WS_URL"),
    username: requireEnv("DXTRADE_USERNAME"),
    domain: requireEnv("DXTRADE_DOMAIN"),
    password: requireEnv("DXTRADE_PASSWORD")
  });

  console.log("Logging in (read-only)...");
  await client.login();
  console.log("Logged in.");
  console.log(`Account: ${accountCode}`);

  const tests = [
    {
      name: "getAccountMetrics",
      run: () => client.getAccountMetrics(accountCode)
    },
    {
      name: "getAccountPortfolio",
      run: () => client.getAccountPortfolio(accountCode)
    },
    {
      name: "getOpenPositions",
      run: () => client.getOpenPositions(accountCode)
    },
    {
      name: "getOpenOrders",
      run: () => client.getOpenOrders(accountCode)
    },
    {
      name: "getInstrumentDetails(BTC/USD)",
      run: () => client.getInstrumentDetails(accountCode, "BTC/USD")
    }
  ];

  for (const test of tests) {
    try {
      console.log(`\nTesting ${test.name}...`);
      const result = await test.run();
      summarize(`${test.name} OK`, result);
    } catch (err) {
      console.log(`\n=== ${test.name} FAILED ===`);
      console.log(err.message);
      if (err.status) console.log(`status: ${err.status}`);
      if (err.apiCode != null) console.log(`apiCode: ${err.apiCode}`);
    }
  }

  await client.logout();
  console.log("\nLogged out.");
  console.log("Done. No orders were placed or changed.");
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});

