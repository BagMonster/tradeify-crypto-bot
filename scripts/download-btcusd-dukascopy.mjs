#!/usr/bin/env node
/**
 * scripts/download-btcusd-dukascopy.mjs
 *
 * Owner-run research data tool.
 * Downloads FOREX-style BTCUSD OHLCV from Dukascopy (programmable source
 * closer to DXtrade's BTC/USD FOREX instrument than Binance spot BTCUSDT).
 *
 * Output:
 *   artifacts/research-bars-btcusd/5m.json
 *   artifacts/research-bars-btcusd/1d.json
 *
 * Usage:
 *   npm install dukascopy-node --save
 *   node scripts/download-btcusd-dukascopy.mjs
 *
 * Optional env:
 *   BTCUSD_HISTORY_DAYS=400
 *   BTCUSD_TIMEFRAMES=5m,1d
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getHistoricalRates } from "dukascopy-node";

const SOURCE = "dukascopy";
const SYMBOL = "BTCUSD";
const OUTPUT_DIR = path.resolve("artifacts", "research-bars-btcusd");

const TIMEFRAME_MAP = Object.freeze({
  "5m": { dukascopy: "m5", intervalMs: 5 * 60 * 1000 },
  "15m": { dukascopy: "m15", intervalMs: 15 * 60 * 1000 },
  "1d": { dukascopy: "d1", intervalMs: 24 * 60 * 60 * 1000 }
});

function parseHistoryDays() {
  const raw = process.env.BTCUSD_HISTORY_DAYS;
  if (raw === undefined || raw === "") return 400;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 7 || n > 3000) {
    throw new Error("BTCUSD_HISTORY_DAYS must be an integer from 7 to 3000");
  }
  return n;
}

function parseTimeframes() {
  const raw = process.env.BTCUSD_TIMEFRAMES;
  const list = (raw && raw.trim() !== "" ? raw : "5m,1d")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const tf of list) {
    if (!TIMEFRAME_MAP[tf]) {
      throw new Error(`Unsupported timeframe "${tf}". Use: ${Object.keys(TIMEFRAME_MAP).join(", ")}`);
    }
  }
  return list;
}

function alignDown(ms, intervalMs) {
  return Math.floor(ms / intervalMs) * intervalMs;
}

function normalizeBar(row, { timeframe, intervalMs }) {
  const openMs = Number(row.timestamp ?? row.time ?? row[0]);
  if (!Number.isFinite(openMs) || openMs <= 0) {
    throw new Error(`Invalid timestamp in ${timeframe} row`);
  }

  const open = Number(row.open ?? row[1]);
  const high = Number(row.high ?? row[2]);
  const low = Number(row.low ?? row[3]);
  const close = Number(row.close ?? row[4]);
  const volume = Number(row.volume ?? row[5] ?? 0);

  if (![open, high, low, close].every((n) => Number.isFinite(n) && n > 0)) {
    throw new Error(`Invalid OHLC in ${timeframe} at ${new Date(openMs).toISOString()}`);
  }
  if (!Number.isFinite(volume) || volume < 0) {
    throw new Error(`Invalid volume in ${timeframe} at ${new Date(openMs).toISOString()}`);
  }
  if (high < Math.max(open, low, close) || low > Math.min(open, high, close)) {
    throw new Error(`Inconsistent OHLC in ${timeframe} at ${new Date(openMs).toISOString()}`);
  }

  const alignedOpen = alignDown(openMs, intervalMs);
  const closeMs = alignedOpen + intervalMs;

  return Object.freeze({
    source: SOURCE,
    symbol: SYMBOL,
    timeframe,
    openTime: new Date(alignedOpen).toISOString(),
    closeTime: new Date(closeMs).toISOString(),
    open,
    high,
    low,
    close,
    volume,
    isClosed: true
  });
}

function dedupeAndSort(bars) {
  const byOpen = new Map();
  for (const bar of bars) byOpen.set(bar.openTime, bar);
  return [...byOpen.values()].sort(
    (a, b) => Date.parse(a.openTime) - Date.parse(b.openTime)
  );
}

async function downloadTimeframe(timeframe, historyDays) {
  const meta = TIMEFRAME_MAP[timeframe];
  const to = new Date();
  const from = new Date(Date.now() - historyDays * 24 * 60 * 60 * 1000);

  console.log(`\nDownloading ${SYMBOL} ${timeframe} (${meta.dukascopy})...`);
  console.log(`  from ${from.toISOString()} to ${to.toISOString()}`);

  const raw = await getHistoricalRates({
    instrument: "btcusd",
    dates: { from, to },
    timeframe: meta.dukascopy,
    format: "json",
    priceType: "bid",
    batchSize: 10,
    pauseBetweenBatchesMs: 500
  });

  if (!Array.isArray(raw)) {
    throw new Error(`${timeframe}: expected array response from dukascopy-node`);
  }

  const bars = dedupeAndSort(
    raw.map((row) => normalizeBar(row, { timeframe, intervalMs: meta.intervalMs }))
  );

  const now = Date.now();
  const completed = bars.filter((b) => Date.parse(b.closeTime) <= now);

  console.log(`  received ${raw.length} rows → ${completed.length} completed bars`);
  if (completed.length > 0) {
    console.log(`  range ${completed[0].openTime} .. ${completed[completed.length - 1].closeTime}`);
  }

  return completed;
}

async function main() {
  const historyDays = parseHistoryDays();
  const timeframes = parseTimeframes();

  console.log(`Source: ${SOURCE}`);
  console.log(`Symbol: ${SYMBOL}`);
  console.log(`History days: ${historyDays}`);
  console.log(`Timeframes: ${timeframes.join(", ")}`);

  await mkdir(OUTPUT_DIR, { recursive: true });

  for (const timeframe of timeframes) {
    const bars = await downloadTimeframe(timeframe, historyDays);
    const outPath = path.join(OUTPUT_DIR, `${timeframe}.json`);
    await writeFile(outPath, `${JSON.stringify(bars)}\n`, "utf8");
    console.log(`  wrote ${outPath}`);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(`download-btcusd-dukascopy failed: ${err.message}`);
  process.exitCode = 1;
});

