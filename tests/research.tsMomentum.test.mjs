import test from "node:test";
import assert from "node:assert/strict";
import {
  TS_MOMENTUM_STRATEGY_ID,
  checkTsMomentumEmaCrossExit,
  evaluateTsMomentum
} from "../src/research/strategies/tsMomentum.js";

const INTERVAL_15M = 15 * 60 * 1000;
const START = Date.parse("2025-06-02T00:00:00.000Z");

function makeBars(count, closeFn) {
  return Array.from({ length: count }, (_, index) => {
    const openMs = START + (index * INTERVAL_15M);
    const close = closeFn(index);
    const open = index > 0 ? closeFn(index - 1) : close;
    const high = Math.max(open, close) + 5;
    const low = Math.min(open, close) - 5;
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
      volume: 100 + index,
      isClosed: true
    };
  });
}

const STRATEGY = Object.freeze({
  signal: Object.freeze({ atrPeriod: 14, stopAtrMultiple: 1.5, timeStopBars: 24 })
});

// A slow, steady 96+ bar uptrend (satisfies the momentum lookback and lets
// EMA20 track the trend closely), with a brief one-bar dip below EMA20 on
// the prior bar and a reclaim above it on the decision bar - numerically
// verified against the real implementation before being locked in here.
function longUptrendClose(index) {
  const trend = 50000 + (index * 3);
  if (index === 118) return trend - 80;
  if (index === 119) return trend + 20;
  return trend;
}

function shortDowntrendClose(index) {
  const trend = 50000 - (index * 3);
  if (index === 118) return trend + 80;
  if (index === 119) return trend - 20;
  return trend;
}

test("1 - momentum LONG plus an EMA20 reclaim on the decision bar fires a LONG candidate", () => {
  const bars = makeBars(125, longUptrendClose);
  const result = evaluateTsMomentum({ bars15m: bars, decisionIndex: 119, strategy: STRATEGY });

  assert.equal(result.status, "CANDIDATE");
  assert.equal(result.strategyId, TS_MOMENTUM_STRATEGY_ID);
  assert.equal(result.direction, "LONG");
  assert.equal(result.entryReference, bars[119].close);
  assert.equal(result.targetReference, null);
  assert.equal(result.timeStopBars, 24);
  assert.equal(result.momentum.direction, "LONG");
  assert.ok(bars[118].close < result.ema.previous, "previous close was below EMA (the dip)");
  assert.ok(bars[119].close > result.ema.current, "current close reclaimed above EMA");
  assert.ok(result.stopReference < result.entryReference, "a LONG stop sits below entry");
});

test("2 - momentum SHORT plus an EMA20 reclaim below on the decision bar fires a SHORT candidate", () => {
  const bars = makeBars(125, shortDowntrendClose);
  const result = evaluateTsMomentum({ bars15m: bars, decisionIndex: 119, strategy: STRATEGY });

  assert.equal(result.status, "CANDIDATE");
  assert.equal(result.direction, "SHORT");
  assert.equal(result.momentum.direction, "SHORT");
  assert.ok(bars[118].close > result.ema.previous, "previous close was above EMA (the pop)");
  assert.ok(bars[119].close < result.ema.current, "current close reclaimed below EMA");
  assert.ok(result.stopReference > result.entryReference, "a SHORT stop sits above entry");
});

test("3 - exactly zero momentum is a no-trade tie, not a direction", () => {
  const bars = makeBars(125, (index) => {
    if (index === 119 - 96 || index === 119) return 50000;
    return 50000 + (index % 3);
  });
  const result = evaluateTsMomentum({ bars15m: bars, decisionIndex: 119, strategy: STRATEGY });
  assert.equal(result.status, "NO_SIGNAL");
  assert.equal(result.strategyId, TS_MOMENTUM_STRATEGY_ID);
  assert.equal(result.momentum.direction, "FLAT");
  assert.equal(result.momentum.change, 0);
});

test("4 - momentum without a qualifying EMA20 reclaim produces no candidate", () => {
  const bars = makeBars(125, (index) => 50000 + (index * 3)); // steady climb, never dips below EMA
  const result = evaluateTsMomentum({ bars15m: bars, decisionIndex: 119, strategy: STRATEGY });
  assert.equal(result.status, "NO_SIGNAL");
  assert.equal(result.reasonCode, "NO_QUALIFYING_SETUP");
  assert.equal(result.momentum.direction, "LONG");
});

test("5 - insufficient causal history returns INDICATORS_COLD", () => {
  const bars = makeBars(125, longUptrendClose);
  const result = evaluateTsMomentum({ bars15m: bars.slice(0, 50), decisionIndex: 40, strategy: STRATEGY });
  assert.equal(result.status, "NO_SIGNAL");
  assert.equal(result.reasonCode, "INDICATORS_COLD");
});

test("6 - decisionIndex must be an integer of at least 1", () => {
  const bars = makeBars(125, longUptrendClose);
  for (const decisionIndex of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => evaluateTsMomentum({ bars15m: bars, decisionIndex, strategy: STRATEGY }),
      /decisionIndex must be an integer/
    );
  }
});

test("7 - bars after decisionIndex never influence the result (no lookahead)", () => {
  const bars = makeBars(125, longUptrendClose);
  const baseline = evaluateTsMomentum({ bars15m: bars, decisionIndex: 119, strategy: STRATEGY });
  const extended = [...bars, ...makeBars(10, () => 999999).map((bar, offset) => ({
    ...bar,
    openTime: new Date(Date.parse(bars.at(-1).closeTime) + (offset * INTERVAL_15M)).toISOString(),
    closeTime: new Date(Date.parse(bars.at(-1).closeTime) + ((offset + 1) * INTERVAL_15M)).toISOString()
  }))];
  const withFuture = evaluateTsMomentum({ bars15m: extended, decisionIndex: 119, strategy: STRATEGY });
  assert.deepEqual(withFuture, baseline);
});

test("8 - the EMA20 cross exit fires once the close crosses back against the position (LONG)", () => {
  const bars = makeBars(135, (index) => {
    const trend = 50000 + (index * 3);
    if (index === 118) return trend - 80;
    if (index === 119) return trend + 20;
    if (index >= 120 && index < 130) return trend;
    if (index === 130) return trend - 200;
    return trend;
  });

  for (const index of [125, 128, 129]) {
    const held = checkTsMomentumEmaCrossExit({ bars15m: bars, decisionIndex: index, direction: "LONG" });
    assert.equal(held.exit, false, `bar ${index} should still be held`);
  }
  const exited = checkTsMomentumEmaCrossExit({ bars15m: bars, decisionIndex: 130, direction: "LONG" });
  assert.equal(exited.exit, true);
  assert.ok(bars[130].close < exited.ema);

  const shortSideCheck = checkTsMomentumEmaCrossExit({ bars15m: bars, decisionIndex: 130, direction: "SHORT" });
  assert.equal(shortSideCheck.exit, false, "the same bar must not also trigger a SHORT exit");
});

test("9 - checkTsMomentumEmaCrossExit fails closed on insufficient history and rejects an invalid direction", () => {
  const shortBars = makeBars(15, longUptrendClose);
  const cold = checkTsMomentumEmaCrossExit({ bars15m: shortBars, decisionIndex: 5, direction: "LONG" });
  assert.equal(cold.exit, false);
  assert.equal(cold.reason, "INDICATORS_COLD");

  const warmBars = makeBars(25, longUptrendClose);
  assert.throws(
    () => checkTsMomentumEmaCrossExit({ bars15m: warmBars, decisionIndex: 20, direction: "SIDEWAYS" }),
    /direction must be "LONG" or "SHORT"/
  );
});
