#!/usr/bin/env node
/**
 * scripts/test-quotes.mjs
 * Read-only: login + try a short live quote subscription for BTC/USD.
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

async function main() {
  const accountCode = process.env.DXTRADE_ACCOUNT_CODE?.trim();
  if (!accountCode || accountCode === "replace_after_read_only_discovery") {
    throw new Error("Set DXTRADE_ACCOUNT_CODE in .env first (e.g. default:I50K2163174)");
  }

  const client = new DxtradeReadOnlyClient({
    restBaseUrl: requireEnv("DXTRADE_REST_BASE_URL"),
    marketDataUrl: requireEnv("DXTRADE_MARKETDATA_WS_URL"),
    username: requireEnv("DXTRADE_USERNAME"),
    domain: requireEnv("DXTRADE_DOMAIN"),
    password: requireEnv("DXTRADE_PASSWORD")
  });

  console.log("Logging in...");
  await client.login();
  console.log("Logged in.");
  console.log(`Using account: ${accountCode}`);
  console.log("Subscribing to BTC/USD quotes for ~8 seconds...\n");

  let quoteCount = 0;

  const sub = client.subscribeQuotes({
    accountCode,
    symbols: ["BTC/USD"],
    onQuote: (quote) => {
      quoteCount += 1;
      console.log(`Quote #${quoteCount}:`, {
        symbol: quote.symbol,
        bid: quote.bid,
        ask: quote.ask,
        time: quote.time
      });
    },
    onState: (state) => {
      console.log("State:", state);
    },
    onError: (err) => {
      console.log("Quote error:", err.message);
    }
  });

  // Listen for a few seconds then close
  await new Promise((r) => setTimeout(r, 8000));
  sub.close();
  await client.logout();
  console.log(`\nDone. Received ${quoteCount} quote(s). Logged out.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});

