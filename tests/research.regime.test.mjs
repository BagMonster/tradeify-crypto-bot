import test from "node:test";
import assert from "node:assert/strict";
import {
  DAILY_REGIME_BURN_IN_BARS,
  REGIME_LABELS,
  calculateDailyRegimeTimeline,
  classifyDailyRegime,
  isRegimeTradable,
  regimeAtDecisionTime,
  routeId
} from "../src/research/regime.js";

const THRESHOLDS = Object.freeze({
  minDailyAtrPct: 0.015,
  maxDailyAtrPct: 0.037,
  adxMax: 25,
  adxStandDown: 30
});

const DAY_MS = 24 * 60 * 60 * 1000;

function dailyBars(count, {
  source = "binance",
  symbol = "BTCUSDT",
  startTime = Date.parse("2025-01-01T00:00:00.000Z"),
  startPrice = 50_000,
  step = 1
} = {}) {
  return Array.from({ length: count }, (_, index) => {
    const close = startPrice + (index * step);
    const openTime = startTime + (index * DAY_MS);
    return {
      source,
      symbol,
      timeframe: "1d",
      openTime: new Date(openTime).toISOString(),
      closeTime: new Date(openTime + DAY_MS).toISOString(),
      open: close - 5,
      high: close + 10,
      low: close - 10,
      close,
      volume: 1000 + index,
      isClosed: true
    };
  });
}

test("1 - classifyDailyRegime labels EXCLUDED_VOL outside the ATR% band, ahead of ADX", () => {
  assert.equal(
    classifyDailyRegime({ dailyAtrPct: 0.01, dailyAdx: 10 }, THRESHOLDS).label,
    REGIME_LABELS.EXCLUDED_VOL
  );
  assert.equal(
    classifyDailyRegime({ dailyAtrPct: 0.05, dailyAdx: 50 }, THRESHOLDS).label,
    REGIME_LABELS.EXCLUDED_VOL
  );
});

test("2 - classifyDailyRegime labels RANGE, TRANSITIONAL, and TREND by the ADX bands", () => {
  assert.equal(
    classifyDailyRegime({ dailyAtrPct: 0.02, dailyAdx: 25 }, THRESHOLDS).label,
    REGIME_LABELS.RANGE
  );
  assert.equal(
    classifyDailyRegime({ dailyAtrPct: 0.02, dailyAdx: 25.1 }, THRESHOLDS).label,
    REGIME_LABELS.TRANSITIONAL
  );
  assert.equal(
    classifyDailyRegime({ dailyAtrPct: 0.02, dailyAdx: 30 }, THRESHOLDS).label,
    REGIME_LABELS.TRANSITIONAL
  );
  assert.equal(
    classifyDailyRegime({ dailyAtrPct: 0.02, dailyAdx: 30.1 }, THRESHOLDS).label,
    REGIME_LABELS.TREND
  );
});

test("3 - only RANGE and TREND are tradable regimes", () => {
  assert.equal(isRegimeTradable(REGIME_LABELS.RANGE), true);
  assert.equal(isRegimeTradable(REGIME_LABELS.TREND), true);
  assert.equal(isRegimeTradable(REGIME_LABELS.EXCLUDED_VOL), false);
  assert.equal(isRegimeTradable(REGIME_LABELS.TRANSITIONAL), false);
});

test("4 - calculateDailyRegimeTimeline requires at least the 40-bar D-013 burn-in", () => {
  assert.throws(
    () => calculateDailyRegimeTimeline(dailyBars(39), { thresholds: THRESHOLDS }),
    /at least 40/
  );
  const timeline = calculateDailyRegimeTimeline(dailyBars(40), { thresholds: THRESHOLDS });
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].closeTime, dailyBars(40).at(-1).closeTime);
});

test("5 - the timeline produces one causal entry per bar from the 40th onward", () => {
  const bars = dailyBars(45);
  const timeline = calculateDailyRegimeTimeline(bars, { thresholds: THRESHOLDS });
  assert.equal(timeline.length, 6);
  assert.equal(timeline[0].closeTime, bars[39].closeTime);
  assert.equal(timeline.at(-1).closeTime, bars[44].closeTime);
  for (const entry of timeline) {
    assert.ok(Object.values(REGIME_LABELS).includes(entry.label));
    assert.equal(typeof entry.dailyAtrPct, "number");
    assert.equal(typeof entry.dailyAdx, "number");
  }
});

test("6 - a strong steady uptrend on daily bars classifies as TREND once ADX converges", () => {
  const bars = dailyBars(60, { step: 8000 });
  const timeline = calculateDailyRegimeTimeline(bars, { thresholds: THRESHOLDS });
  assert.equal(timeline.at(-1).label, REGIME_LABELS.TREND);
});

test("7 - regimeAtDecisionTime returns the most recent daily bar at or before the decision time", () => {
  const bars = dailyBars(42);
  const timeline = calculateDailyRegimeTimeline(bars, { thresholds: THRESHOLDS });

  const exact = regimeAtDecisionTime(timeline, timeline[1].closeTimeMs);
  assert.equal(exact.closeTimeMs, timeline[1].closeTimeMs);

  const between = regimeAtDecisionTime(timeline, timeline[1].closeTimeMs + (60 * 60 * 1000));
  assert.equal(between.closeTimeMs, timeline[1].closeTimeMs);

  const before = regimeAtDecisionTime(timeline, timeline[0].closeTimeMs - 1);
  assert.equal(before, null);
});

test("8 - routeId only forms a route for RANGE or TREND regimes, LONG or SHORT", () => {
  const route = routeId({ strategy: "donchian", direction: "LONG", regimeLabel: REGIME_LABELS.TREND });
  assert.equal(route.id, "donchian:LONG:TREND");

  assert.throws(
    () => routeId({ strategy: "donchian", direction: "LONG", regimeLabel: REGIME_LABELS.EXCLUDED_VOL }),
    /RANGE or TREND/
  );
  assert.throws(
    () => routeId({ strategy: "donchian", direction: "LONG", regimeLabel: REGIME_LABELS.TRANSITIONAL }),
    /RANGE or TREND/
  );
  assert.throws(
    () => routeId({ strategy: "donchian", direction: "SIDEWAYS", regimeLabel: REGIME_LABELS.RANGE }),
    /LONG or SHORT/
  );
  assert.throws(
    () => routeId({ strategy: "", direction: "LONG", regimeLabel: REGIME_LABELS.RANGE }),
    /non-empty string/
  );
});

test("9 - classifyDailyRegime and thresholds reject malformed input", () => {
  assert.throws(
    () => classifyDailyRegime({ dailyAtrPct: Number.NaN, dailyAdx: 10 }, THRESHOLDS),
    /finite number/
  );
  assert.throws(
    () => classifyDailyRegime({ dailyAtrPct: 0.02, dailyAdx: 10 }, {
      ...THRESHOLDS,
      maxDailyAtrPct: 0.01
    }),
    /maxDailyAtrPct must exceed/
  );
  assert.throws(
    () => classifyDailyRegime({ dailyAtrPct: 0.02, dailyAdx: 10 }, {
      ...THRESHOLDS,
      adxStandDown: 20
    }),
    /adxStandDown must exceed/
  );
});
