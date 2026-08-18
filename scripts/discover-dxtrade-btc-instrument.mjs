#!/usr/bin/env node
/**
 * scripts/discover-dxtrade-btc-instrument.mjs
 *
 * NOT part of src/research/. NOT imported by any research module, and NOT
 * imported by index.mjs. Like scripts/export-bars-for-research.mjs, this is
 * a one-off, owner-run bridge tool: it is allowed to make network calls
 * because the OWNER runs it directly, with the owner's own already-
 * configured DXtrade credentials (read from a local .env file that
 * .gitignore already excludes - never checked into git, never printed).
 *
 * Purpose: read-only discovery only.
 *   1. Logs in to DXtrade using DxtradeReadOnlyClient (src/dxtradeClient.js).
 *   2. Looks up instruments matching "BTC" to find the exact DXtrade
 *      instrument symbol for BTC (e.g. "BTC/USD" or something else -
 *      this script does not assume the answer).
 *   3. If exactly one BTC instrument is found, pulls a small sample of
 *      recent historical candles for it as an end-to-end smoke test.
 *   4. Prints everything to the console and logs out. Never logs the
 *      session token, username, domain, or password.
 *
 * This script places NO order, modifies NO settings, and never touches
 * config/strategy.json or config/account.json. It is read-only, consistent
 * with DxtradeReadOnlyClient's existing security posture (no order-
 * placement methods exist on that client at all).
 *
 * Usage (from the repository root, with a real .env present containing
 * DXTRADE_REST_BASE_URL, DXTRADE_MARKETDATA_WS_URL, DXTRADE_USERNAME,
 * DXTRADE_DOMAIN, DXTRADE_PASSWORD, and - if already known -
 * DXTRADE_ACCOUNT_CODE):
 *
 *   node scripts/discover-dxtrade-btc-instrument.mjs
 *
 * Output: console only. Nothing is written to disk and nothing is
 * committed to git by this script.
 */

import "dotenv/config";
import { DxtradeReadOnlyClient } from "../src/dxtradeClient.js";

const CANDLE_SAMPLE_COUNT = 5;
const CANDLE_TYPE = "15m";

function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required (set it in your local .env)`);
  }
  return value.trim();
}

function buildClient() {
  return new DxtradeReadOnlyClient({
    restBaseUrl: requireEnv("DXTRADE_REST_BASE_URL"),
    marketDataUrl: requireEnv("DXTRADE_MARKETDATA_WS_URL"),
    username: requireEnv("DXTRADE_USERNAME"),
    domain: requireEnv("DXTRADE_DOMAIN"),
    password: requireEnv("DXTRADE_PASSWORD")
  });
}

function looksLikeBtc(symbol) {
  return typeof symbol === "string" && symbol.toUpperCase().includes("BTC");
}

function extractInstrumentList(response) {
  // DXtrade's instrument endpoints have been observed to return either a
  // bare array or an object with an "instruments" array - handle both
  // without assuming which shape the live server returns.
  if (Array.isArray(response)) return response;
  if (response && Array.isArray(response.instruments)) return response.instruments;
  return [];
}

async function main() {
  const client = buildClient();
  const accountCode = process.env.DXTRADE_ACCOUNT_CODE;
  const hasRealAccountCode =
    typeof accountCode === "string" &&
    accountCode.trim() !== "" &&
    accountCode.trim() !== "replace_after_read_only_discovery";

  console.log("Logging in to DXtrade (read-only session)...");
  const session = await client.login();
  console.log(`Logged in. Session authenticated=${session.authenticated}, timeout=${session.timeout}`);

  try {
    console.log('\nSearching instruments matching "BTC*"...');
    let btcMatches = [];
    try {
      const bySymbol = await client.listInstruments({ symbol: "BTC*" });
      btcMatches = extractInstrumentList(bySymbol).filter((item) => looksLikeBtc(item.symbol ?? item.id));
    } catch (error) {
      console.log(`  symbol-wildcard lookup failed (${error.message}); falling back to type lookup`);
    }

    if (btcMatches.length === 0) {
      console.log('Falling back to instruments of type "CRYPTO" and filtering for BTC...');
      const byType = await client.listInstruments({ type: "CRYPTO" });
      btcMatches = extractInstrumentList(byType).filter((item) => looksLikeBtc(item.symbol ?? item.id));
    }

    if (btcMatches.length === 0) {
      console.log("\nNo BTC instruments found. Print the full raw response above (if any) and report back.");
      return;
    }

    console.log(`\nFound ${btcMatches.length} BTC-matching instrument(s):`);
    for (const instrument of btcMatches) {
      console.log(`  symbol=${instrument.symbol ?? instrument.id ?? "(unknown)"} raw=${JSON.stringify(instrument)}`);
    }

    if (btcMatches.length !== 1) {
      console.log(
        "\nMore than one BTC match (or ambiguous shape) - report the list above back so the exact symbol can be confirmed before anything else uses it."
      );
      return;
    }

    const btcSymbol = btcMatches[0].symbol ?? btcMatches[0].id;
    console.log(`\nExact DXtrade BTC instrument symbol: ${btcSymbol}`);

    console.log(`\nPulling ${CANDLE_SAMPLE_COUNT} recent ${CANDLE_TYPE} candles for ${btcSymbol} as a smoke test...`);
    const candleRequest = {
      symbols: [btcSymbol],
      candleType: CANDLE_TYPE,
      count: CANDLE_SAMPLE_COUNT
    };
    if (hasRealAccountCode) candleRequest.account = accountCode.trim();

    const candles = await client.getHistoricalCandles(candleRequest);
    console.log("Raw candle response:");
    console.log(JSON.stringify(candles, null, 2));
  } finally {
    console.log("\nLogging out...");
    await client.logout();
    console.log("Logged out.");
  }
}

main().catch((error) => {
  console.error(`discover-dxtrade-btc-instrument failed: ${error.message}`);
  process.exitCode = 1;
});
