import test from "node:test";
import assert from "node:assert/strict";
import {
  BINANCE_BACKFILL_INTERVAL_MS,
  backfillBinanceHistory,
  createBinanceBackfillClient,
  normalizeBinanceKline
} from "../src/binanceBackfill.js";

const SERVER_TIME = Date.parse("2026-08-14T12:34:56.789Z");

function rawKline(openTime, timeframe = "15m", overrides = {}) {
  const intervalMs = BINANCE_BACKFILL_INTERVAL_MS[timeframe];
  const row = [
    openTime,
    "65000.10",
    "65100.20",
    "64900.30",
    "65050.40",
    "123.456",
    openTime + intervalMs - 1,
    "8000000.00",
    1000,
    "60.00",
    "3900000.00",
    "0"
  ];
  for (const [index, value] of Object.entries(overrides)) row[Number(index)] = value;
  return row;
}

function jsonResponse(payload, status = 200, contentLength = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name === "content-length" ? contentLength : null },
    async json() {
      return payload;
    }
  };
}

function coverageFromBars(bars, request) {
  const matching = bars
    .filter((bar) => bar.source === request.source &&
      bar.symbol === request.symbol &&
      bar.timeframe === request.timeframe &&
      Date.parse(bar.openTime) >= request.startTime &&
      Date.parse(bar.closeTime) <= request.endTimeExclusive)
    .sort((left, right) => Date.parse(left.openTime) - Date.parse(right.openTime));
  return {
    count: matching.length,
    firstOpenTime: matching.length === 0 ? null : matching[0].openTime,
    lastCloseTime: matching.length === 0 ? null : matching.at(-1).closeTime
  };
}

test("1 - converts one completed Binance kline to the stored UTC bar contract", () => {
  const openTime = Date.parse("2026-08-14T10:00:00.000Z");
  const bar = normalizeBinanceKline(rawKline(openTime), {
    timeframe: "15m",
    completedThrough: openTime + BINANCE_BACKFILL_INTERVAL_MS["15m"]
  });

  assert.deepEqual(bar, {
    source: "binance",
    symbol: "BTCUSDT",
    timeframe: "15m",
    openTime: "2026-08-14T10:00:00.000Z",
    closeTime: "2026-08-14T10:15:00.000Z",
    open: 65000.1,
    high: 65100.2,
    low: 64900.3,
    close: 65050.4,
    volume: 123.456,
    isClosed: true
  });
});

test("2 - rejects malformed, misaligned, impossible, and incomplete Binance klines", () => {
  const openTime = Date.parse("2026-08-14T10:00:00.000Z");
  const completedThrough = openTime + BINANCE_BACKFILL_INTERVAL_MS["15m"];
  const invalidRows = [
    rawKline(openTime).slice(0, 11),
    rawKline(openTime + 1),
    rawKline(openTime, "15m", { 6: completedThrough - 2 }),
    rawKline(openTime, "15m", { 2: "64000" }),
    rawKline(openTime, "15m", { 5: "-1" })
  ];
  for (const row of invalidRows) {
    assert.throws(() => normalizeBinanceKline(row, { timeframe: "15m", completedThrough }));
  }
  assert.throws(() => normalizeBinanceKline(rawKline(openTime), {
    timeframe: "15m",
    completedThrough: completedThrough - 1
  }), /not completed/i);
});

test("3 - client uses only the public market-data host and exact read-only endpoints", async () => {
  const calls = [];
  const openTime = Date.parse("2026-08-14T10:00:00.000Z");
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), options });
    return url.pathname === "/api/v3/time"
      ? jsonResponse({ serverTime: SERVER_TIME })
      : jsonResponse([rawKline(openTime)]);
  };
  const client = createBinanceBackfillClient({ fetchImpl, maxRetries: 0 });

  assert.equal(await client.getServerTime(), SERVER_TIME);
  const rows = await client.getKlines({
    timeframe: "15m",
    startTime: openTime,
    endTimeExclusive: openTime + BINANCE_BACKFILL_INTERVAL_MS["15m"],
    limit: 1
  });

  assert.equal(rows.length, 1);
  assert.deepEqual(calls.map((call) => call.url.origin), [
    "https://data-api.binance.vision",
    "https://data-api.binance.vision"
  ]);
  assert.deepEqual(calls.map((call) => call.url.pathname), ["/api/v3/time", "/api/v3/klines"]);
  assert.equal(calls[1].url.searchParams.get("symbol"), "BTCUSDT");
  assert.equal(calls[1].url.searchParams.get("timeZone"), "0");
  assert.equal(calls[1].url.searchParams.get("endTime"), String(openTime + 899_999));
  assert.deepEqual(calls.map((call) => call.options.method), ["GET", "GET"]);
  assert.equal(calls.some((call) => Object.keys(call.options.headers)
    .some((name) => /authorization|api.?key/i.test(name))), false);
});

test("4 - client retries a transient public-data failure without exposing a response body", async () => {
  let attempts = 0;
  const delays = [];
  const client = createBinanceBackfillClient({
    fetchImpl: async () => ++attempts === 1
      ? jsonResponse({ secretLikeNoise: "must not enter errors" }, 503)
      : jsonResponse({ serverTime: SERVER_TIME }),
    sleepImpl: async (delay) => delays.push(delay),
    maxRetries: 1
  });

  assert.equal(await client.getServerTime(), SERVER_TIME);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [250]);
});

test("5 - a complete exact-range backfill is skipped idempotently", async () => {
  let klineRequests = 0;
  let writes = 0;
  const database = {
    async getBarCoverage(request) {
      const intervalMs = BINANCE_BACKFILL_INTERVAL_MS[request.timeframe];
      return {
        count: (request.endTimeExclusive - request.startTime) / intervalMs,
        firstOpenTime: new Date(request.startTime).toISOString(),
        lastCloseTime: new Date(request.endTimeExclusive).toISOString()
      };
    },
    async upsertBars() {
      writes += 1;
    }
  };
  const client = {
    async getServerTime() { return SERVER_TIME; },
    async getKlines() { klineRequests += 1; return []; }
  };

  const summary = await backfillBinanceHistory({
    database,
    client,
    historyDays: 1,
    logger: { info() {} }
  });

  assert.deepEqual(summary.timeframes.map(({ timeframe, expectedCount, skipped }) => ({
    timeframe,
    expectedCount,
    skipped
  })), [
    { timeframe: "15m", expectedCount: 96, skipped: true },
    { timeframe: "4h", expectedCount: 6, skipped: true },
    { timeframe: "1d", expectedCount: 1, skipped: true }
  ]);
  assert.equal(klineRequests, 0);
  assert.equal(writes, 0);
});

test("6 - backfill pages, stores, and verifies all three completed ranges", async () => {
  const stored = [];
  const requests = [];
  const database = {
    async getBarCoverage(request) {
      return coverageFromBars(stored, request);
    },
    async upsertBars(bars) {
      stored.push(...bars);
      return bars;
    }
  };
  const client = {
    async getServerTime() { return SERVER_TIME; },
    async getKlines(request) {
      requests.push(request);
      const intervalMs = BINANCE_BACKFILL_INTERVAL_MS[request.timeframe];
      const remaining = (request.endTimeExclusive - request.startTime) / intervalMs;
      return Array.from({ length: Math.min(request.limit, remaining) }, (_, index) =>
        rawKline(request.startTime + (index * intervalMs), request.timeframe));
    }
  };

  const summary = await backfillBinanceHistory({
    database,
    client,
    historyDays: 1,
    pageLimit: 17,
    logger: { info() {} }
  });

  assert.equal(stored.length, 103);
  assert.equal(requests.filter(({ timeframe }) => timeframe === "15m").length, 6);
  assert.deepEqual(summary.timeframes.map(({ expectedCount, storedCount, skipped }) => ({
    expectedCount,
    storedCount,
    skipped
  })), [
    { expectedCount: 96, storedCount: 96, skipped: false },
    { expectedCount: 6, storedCount: 6, skipped: false },
    { expectedCount: 1, storedCount: 1, skipped: false }
  ]);
  assert.equal(stored.every((bar) => bar.isClosed && bar.source === "binance" &&
    bar.symbol === "BTCUSDT"), true);
});

test("7 - a missing or duplicate Binance bar stops storage", async () => {
  let writes = 0;
  const database = {
    async getBarCoverage() {
      return { count: 0, firstOpenTime: null, lastCloseTime: null };
    },
    async upsertBars() { writes += 1; }
  };
  const client = {
    async getServerTime() { return SERVER_TIME; },
    async getKlines(request) {
      const intervalMs = BINANCE_BACKFILL_INTERVAL_MS[request.timeframe];
      return [rawKline(request.startTime + intervalMs, request.timeframe)];
    }
  };

  await assert.rejects(backfillBinanceHistory({
    database,
    client,
    historyDays: 1,
    logger: { info() {} }
  }), /missing or duplicate bar/i);
  assert.equal(writes, 0);
});
