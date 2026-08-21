#!/usr/bin/env node
/**
 * scripts/smoke-btcusd-dataset.mjs
 *
 * Read-only check of Dukascopy BTCUSD research bars.
 * Does not touch Chapter 26 Binance pipeline.
 *
 * Usage:
 *   node scripts/smoke-btcusd-dataset.mjs
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const BARS_DIR = path.resolve("artifacts", "research-bars-btcusd");
const TIMEFRAMES = ["5m", "1d"];

function intervalMs(timeframe) {
  if (timeframe === "5m") return 5 * 60 * 1000;
  if (timeframe === "1d") return 24 * 60 * 60 * 1000;
  throw new Error(`unsupported timeframe ${timeframe}`);
}

async function load(timeframe) {
  const filePath = path.join(BARS_DIR, `${timeframe}.json`);
  const bars = JSON.parse(await readFile(filePath, "utf8"));
  if (!Array.isArray(bars) || bars.length === 0) {
    throw new Error(`${timeframe}: empty or invalid array`);
  }

  const ms = intervalMs(timeframe);
  let gaps = 0;
  let prevClose = null;

  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i];
    if (b.source !== "dukascopy" || b.symbol !== "BTCUSD" || b.timeframe !== timeframe) {
      throw new Error(`${timeframe}[${i}]: bad source/symbol/timeframe`);
    }
    if (b.isClosed !== true) throw new Error(`${timeframe}[${i}]: not closed`);

    const openMs = Date.parse(b.openTime);
    const closeMs = Date.parse(b.closeTime);
    if (!Number.isFinite(openMs) || !Number.isFinite(closeMs)) {
      throw new Error(`${timeframe}[${i}]: bad timestamps`);
    }
    if (closeMs - openMs !== ms) {
      throw new Error(`${timeframe}[${i}]: interval length mismatch`);
    }
    if (prevClose !== null && openMs !== prevClose) {
      gaps += 1;
    }
    prevClose = closeMs;

    const { open, high, low, close } = b;
    if (![open, high, low, close].every((n) => Number.isFinite(n) && n > 0)) {
      throw new Error(`${timeframe}[${i}]: bad OHLC`);
    }
    if (high < Math.max(open, low, close) || low > Math.min(open, high, close)) {
      throw new Error(`${timeframe}[${i}]: inconsistent OHLC`);
    }
  }

  return {
    timeframe,
    count: bars.length,
    firstOpen: bars[0].openTime,
    lastClose: bars[bars.length - 1].closeTime,
    gaps
  };
}

async function main() {
  console.log(`Checking ${BARS_DIR} ...\n`);
  for (const tf of TIMEFRAMES) {
    const s = await load(tf);
    console.log(
      `${s.timeframe}: ${s.count} bars | ${s.firstOpen} .. ${s.lastClose} | gaps=${s.gaps}`
    );
  }
  console.log("\nSmoke check passed.");
}

main().catch((err) => {
  console.error(`smoke-btcusd-dataset failed: ${err.message}`);
  process.exitCode = 1;
});

