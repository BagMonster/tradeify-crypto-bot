#!/usr/bin/env node
// scripts/research/fetch-binance-bars.mjs
//
// Research-only. No broker, credentials, or DXtrade access.
// Downloads official Binance spot bulk archives from data.binance.vision and
// writes one audited CSV per symbol. SOL is always written to the refetch path
// so the known-good calibration file can never be overwritten.
//
// Usage:
//   node scripts/research/fetch-binance-bars.mjs
//   node scripts/research/fetch-binance-bars.mjs --symbols DOGE,PEPE --start 2024-01-01
//   node --max-old-space-size=8192 scripts/research/fetch-binance-bars.mjs --symbols PEPE

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BASE = "https://data.binance.vision/data/spot";
const HEADER = "timestamp_utc,open,high,low,close,volume,symbol,source";
const SOURCE = "binance-spot";
const MAX_UNZIP_BUFFER = 64 * 1024 * 1024;

const DEFAULT_SYMBOLS = [
  "SOL", "DOGE", "PEPE", "INJ", "RUNE",
  "AVAX", "SUI", "AAVE", "ZEC", "FARTCOIN", "HYPE"
];

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const SYMBOLS = arg("symbols", DEFAULT_SYMBOLS.join(","))
  .split(",")
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean);
const INTERVAL = arg("interval", "5m");
const START_TEXT = arg("start", "2023-01-01");
const END_TEXT = arg("end", "2026-08-21");
const START = Date.parse(`${START_TEXT}T00:00:00Z`);
const END = Date.parse(`${END_TEXT}T23:55:00Z`);
const OUT_ROOT = arg("out", "artifacts");
const DELAY_MS = Number(arg("delay", "50"));

const INTERVAL_MS = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "1d": 86_400_000
}[INTERVAL];

if (!INTERVAL_MS) throw new Error(`Unsupported interval: ${INTERVAL}`);
if (!Number.isFinite(START) || !Number.isFinite(END) || END < START) {
  throw new Error(`Invalid UTC date range: ${START_TEXT} through ${END_TEXT}`);
}
if (!Number.isFinite(DELAY_MS) || DELAY_MS < 0) throw new Error("delay must be a non-negative number");
if (SYMBOLS.length === 0) throw new Error("At least one symbol is required");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
const datePart = (ms) => iso(ms).slice(0, 10);

function normalizeArchiveTimestamp(raw) {
  let value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid Binance archive timestamp: ${raw}`);
  if (value >= 1e15) value = Math.trunc(value / 1000);
  return value;
}

function archiveTasks(pair) {
  const tasks = [];
  const startDate = new Date(START);
  const endDate = new Date(END);
  let year = startDate.getUTCFullYear();
  let month = startDate.getUTCMonth();
  const endYear = endDate.getUTCFullYear();
  const endMonth = endDate.getUTCMonth();

  while (year < endYear || (year === endYear && month <= endMonth)) {
    const monthStart = Date.UTC(year, month, 1);
    const monthEndExclusive = Date.UTC(year, month + 1, 1);
    const coveredStart = Math.max(START, monthStart);
    const coveredEnd = Math.min(END, monthEndExclusive - INTERVAL_MS);
    const fullMonth = coveredStart === monthStart && coveredEnd === monthEndExclusive - INTERVAL_MS;

    if (fullMonth) {
      const period = `${year.toString().padStart(4, "0")}-${String(month + 1).padStart(2, "0")}`;
      const filename = `${pair}-${INTERVAL}-${period}.zip`;
      tasks.push({ period, url: `${BASE}/monthly/klines/${pair}/${INTERVAL}/${filename}` });
    } else {
      let day = Date.UTC(year, month, new Date(coveredStart).getUTCDate());
      const finalDay = Date.UTC(year, month, new Date(coveredEnd).getUTCDate());
      while (day <= finalDay) {
        const period = datePart(day);
        const filename = `${pair}-${INTERVAL}-${period}.zip`;
        tasks.push({ period, url: `${BASE}/daily/klines/${pair}/${INTERVAL}/${filename}` });
        day += 86_400_000;
      }
    }

    month += 1;
    if (month === 12) {
      year += 1;
      month = 0;
    }
  }

  return tasks;
}

async function fetchArchive(url, { missingAllowed = true, attempts = 4 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "user-agent": "tradeify-candidate-research/1.0" } });
      if (response.status === 404 && missingAllowed) return null;
      if (response.status === 429 || response.status === 418 || response.status >= 500) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempt * 2000;
        lastError = new Error(`HTTP ${response.status} for ${url}`);
        if (attempt < attempts) {
          await sleep(waitMs);
          continue;
        }
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
        throw new Error(`Response is not a ZIP archive: ${url}`);
      }
      return bytes;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(attempt * 2000);
        continue;
      }
    }
  }
  throw lastError ?? new Error(`Download failed: ${url}`);
}

async function unzipCsv(bytes, tempDirectory, sequence) {
  const zipPath = join(tempDirectory, `archive-${sequence}.zip`);
  await writeFile(zipPath, bytes);
  try {
    const { stdout } = await execFileAsync("unzip", ["-p", zipPath], {
      encoding: "utf8",
      maxBuffer: MAX_UNZIP_BUFFER
    });
    return stdout;
  } finally {
    await rm(zipPath, { force: true });
  }
}

function rowsFromCsv(text, pair) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const columns = line.split(",");
    if (!/^\d+$/.test(columns[0] ?? "")) continue;
    if (columns.length < 6) throw new Error(`Malformed ${pair} archive row`);
    const openTime = normalizeArchiveTimestamp(columns[0]);
    if (openTime < START || openTime > END) continue;
    rows.push([iso(openTime), columns[1], columns[2], columns[3], columns[4], columns[5], pair, SOURCE]);
  }
  return rows;
}

function audit(rows) {
  const seen = new Set();
  let duplicates = 0;
  let gaps = 0;
  let ohlcViolations = 0;
  let zeroVolume = 0;
  let longestGapBars = 0;
  let longestGapFrom = null;
  let longestGapTo = null;
  let previous = null;

  for (const row of rows) {
    const timestamp = Date.parse(row[0]);
    if (seen.has(timestamp)) duplicates += 1;
    seen.add(timestamp);
    const [open, high, low, close, volume] = row.slice(1, 6).map(Number);
    if (![open, high, low, close, volume].every(Number.isFinite)) ohlcViolations += 1;
    else if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) ohlcViolations += 1;
    else if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) ohlcViolations += 1;
    if (volume === 0) zeroVolume += 1;

    if (previous !== null && timestamp !== previous + INTERVAL_MS) {
      const missing = Math.round((timestamp - previous) / INTERVAL_MS) - 1;
      if (missing > 0) {
        gaps += 1;
        if (missing > longestGapBars) {
          longestGapBars = missing;
          longestGapFrom = iso(previous);
          longestGapTo = iso(timestamp);
        }
      }
    }
    previous = timestamp;
  }

  return { duplicates, gaps, ohlcViolations, zeroVolume, longestGapBars, longestGapFrom, longestGapTo };
}

async function assertReachable() {
  const pair = "SOLUSDT";
  const url = `${BASE}/daily/klines/${pair}/${INTERVAL}/${pair}-${INTERVAL}-${END_TEXT}.zip`;
  try {
    await fetchArchive(url, { missingAllowed: false });
  } catch (error) {
    console.error(
      `\nCannot reach the official Binance bulk archive at ${BASE}.\n` +
      `This is a network problem, not a symbol problem. Do not interpret any\n` +
      `symbol as unlisted, and do not create a coverage report from this run.\n\n${error.message}\n`
    );
    process.exit(1);
  }
}

async function fetchSymbol(base, tempDirectory) {
  const pair = `${base}USDT`;
  const probeUrl = `${BASE}/daily/klines/${pair}/${INTERVAL}/${pair}-${INTERVAL}-${END_TEXT}.zip`;
  const currentArchive = await fetchArchive(probeUrl);
  if (!currentArchive) return { pair, skipped: `${pair} has no Binance spot ${INTERVAL} archive for ${END_TEXT}` };

  const tasks = archiveTasks(pair);
  const rows = [];
  let firstAvailableArchive = null;
  let missingBeforeListing = 0;
  let sequence = 0;

  for (const task of tasks) {
    sequence += 1;
    process.stderr.write(`\r  ${pair}: archive ${sequence}/${tasks.length} ${task.period}`);
    const bytes = task.url === probeUrl ? currentArchive : await fetchArchive(task.url);
    if (!bytes) {
      if (firstAvailableArchive === null) {
        missingBeforeListing += 1;
        continue;
      }
      throw new Error(`${pair} archive missing after listing began: ${task.url}`);
    }
    if (firstAvailableArchive === null) firstAvailableArchive = task.period;
    const csvText = await unzipCsv(bytes, tempDirectory, sequence);
    rows.push(...rowsFromCsv(csvText, pair));
    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }
  process.stderr.write("\n");

  return { pair, rows, firstAvailableArchive, missingBeforeListing };
}

await assertReachable();
const tempDirectory = await mkdtemp(join(tmpdir(), "tradeify-candidate-bars-"));
const report = [];

try {
  for (const base of SYMBOLS) {
    process.stderr.write(`${base}\n`);
    const result = await fetchSymbol(base, tempDirectory);
    if (result.skipped) {
      process.stderr.write(`  SKIPPED — ${result.skipped}\n\n`);
      report.push({ symbol: base, pair: result.pair, status: "SKIPPED", note: result.skipped });
      continue;
    }

    result.rows.sort((left, right) => Date.parse(left[0]) - Date.parse(right[0]));
    const checks = audit(result.rows);
    const directory = join(OUT_ROOT, `research-bars-${base.toLowerCase()}`);
    const filename = base === "SOL" ? `${INTERVAL}-full-refetch.csv` : `${INTERVAL}-full.csv`;
    const file = join(directory, filename);
    await mkdir(directory, { recursive: true });
    await writeFile(file, `${HEADER}\n${result.rows.map((row) => row.join(",")).join("\n")}\n`, "utf8");

    const first = result.rows[0]?.[0] ?? null;
    const last = result.rows.at(-1)?.[0] ?? null;
    const calendarDays = first && last ? Math.round((Date.parse(last) - Date.parse(first)) / 86_400_000) : 0;
    report.push({
      symbol: base,
      pair: result.pair,
      status: "OK",
      file,
      bars: result.rows.length,
      first,
      last,
      calendarDays,
      tradeableAfter200dWarmup: Math.max(0, calendarDays - 200),
      firstAvailableArchive: result.firstAvailableArchive,
      missingArchivesBeforeListing: result.missingBeforeListing,
      ...checks
    });

    process.stderr.write(`  ${result.rows.length.toLocaleString()} bars, ${first} -> ${last} (${calendarDays} days)\n`);
    process.stderr.write(
      `  dupes ${checks.duplicates}  gaps ${checks.gaps}  ohlc ${checks.ohlcViolations}  ` +
      `zerovol ${checks.zeroVolume}  longest gap ${checks.longestGapBars} bars\n\n`
    );
  }
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}

await mkdir(OUT_ROOT, { recursive: true });
await writeFile(join(OUT_ROOT, "research-bars-coverage.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log("\nsymbol      status   bars       from                  to                    warmup-left  gaps  dupes  ohlc  longest");
console.log("------------------------------------------------------------------------------------------------------------------");
for (const row of report) {
  if (row.status === "SKIPPED") {
    console.log(`${row.symbol.padEnd(11)} SKIPPED  ${row.note}`);
    continue;
  }
  console.log(
    `${row.symbol.padEnd(11)} OK       ${String(row.bars).padEnd(10)} ${row.first.padEnd(21)} ${row.last.padEnd(21)} ` +
    `${String(row.tradeableAfter200dWarmup).padEnd(12)} ${String(row.gaps).padEnd(5)} ` +
    `${String(row.duplicates).padEnd(6)} ${String(row.ohlcViolations).padEnd(5)} ${row.longestGapBars}`
  );
}
console.log(`\nCoverage report: ${join(OUT_ROOT, "research-bars-coverage.json")}`);
