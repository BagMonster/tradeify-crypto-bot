import test from "node:test";
import assert from "node:assert/strict";
import {
  SIGNAL_STRATEGY_ID,
  evaluateMeanReversion,
  requiredWarmupCounts
} from "../src/research/strategies/meanReversion.js";

const STRATEGY = Object.freeze({
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

const INTERVAL_15M = 15 * 60 * 1000;
const INTERVAL_4H = 4 * 60 * 60 * 1000;
const INTERVAL_1D = 24 * 60 * 60 * 1000;
const START = Date.parse("2025-01-01T00:00:00.000Z");
const BASE = 50000;
const AMPLITUDE = 900;

function makeBars(timeframe, count, intervalMs, priceFn) {
  return Array.from({ length: count }, (_, index) => {
    const openTime = START + (index * intervalMs);
    const close = priceFn(index);
    const open = priceFn(index > 0 ? index - 1 : index);
    const high = Math.max(open, close) + (Math.abs(close) * 0.0005);
    const low = Math.min(open, close) - (Math.abs(close) * 0.0005);
    return {
      source: "binance",
      symbol: "BTCUSDT",
      timeframe,
      openTime: new Date(openTime).toISOString(),
      closeTime: new Date(openTime + intervalMs).toISOString(),
      open,
      high,
      low,
      close,
      volume: 100 + index,
      isClosed: true
    };
  });
}

/**
 * ~26 days of a mildly oscillating price (keeps daily ATR% and 4h-equivalent
 * ADX inside the RANGE-permitting band), with the final two 15m bars
 * overridden to a clean upper-band breach-and-reclaim at an elevated RSI —
 * numerically tuned against the real adapter until it produced a genuine
 * SHORT candidate, not hand-derived.
 */
function buildFiringDataset({ total15m = 2500, overrides = {} } = {}) {
  const oscillate = (index) => BASE + (AMPLITUDE * Math.sin(index / 6));
  const price15m = (index) => overrides[index] ?? oscillate(index);

  const bars15m = makeBars("15m", total15m, INTERVAL_15M, price15m);
  const bars4h = makeBars(
    "4h",
    Math.ceil((total15m * INTERVAL_15M) / INTERVAL_4H) + 2,
    INTERVAL_4H,
    (index) => BASE + (AMPLITUDE * Math.sin((index * (INTERVAL_4H / INTERVAL_15M)) / 6))
  );
  const bars1d = makeBars(
    "1d",
    Math.ceil((total15m * INTERVAL_15M) / INTERVAL_1D) + 2,
    INTERVAL_1D,
    (index) => BASE + (AMPLITUDE * Math.sin((index * (INTERVAL_1D / INTERVAL_15M)) / 6))
  );
  return { bars15m, bars4h, bars1d };
}

function firingDataset() {
  const total15m = 2500;
  return buildFiringDataset({
    total15m,
    overrides: { [total15m - 2]: 51700, [total15m - 1]: 51550 }
  });
}

test("1 - requiredWarmupCounts matches production's assessIndicatorReadiness formula", () => {
  assert.deepEqual(requiredWarmupCounts(STRATEGY), { "15m": 50, "4h": 40, "1d": 25 });
});

test("2 - decisionIndex must be an integer of at least 1", () => {
  const { bars15m, bars4h, bars1d } = firingDataset();
  for (const decisionIndex of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => evaluateMeanReversion({ bars15m, bars4h, bars1d, decisionIndex, strategy: STRATEGY }),
      /decisionIndex must be an integer/
    );
  }
});

test("3 - insufficient causal history returns INDICATORS_COLD, never a partial candidate", () => {
  const { bars4h, bars1d } = firingDataset();
  const shortBars15m = makeBars("15m", 3, INTERVAL_15M, (index) => BASE + index);
  const result = evaluateMeanReversion({
    bars15m: shortBars15m,
    bars4h,
    bars1d,
    decisionIndex: 1,
    strategy: STRATEGY
  });
  assert.equal(result.status, "NO_SIGNAL");
  assert.equal(result.reasonCode, "INDICATORS_COLD");
});

test("4 - a genuine upper-band breach-and-reclaim at elevated RSI produces a real SHORT candidate", () => {
  const { bars15m, bars4h, bars1d } = firingDataset();
  const decisionIndex = bars15m.length - 1;

  const result = evaluateMeanReversion({ bars15m, bars4h, bars1d, decisionIndex, strategy: STRATEGY });

  assert.equal(result.status, "CANDIDATE");
  assert.equal(result.strategyId, SIGNAL_STRATEGY_ID);
  assert.equal(result.direction, "SHORT");
  assert.equal(result.source, "binance");
  assert.equal(result.symbol, "BTCUSDT");
  assert.equal(result.asOf, bars15m[decisionIndex].closeTime);
  assert.equal(result.entryReference, bars15m[decisionIndex].close);
  assert.equal(result.timeStopBars, STRATEGY.signal.timeStopBars);
  assert.equal(result.regime.allowed, true);
  assert.equal(result.regime.classification, "RANGE");
  assert.ok(result.stopReference > result.entryReference, "a SHORT stop sits above entry");
  assert.ok(result.targetReference < result.entryReference, "a SHORT target sits below entry");
});

test("5 - bars after decisionIndex never influence the result (no lookahead)", () => {
  const { bars15m, bars4h, bars1d } = firingDataset();
  const decisionIndex = bars15m.length - 1;
  const baseline = evaluateMeanReversion({ bars15m, bars4h, bars1d, decisionIndex, strategy: STRATEGY });

  const extended15m = [
    ...bars15m,
    ...makeBars("15m", 10, INTERVAL_15M, (index) => 999_999 + index).map((bar, offset) => ({
      ...bar,
      openTime: new Date(
        Date.parse(bars15m.at(-1).closeTime) + (offset * INTERVAL_15M)
      ).toISOString(),
      closeTime: new Date(
        Date.parse(bars15m.at(-1).closeTime) + ((offset + 1) * INTERVAL_15M)
      ).toISOString()
    }))
  ];
  const withFuture = evaluateMeanReversion({
    bars15m: extended15m,
    bars4h,
    bars1d,
    decisionIndex,
    strategy: STRATEGY
  });

  assert.deepEqual(withFuture, baseline);
});

test("6 - history far older than the required trailing window never influences the result", () => {
  const { bars15m, bars4h, bars1d } = firingDataset();
  const decisionIndex = bars15m.length - 1;
  const baseline = evaluateMeanReversion({ bars15m, bars4h, bars1d, decisionIndex, strategy: STRATEGY });

  const extraPast15m = makeBars("15m", 2000, INTERVAL_15M, (index) => BASE + (index % 7));
  const shiftMs = Date.parse(bars15m[0].openTime) - Date.parse(extraPast15m.at(-1).closeTime);
  const shiftedPast15m = extraPast15m.map((bar) => ({
    ...bar,
    openTime: new Date(Date.parse(bar.openTime) + shiftMs).toISOString(),
    closeTime: new Date(Date.parse(bar.closeTime) + shiftMs).toISOString()
  }));
  const withDeepHistory = evaluateMeanReversion({
    bars15m: [...shiftedPast15m, ...bars15m],
    bars4h,
    bars1d,
    decisionIndex: shiftedPast15m.length + decisionIndex,
    strategy: STRATEGY
  });

  assert.deepEqual(withDeepHistory, baseline);
});
