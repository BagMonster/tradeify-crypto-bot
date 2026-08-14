import test from "node:test";
import assert from "node:assert/strict";
import {
  INDICATOR_WARMUP_REQUIREMENTS,
  assessIndicatorReadiness,
  calculateAdx,
  calculateAtr,
  calculateBollingerBands,
  calculateIndicatorSnapshot,
  calculateRsi,
  refreshStoredIndicatorSnapshot
} from "../src/indicators.js";

const STRATEGY = Object.freeze({
  signal: Object.freeze({
    bbPeriod: 20,
    bbStdDev: 2,
    rsiPeriod: 14,
    atrPeriod: 14
  }),
  regime: Object.freeze({ adxPeriod: 14 })
});

const INTERVAL_MS = Object.freeze({
  "15m": 15 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000
});

function bars(timeframe, count, {
  source = "binance",
  symbol = "BTCUSDT",
  startTime = Date.parse("2026-01-01T00:00:00.000Z"),
  startPrice = 50_000,
  step = 1
} = {}) {
  const intervalMs = INTERVAL_MS[timeframe];
  return Array.from({ length: count }, (_, index) => {
    const close = startPrice + (index * step);
    const openTime = startTime + (index * intervalMs);
    return {
      source,
      symbol,
      timeframe,
      openTime: new Date(openTime).toISOString(),
      closeTime: new Date(openTime + intervalMs).toISOString(),
      open: close - 0.25,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume: 100 + index,
      isClosed: true
    };
  });
}

function warmBars() {
  return {
    bars15m: bars("15m", INDICATOR_WARMUP_REQUIREMENTS["15m"]),
    bars4h: bars("4h", INDICATOR_WARMUP_REQUIREMENTS["4h"]),
    bars1d: bars("1d", INDICATOR_WARMUP_REQUIREMENTS["1d"])
  };
}

test("1 - Bollinger Bands use a population deviation over the configured window", () => {
  const result = calculateBollingerBands([1, 2, 3, 4, 5], {
    period: 5,
    stdDevMultiplier: 2
  });

  assert.equal(result.middle, 3);
  assert.equal(result.standardDeviation, Math.sqrt(2));
  assert.equal(result.upper, 3 + (2 * Math.sqrt(2)));
  assert.equal(result.lower, 3 - (2 * Math.sqrt(2)));
  assert.equal(result.latestClose, 5);
});

test("2 - Wilder RSI handles rising, falling, and flat completed closes", () => {
  const rising = Array.from({ length: 15 }, (_, index) => 100 + index);
  const falling = Array.from({ length: 15 }, (_, index) => 100 - index);
  const flat = Array(15).fill(100);

  assert.equal(calculateRsi(rising, { period: 14 }).value, 100);
  assert.equal(calculateRsi(falling, { period: 14 }).value, 0);
  assert.equal(calculateRsi(flat, { period: 14 }).value, 50);
});

test("3 - Wilder ATR uses true range and reports its percentage of close", () => {
  const input = bars("15m", 4, { startPrice: 100, step: 0.5 });
  const result = calculateAtr(input, { period: 3, timeframe: "15m" });

  assert.equal(result.value, 1);
  assert.equal(result.latestClose, 101.5);
  assert.equal(result.percentOfClose, 1 / 101.5);
});

test("4 - Wilder ADX reports a strong one-direction trend", () => {
  const result = calculateAdx(bars("4h", 40, { startPrice: 100, step: 1 }), {
    period: 14,
    timeframe: "4h"
  });

  assert.equal(result.value, 100);
  assert.ok(result.plusDi > 0);
  assert.equal(result.minusDi, 0);
});

test("5 - readiness enforces at least 50 15m, 40 4h, and 25 daily bars", () => {
  const ready = assessIndicatorReadiness({ "15m": 50, "4h": 40, "1d": 25 }, STRATEGY);
  assert.equal(ready.warm, true);
  assert.deepEqual(ready.required, { "15m": 50, "4h": 40, "1d": 25 });
  assert.deepEqual(ready.missing, {});

  const cold = assessIndicatorReadiness({ "15m": 49, "4h": 38, "1d": 20 }, STRATEGY);
  assert.equal(cold.warm, false);
  assert.deepEqual(cold.missing, { "15m": 1, "4h": 2, "1d": 5 });
});

test("6 - a warm snapshot calculates all configured timeframe indicators", () => {
  const snapshot = calculateIndicatorSnapshot({ ...warmBars(), strategy: STRATEGY });

  assert.equal(snapshot.warm, true);
  assert.equal(snapshot.source, "binance");
  assert.equal(snapshot.symbol, "BTCUSDT");
  assert.equal(snapshot.bollinger15m.period, 20);
  assert.equal(snapshot.rsi15m.period, 14);
  assert.equal(snapshot.atr15m.timeframe, "15m");
  assert.equal(snapshot.adx4h.timeframe, "4h");
  assert.equal(snapshot.atr1d.timeframe, "1d");
  assert.match(snapshot.asOf["15m"], /Z$/);
});

test("7 - insufficient history returns cold without partial indicator values", () => {
  const input = warmBars();
  input.bars15m.pop();
  const snapshot = calculateIndicatorSnapshot({ ...input, strategy: STRATEGY });

  assert.equal(snapshot.warm, false);
  assert.deepEqual(snapshot.missing, { "15m": 1 });
  assert.equal(snapshot.bollinger15m, null);
  assert.equal(snapshot.rsi15m, null);
  assert.equal(snapshot.atr15m, null);
  assert.equal(snapshot.adx4h, null);
  assert.equal(snapshot.atr1d, null);
});

test("8 - incomplete, mixed, missing, duplicate, and misaligned bars are rejected", () => {
  const cases = [];

  const incomplete = warmBars();
  incomplete.bars15m[10] = { ...incomplete.bars15m[10], isClosed: false };
  cases.push(incomplete);

  const mixed = warmBars();
  mixed.bars4h[10] = { ...mixed.bars4h[10], source: "dxtrade" };
  cases.push(mixed);

  const gap = warmBars();
  gap.bars1d[10] = {
    ...gap.bars1d[10],
    openTime: gap.bars1d[11].openTime,
    closeTime: gap.bars1d[11].closeTime
  };
  cases.push(gap);

  const misaligned = warmBars();
  misaligned.bars15m[0] = {
    ...misaligned.bars15m[0],
    openTime: "2026-01-01T00:00:01.000Z",
    closeTime: "2026-01-01T00:15:01.000Z"
  };
  cases.push(misaligned);

  for (const input of cases) {
    assert.throws(() => calculateIndicatorSnapshot({ ...input, strategy: STRATEGY }));
  }
});

test("9 - stored refresh fails closed, reads exact windows, and persists warm only after calculation", async () => {
  const input = warmBars();
  const warmStates = [];
  const reads = [];
  const database = {
    async setIndicatorsWarm(warm) {
      warmStates.push(warm);
      return warm;
    },
    async getBarCounts() {
      return { "15m": 35_040, "4h": 2_190, "1d": 365 };
    },
    async getBars(request) {
      reads.push(request);
      if (request.timeframe === "15m") return input.bars15m;
      if (request.timeframe === "4h") return input.bars4h;
      return input.bars1d;
    }
  };

  const snapshot = await refreshStoredIndicatorSnapshot({ database, strategy: STRATEGY });

  assert.equal(snapshot.warm, true);
  assert.deepEqual(warmStates, [false, true]);
  assert.deepEqual(reads.map(({ source, symbol, timeframe, limit }) => ({
    source,
    symbol,
    timeframe,
    limit
  })), [
    { source: "binance", symbol: "BTCUSDT", timeframe: "15m", limit: 50 },
    { source: "binance", symbol: "BTCUSDT", timeframe: "4h", limit: 40 },
    { source: "binance", symbol: "BTCUSDT", timeframe: "1d", limit: 25 }
  ]);
});

test("10 - stored refresh remains cold and avoids reads when counts are insufficient", async () => {
  const warmStates = [];
  let reads = 0;
  const database = {
    async setIndicatorsWarm(warm) {
      warmStates.push(warm);
      return warm;
    },
    async getBarCounts() {
      return { "15m": 49, "4h": 40, "1d": 25 };
    },
    async getBars() {
      reads += 1;
      return [];
    }
  };

  const snapshot = await refreshStoredIndicatorSnapshot({ database, strategy: STRATEGY });

  assert.equal(snapshot.warm, false);
  assert.deepEqual(snapshot.missing, { "15m": 1 });
  assert.deepEqual(warmStates, [false]);
  assert.equal(reads, 0);
});
