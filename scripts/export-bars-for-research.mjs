#!/usr/bin/env node
/**
 * scripts/export-bars-for-research.mjs
 *
 * NOT part of src/research/. NOT imported by any research module, and NOT
 * imported by index.mjs. This is a one-off, owner-run bridge tool: Chapter
 * 26's own code is barred from making network calls, writing to Postgres,
 * or reading secrets (see claude/chapter-26-step-26-1-freeze-contract.md
 * Section 12), so scripts/run-backtest.mjs cannot reach Railway's Postgres
 * directly. This script is the one piece that is allowed to - it connects
 * with the OWNER's own DATABASE_URL (never checked into git, read the same
 * way src/config.js reads it: via dotenv from a local .env file that
 * .gitignore already excludes), reads the completed bars already stored by
 * the running bot, and writes them to local JSON files that
 * scripts/run-backtest.mjs then reads with zero network/DB access of its
 * own.
 *
 * Usage (from the repository root, with a real .env present):
 *   node scripts/export-bars-for-research.mjs
 *
 * Output:
 *   artifacts/research-bars/15m.json
 *   artifacts/research-bars/4h.json
 *   artifacts/research-bars/1d.json
 *
 * artifacts/ is already gitignored (see .gitignore) - these files are
 * local research inputs, never committed.
 */

import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { normalizeBar } from "../src/database.js";
import { EXPECTED_SOURCE, EXPECTED_SYMBOL } from "../src/research/manifest.js";

const { Pool } = pg;

const TIMEFRAMES = Object.freeze(["15m", "4h", "1d"]);
const OUTPUT_DIR = path.resolve("artifacts", "research-bars");

function requireDatabaseUrl() {
  const value = process.env.DATABASE_URL;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      "DATABASE_URL is required (set it in your local .env - the same value Railway injects for the bot)"
    );
  }
  return value.trim();
}

function parseDatabaseSsl() {
  const value = process.env.DATABASE_SSL;
  if (value === undefined || value === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("DATABASE_SSL must be true or false");
}

/**
 * Same shape src/database.js's internal (unexported) normalizeStoredBar
 * produces, built from the same exported normalizeBar validator so this
 * script never re-implements bar validation on its own.
 */
function normalizeRow(row) {
  const bar = normalizeBar({
    source: row.source,
    symbol: row.symbol,
    timeframe: row.timeframe,
    openTime: row.open_time,
    closeTime: row.close_time,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    isClosed: row.is_closed
  });
  return Object.freeze({
    source: bar.source,
    symbol: bar.symbol,
    timeframe: bar.timeframe,
    openTime: bar.openTime.toISOString(),
    closeTime: bar.closeTime.toISOString(),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    isClosed: true
  });
}

async function exportTimeframe(pool, timeframe) {
  const result = await pool.query(
    `SELECT source, symbol, timeframe, open_time, close_time,
            open, high, low, close, volume, is_closed
       FROM bars
      WHERE source = $1 AND symbol = $2 AND timeframe = $3 AND is_closed = TRUE
      ORDER BY open_time ASC`,
    [EXPECTED_SOURCE, EXPECTED_SYMBOL, timeframe]
  );
  return result.rows.map(normalizeRow);
}

async function main() {
  const databaseUrl = requireDatabaseUrl();
  const databaseSsl = parseDatabaseSsl();

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseSsl ? { rejectUnauthorized: false } : undefined,
    max: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  try {
    await mkdir(OUTPUT_DIR, { recursive: true });

    for (const timeframe of TIMEFRAMES) {
      const bars = await exportTimeframe(pool, timeframe);
      const outputPath = path.join(OUTPUT_DIR, `${timeframe}.json`);
      await writeFile(outputPath, `${JSON.stringify(bars)}\n`, "utf8");

      if (bars.length === 0) {
        console.log(`${timeframe}: 0 bars written to ${outputPath}`);
      } else {
        console.log(
          `${timeframe}: ${bars.length} bars written to ${outputPath} ` +
          `(${bars[0].openTime} .. ${bars[bars.length - 1].closeTime})`
        );
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`export-bars-for-research failed: ${error.message}`);
  process.exitCode = 1;
});
