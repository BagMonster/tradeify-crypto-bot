import test from "node:test";
import assert from "node:assert/strict";
import {
  INDICATOR_WARMUP_REQUIREMENTS,
  assessIndicatorReadiness,
  bollingerBandwidthPercentile,
  donchianChannel,
  ema,
  timeSeriesMomentum
} from "../src/indicators.js";

const INTERVAL_15M = 15 * 60 * 1000;
const START = Date.parse("2025-06-02T00:00:00.000Z");

function makeBars(count, ohlcFn) {
  return Array.from({ length: count }, (_, index) => {
    const openMs = START + (index * INTERVAL_15M);
    const { open, high, low, close } = ohlcFn(index);
    return {
      source: "binance",
      symbol: "BTCUSDT",
      timeframe: "15m",
      openTime: new Date(openMs).toISOString(),
      closeTime: new Date(openMs + INTERVAL_15M).toISOString(),
      open,
      high,
      low,
      close,
      isClosed: true
    };
  });
}

const STRATEGY = Object.freeze({
  instruments: Object.freeze({ "BTC/USD": Object.freeze({ enabled: true }) }),
  signal: Object.freeze({
    bbPeriod: 20,
    bbStdDev: 2,
    rsiPeriod: 14,
    rsiLongThreshold: 32,
    rsiShortThreshold: 68,
    requireCloseInsideBand: true,
    atrPeriod: 14,
    stopAtrMultiple: 1.5,
    timeStopBars: 24
  }),
  regime: Object.freeze({
    minDailyAtrPct: 0.015,
    maxDailyAtrPct: 0.037,
    adxPeriod: 14,
    adxMax: 25,
    adxStandDown: 30,
    rangeBandStdDev: 2.5
  })
});

test("1 - Outcome check #3: assessIndicatorReadiness is unchanged for a fixed input", () => {
  const result = assessIndicatorReadiness({ "15m": 60, "4h": 45, "1d": 30 }, STRATEGY);
  assert.deepEqual(result, {
    warm: true,
    counts: { "15m": 60, "4h": 45, "1d": 30 },
    required: { "15m": 50, "4h": 40, "1d": 25 },
    missing: {}
  });
  assert.deepEqual(INDICATOR_WARMUP_REQUIREMENTS, { "15m": 50, "4h": 40, "1d": 25 });
});

test("2 - ema seeds from the SMA of the first `period` values, then recurses with alpha = 2/(period+1)", () => {
  const values = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
  const result = ema(values, 5);
  assert.equal(result.period, 5);
  assert.ok(Math.abs(result.alpha - (2 / 6)) < 1e-12);
  assert.equal(result.values.length, values.length);
  assert.deepEqual(result.values.slice(0, 4), [null, null, null, null]);
  const seed = (10 + 11 + 12 + 13 + 14) / 5; // 12
  assert.ok(Math.abs(result.values[4] - seed) < 1e-12);
  let expected = seed;
  for (let index = 5; index < values.length; index += 1) {
    expected += (values[index] - expected) * (2 / 6);
    assert.ok(Math.abs(result.values[index] - expected) < 1e-9, `index ${index}`);
  }
});

test("3 - ema requires at least `period` values", () => {
  assert.throws(() => ema([1, 2, 3], 5), /values must contain at least 5 values/);
  assert.throws(() => ema([1, 2, 3], 0), /period must be a positive integer/);
});

test("4 - donchianChannel reads the highest high and lowest low of the trailing window", () => {
  const bars = makeBars(25, (index) => {
    const close = 50000 + (index % 5 === 0 ? 200 : -50); // one high spike every 5 bars
    return { open: close, high: close + 10, low: close - 10, close };
  });
  const channel = donchianChannel(bars.slice(0, 20), 20);
  assert.equal(channel.period, 20);
  const window = bars.slice(0, 20);
  assert.equal(channel.highestHigh, Math.max(...window.map((bar) => bar.high)));
  assert.equal(channel.lowestLow, Math.min(...window.map((bar) => bar.low)));
});

test("5 - donchianChannel requires at least `period` bars and rejects the wrong timeframe", () => {
  const bars = makeBars(5, (index) => ({ open: 50000, high: 50010, low: 49990, close: 50000 }));
  assert.throws(() => donchianChannel(bars, 20), /15m bars must contain at least 20 values/);
  const wrongTimeframe = bars.map((bar) => ({ ...bar, timeframe: "4h" }));
  assert.throws(() => donchianChannel(wrongTimeframe, 5), /wrong timeframe/);
});

test("6 - timeSeriesMomentum computes sign(close[t] - close[t-lookback])", () => {
  const closes = Array.from({ length: 100 }, (_, index) => 50000 + index);
  const up = timeSeriesMomentum(closes, 96);
  assert.equal(up.direction, "LONG");
  assert.equal(up.change, 96);

  const flatCloses = Array.from({ length: 100 }, () => 50000);
  const flat = timeSeriesMomentum(flatCloses, 96);
  assert.equal(flat.direction, "FLAT");
  assert.equal(flat.change, 0);

  const downCloses = Array.from({ length: 100 }, (_, index) => 50000 - index);
  const down = timeSeriesMomentum(downCloses, 96);
  assert.equal(down.direction, "SHORT");
  assert.equal(down.change, -96);
});

test("7 - timeSeriesMomentum requires at least lookback + 1 values", () => {
  assert.throws(() => timeSeriesMomentum([1, 2, 3], 96), /closes must contain at least 97 values/);
});

test("8 - bollingerBandwidthPercentile uses nearest-rank on the trailing window", () => {
  const bandwidths = Array.from({ length: 10 }, (_, index) => index + 1); // [1..10]
  assert.equal(bollingerBandwidthPercentile(bandwidths, 10, 20).value, 2);
  assert.equal(bollingerBandwidthPercentile(bandwidths, 10, 40).value, 4);
  assert.equal(bollingerBandwidthPercentile(bandwidths, 10, 100).value, 10);
  assert.equal(bollingerBandwidthPercentile(bandwidths, 10, 0).value, 1);
});

test("9 - bollingerBandwidthPercentile only reads the trailing `window` values", () => {
  const bandwidths = [...Array.from({ length: 50 }, () => 999), 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const result = bollingerBandwidthPercentile(bandwidths, 10, 20);
  assert.equal(result.value, 2, "must ignore the 50 leading values outside the trailing window");
});

test("10 - bollingerBandwidthPercentile rejects negative bandwidths and an out-of-range percentile", () => {
  assert.throws(() => bollingerBandwidthPercentile([-1, 2, 3], 3, 50), /must be non-negative/);
  assert.throws(() => bollingerBandwidthPercentile([1, 2, 3], 3, 150), /percentile must be between 0 and 100/);
  assert.throws(() => bollingerBandwidthPercentile([1, 2], 3, 50), /must contain at least 3 values/);
});
