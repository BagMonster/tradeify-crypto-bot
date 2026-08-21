#!/usr/bin/env node
/**
 * scripts/dxtrade-probe.mjs
 *
 * Owner-run, read-only discovery tool.
 * Purpose (from buildplan20260819.md):
 *   1. Discover the full instrument list this account can see.
 *   2. Measure 5m retention depth (how far back 5-minute candles go).
 *   3. Measure daily ("d") retention depth.
 *   4. Find the practical per-request candle ceiling.
 *   5. Write findings to artifacts/dxtrade-probe-findings.json
 *
 * Still 100% read-only. Places no orders.
 *
 * Required local .env variables:
 *   DXTRADE_REST_BASE_URL
 *   DXTRADE_MARKETDATA_WS_URL
 *   DXTRADE_USERNAME
 *   DXTRADE_DOMAIN
 *   DXTRADE_PASSWORD
 *
 * Optional:
 *   DXTRADE_ACCOUNT_CODE
 *
 * Usage (from repo root):
 *   node scripts/dxtrade-probe.mjs
 */

import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { DxtradeReadOnlyClient } from "../src/dxtradeClient.js";

const ARTIFACTS_DIR = path.join(process.cwd(), "artifacts");
const FINDINGS_PATH = path.join(ARTIFACTS_DIR, "dxtrade-probe-findings.json");

const MAX_LOOKBACK_DAYS_5M = 400;
const MAX_LOOKBACK_DAYS_DAILY = 600;

function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required (set it in your local .env)`);
  }
  return value.trim();
}

function optionalEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") return null;
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

function extractInstrumentList(response) {
  if (Array.isArray(response)) return response;
  if (response && Array.isArray(response.instruments)) return response.instruments;
  return [];
}

function extractCandleEvents(response) {
  if (!response) return [];
  if (Array.isArray(response)) return response;
  if (Array.isArray(response.events)) return response.events;
  if (response.payload && Array.isArray(response.payload.events)) return response.payload.events;
  if (Array.isArray(response.candles)) return response.candles;
  return [];
}

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function isoNow() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Prefer real tradable pairs over currency-only symbols like BTC$.
 */
function pickPrimarySymbol(instruments) {
  const normalized = instruments
    .map((item) => ({
      symbol: item.symbol ?? item.id ?? null,
      type: item.type ?? item.instrumentType ?? null
    }))
    .filter((i) => typeof i.symbol === "string" && i.symbol.length > 0);

  // Prefer BTC/USD style pairs
  const btcUsd = normalized.find(
    (i) => i.symbol.toUpperCase() === "BTC/USD" || i.symbol.toUpperCase() === "BTCUSD"
  );
  if (btcUsd) return btcUsd.symbol;

  // Next: any symbol that looks like a BTC pair
  const btcPair = normalized.find(
    (i) =>
      i.symbol.toUpperCase().includes("BTC") &&
      (i.symbol.includes("/") || i.type === "FOREX" || i.type === "CRYPTO")
  );
  if (btcPair) return btcPair.symbol;

  // Fallback: first instrument
  return normalized[0]?.symbol ?? null;
}

/**
 * DXtrade requires fromTime for Candle requests.
 * Always send a proper time window.
 */
async function requestCandles(client, { symbol, candleType, fromTime, toTime, count, account }) {
  return client.getHistoricalCandles({
    symbols: [symbol],
    candleType,
    fromTime,
    toTime,
    count,
    account: account || undefined
  });
}

/**
 * Binary-search how far back candles exist.
 */
async function measureRetention(client, { symbol, candleType, maxDays, account }) {
  console.log(`\nMeasuring ${candleType} retention for ${symbol} (up to ${maxDays} days)...`);

  let low = 0;
  let high = maxDays;
  let best = null;

  // Recent smoke test: last 3 days
  try {
    const recent = await requestCandles(client, {
      symbol,
      candleType,
      fromTime: isoDaysAgo(3),
      toTime: isoNow(),
      count: 20,
      account
    });
    const events = extractCandleEvents(recent);
    if (events.length === 0) {
      console.log(`  No recent ${candleType} candles returned — retention unknown / possibly zero.`);
      return { days: null, note: "no recent candles" };
    }
    console.log(`  Recent window OK (${events.length} bars)`);
  } catch (err) {
    console.log(`  Recent candle request failed: ${err.message}`);
    return { days: null, note: `recent request failed: ${err.message}` };
  }

  // Binary search backwards
  for (let iter = 0; iter < 12; iter++) {
    const mid = Math.floor((low + high) / 2);
    if (mid === low) break;

    const fromTime = isoDaysAgo(mid);
    try {
      const resp = await requestCandles(client, {
        symbol,
        candleType,
        fromTime,
        toTime: isoNow(),
        count: 10,
        account
      });
      const events = extractCandleEvents(resp);
      if (events.length > 0) {
        best = mid;
        low = mid;
        console.log(`  ${mid} days ago → data present (${events.length} bars)`);
      } else {
        high = mid;
        console.log(`  ${mid} days ago → empty`);
      }
    } catch (err) {
      high = mid;
      console.log(`  ${mid} days ago → error (${err.message})`);
    }
    await sleep(400);
  }

  return { days: best, note: best != null ? `approx ${best} days` : "could not establish" };
}

/**
 * Find practical per-request count ceiling.
 * Always include a time window so the API accepts the request.
 */
async function measureCountCeiling(client, { symbol, candleType, account }) {
  console.log(`\nMeasuring per-request count ceiling for ${candleType} on ${symbol}...`);
  const candidates = [100, 250, 500, 1000, 2000, 3000, 5000];
  let lastGood = null;
  let lastCount = 0;

  // Use a moderately long window so large counts have room to fill
  const fromTime = isoDaysAgo(candleType === "d" ? 400 : 60);
  const toTime = isoNow();

  for (const count of candidates) {
    try {
      const resp = await requestCandles(client, {
        symbol,
        candleType,
        fromTime,
        toTime,
        count,
        account
      });
      const events = extractCandleEvents(resp);
      const got = events.length;
      console.log(`  requested ${count} → received ${got}`);
      if (got > lastCount) {
        lastGood = count;
        lastCount = got;
      } else {
        break;
      }
      if (got < count) {
        lastGood = got;
        break;
      }
    } catch (err) {
      console.log(`  requested ${count} → rejected (${err.message})`);
      break;
    }
    await sleep(400);
  }

  return { ceiling: lastGood, observedMaxBars: lastCount };
}

async function main() {
  const client = buildClient();
  const accountFromEnv = optionalEnv("DXTRADE_ACCOUNT_CODE");
  const hasRealAccount =
    accountFromEnv && accountFromEnv !== "replace_after_read_only_discovery";

  console.log("Logging in to DXtrade (read-only)...");
  const session = await client.login();
  console.log(`Logged in. authenticated=${session.authenticated}`);

  const findings = {
    probedAt: new Date().toISOString(),
    accountCodePresentInEnv: Boolean(hasRealAccount),
    instruments: [],
    primarySymbol: null,
    retention: {},
    countCeiling: {},
    notes: []
  };

  try {
    // ---------- 1. Instrument discovery ----------
    console.log("\nDiscovering instruments...");
    let instruments = [];

    // Try a few discovery strategies
    const strategies = [
      { label: "type=FOREX", fn: () => client.listInstruments({ type: "FOREX" }) },
      { label: "type=CRYPTO", fn: () => client.listInstruments({ type: "CRYPTO" }) },
      { label: "symbol=BTC*", fn: () => client.listInstruments({ symbol: "BTC*" }) },
      { label: "symbol=*", fn: () => client.listInstruments({ symbol: "*" }) }
    ];

    for (const strategy of strategies) {
      try {
        const resp = await strategy.fn();
        const list = extractInstrumentList(resp);
        console.log(`  ${strategy.label} → ${list.length} items`);
        if (list.length > instruments.length) {
          instruments = list;
        }
      } catch (err) {
        console.log(`  ${strategy.label} failed: ${err.message}`);
        findings.notes.push(`${strategy.label} failed: ${err.message}`);
      }
    }

    findings.instruments = instruments.map((item) => ({
      symbol: item.symbol ?? item.id ?? null,
      type: item.type ?? item.instrumentType ?? null,
      rawKeys: Object.keys(item || {})
    }));

    console.log("\nInstrument summary:");
    for (const inst of findings.instruments) {
      console.log(`  ${inst.symbol}  (type=${inst.type})`);
    }

    const primarySymbol = pickPrimarySymbol(findings.instruments);
    if (!primarySymbol) {
      findings.notes.push("No usable instrument symbol found — cannot measure retention/ceiling.");
      console.log("\nNo usable symbol found. Stopping measurement phase.");
    } else {
      findings.primarySymbol = primarySymbol;
      console.log(`\nUsing primary symbol for measurements: ${primarySymbol}`);

      const account = hasRealAccount ? accountFromEnv : undefined;

      // ---------- 2. Retention ----------
      findings.retention["5m"] = await measureRetention(client, {
        symbol: primarySymbol,
        candleType: "5m",
        maxDays: MAX_LOOKBACK_DAYS_5M,
        account
      });

      findings.retention["d"] = await measureRetention(client, {
        symbol: primarySymbol,
        candleType: "d",
        maxDays: MAX_LOOKBACK_DAYS_DAILY,
        account
      });

      // ---------- 3. Count ceiling ----------
      findings.countCeiling["5m"] = await measureCountCeiling(client, {
        symbol: primarySymbol,
        candleType: "5m",
        account
      });

      findings.countCeiling["d"] = await measureCountCeiling(client, {
        symbol: primarySymbol,
        candleType: "d",
        account
      });
    }
  } finally {
    console.log("\nLogging out...");
    await client.logout();
    console.log("Logged out.");
  }

  // ---------- 4. Persist findings ----------
  await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
  await fs.writeFile(FINDINGS_PATH, JSON.stringify(findings, null, 2), "utf8");
  console.log(`\nFindings written to ${FINDINGS_PATH}`);
  console.log("Do NOT paste the full findings file into chat if it ever contains an account code.");
  console.log("You can safely share the retention days, ceiling numbers, and instrument list.");
}

main().catch((err) => {
  console.error(`dxtrade-probe failed: ${err.message}`);
  process.exitCode = 1;
});

