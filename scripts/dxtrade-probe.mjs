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
 *      (never paste the account code or secrets into chat).
 *
 * Still 100% read-only. Places no orders. Does not touch strategy or account config.
 *
 * Required local .env variables:
 *   DXTRADE_REST_BASE_URL
 *   DXTRADE_MARKETDATA_WS_URL   (still required by DxtradeReadOnlyClient constructor)
 *   DXTRADE_USERNAME
 *   DXTRADE_DOMAIN
 *   DXTRADE_PASSWORD
 *
 * Optional:
 *   DXTRADE_ACCOUNT_CODE        (if already known; otherwise we try to discover what we can)
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

// How far back we are willing to search (in days). Binary search stays within this.
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
  // Defensive: DXtrade marketdata responses have varied shapes in the wild.
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Binary-search how far back candles of a given type exist for a symbol.
 * Returns approximate retention in days (or null if we could not measure).
 */
async function measureRetention(client, { symbol, candleType, maxDays, account }) {
  console.log(`\nMeasuring ${candleType} retention for ${symbol} (up to ${maxDays} days)...`);

  let low = 0;          // days ago that definitely have data (or 0)
  let high = maxDays;   // days ago we are testing
  let best = null;

  // First, quick check that recent data exists at all
  try {
    const recent = await client.getHistoricalCandles({
      symbols: [symbol],
      candleType,
      count: 3,
      account: account || undefined
    });
    const events = extractCandleEvents(recent);
    if (events.length === 0) {
      console.log(`  No recent ${candleType} candles returned — retention unknown / possibly zero.`);
      return { days: null, note: "no recent candles" };
    }
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
      const resp = await client.getHistoricalCandles({
        symbols: [symbol],
        candleType,
        fromTime,
        count: 5,
        account: account || undefined
      });
      const events = extractCandleEvents(resp);
      if (events.length > 0) {
        best = mid;
        low = mid;           // can go further back
        console.log(`  ${mid} days ago → data present`);
      } else {
        high = mid;          // too far
        console.log(`  ${mid} days ago → empty`);
      }
    } catch (err) {
      high = mid;
      console.log(`  ${mid} days ago → error (${err.message})`);
    }
    await sleep(400); // be polite to the API
  }

  return { days: best, note: best != null ? `approx ${best} days` : "could not establish" };
}

/**
 * Find a practical per-request count ceiling by asking for increasing counts
 * until the response stops growing or the API rejects.
 */
async function measureCountCeiling(client, { symbol, candleType, account }) {
  console.log(`\nMeasuring per-request count ceiling for ${candleType} on ${symbol}...`);
  const candidates = [100, 250, 500, 1000, 2000, 3000, 5000];
  let lastGood = null;
  let lastCount = 0;

  for (const count of candidates) {
    try {
      const resp = await client.getHistoricalCandles({
        symbols: [symbol],
        candleType,
        count,
        account: account || undefined
      });
      const events = extractCandleEvents(resp);
      const got = events.length;
      console.log(`  requested ${count} → received ${got}`);
      if (got > lastCount) {
        lastGood = count;
        lastCount = got;
      } else {
        // Response stopped growing — we hit a soft ceiling
        break;
      }
      if (got < count) {
        // Server truncated us
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
    // We deliberately do NOT store the actual account code in the findings file
    // that might be shared. Owner can fill it locally if needed.
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

    try {
      const byType = await client.listInstruments({ type: "CRYPTO" });
      instruments = extractInstrumentList(byType);
      console.log(`  listInstruments(type=CRYPTO) → ${instruments.length} items`);
    } catch (err) {
      console.log(`  type=CRYPTO failed: ${err.message}`);
      findings.notes.push(`listInstruments(type=CRYPTO) failed: ${err.message}`);
    }

    if (instruments.length === 0) {
      try {
        const byBtc = await client.listInstruments({ symbol: "BTC*" });
        instruments = extractInstrumentList(byBtc);
        console.log(`  listInstruments(symbol=BTC*) → ${instruments.length} items`);
      } catch (err) {
        console.log(`  symbol=BTC* failed: ${err.message}`);
        findings.notes.push(`listInstruments(symbol=BTC*) failed: ${err.message}`);
      }
    }

    // Normalise and store a safe summary
    findings.instruments = instruments.map((item) => ({
      symbol: item.symbol ?? item.id ?? null,
      type: item.type ?? item.instrumentType ?? null,
      rawKeys: Object.keys(item || {})
    }));

    console.log("\nInstrument summary:");
    for (const inst of findings.instruments) {
      console.log(`  ${inst.symbol}  (type=${inst.type})`);
    }

    // Prefer a BTC-like symbol for the retention / ceiling tests
    const btcLike = findings.instruments.find(
      (i) => typeof i.symbol === "string" && i.symbol.toUpperCase().includes("BTC")
    );
    const primary = btcLike || findings.instruments[0];
    if (!primary?.symbol) {
      findings.notes.push("No usable instrument symbol found — cannot measure retention/ceiling.");
      console.log("\nNo usable symbol found. Stopping measurement phase.");
    } else {
      findings.primarySymbol = primary.symbol;
      console.log(`\nUsing primary symbol for measurements: ${primary.symbol}`);

      const account = hasRealAccount ? accountFromEnv : undefined;

      // ---------- 2. Retention ----------
      findings.retention["5m"] = await measureRetention(client, {
        symbol: primary.symbol,
        candleType: "5m",
        maxDays: MAX_LOOKBACK_DAYS_5M,
        account
      });

      findings.retention["d"] = await measureRetention(client, {
        symbol: primary.symbol,
        candleType: "d",
        maxDays: MAX_LOOKBACK_DAYS_DAILY,
        account
      });

      // ---------- 3. Count ceiling ----------
      findings.countCeiling["5m"] = await measureCountCeiling(client, {
        symbol: primary.symbol,
        candleType: "5m",
        account
      });

      findings.countCeiling["d"] = await measureCountCeiling(client, {
        symbol: primary.symbol,
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

