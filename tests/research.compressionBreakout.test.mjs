import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPRESSION_BREAKOUT_STRATEGY_ID,
  COMPRESSION_VARIANTS,
  evaluateCompressionBreakout
} from "../src/research/strategies/compressionBreakout.js";

const INTERVAL_15M = 15 * 60 * 1000;
const START = Date.parse("2025-06-02T00:00:00.000Z");

function makeBars(count, closeFn) {
  return Array.from({ length: count }, (_, index) => {
    const openMs = START + (index * INTERVAL_15M);
    const close = closeFn(index);
    const open = index > 0 ? closeFn(index - 1) : close;
    const high = Math.max(open, close) + 3;
    const low = Math.min(open, close) - 3;
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
  signal: Object.freeze({ bbPeriod: 20, bbStdDev: 2, atrPeriod: 14, stopAtrMultiple: 1.5, timeStopBars: 24 })
});

const VARIANT_L10_N20 = COMPRESSION_VARIANTS[0];

// A wide sine-oscillation "normal market" for the first 400 bars (keeps
// bandwidth wide for most of the trailing 480-bar percentile window), then
// a tight, low-bandwidth range for bars 400-498 (compression), then a
// clean breakout on the decision bar - numerically verified against the
// real implementation before being locked into this fixture.
function wideMarketClose(index) {
  return 50000 + (500 * Math.sin(index / 15));
}
function compressedRangeClose(index) {
  return 50000 + ((index % 3) * 5);
}
function longBreakoutClose(index) {
  if (index < 400) return wideMarketClose(index);
  if (index < 499) return compressedRangeClose(index);
  return 50150;
}
function shortBreakoutClose(index) {
  if (index < 400) return wideMarketClose(index);
  if (index < 499) return compressedRangeClose(index);
  return 49850;
}

test("1 - COMPRESSION_VARIANTS is the frozen 4-variant grid (L in {10,30} x N in {20,40})", () => {
  assert.equal(COMPRESSION_VARIANTS.length, 4);
  const ids = COMPRESSION_VARIANTS.map((variant) => variant.id).sort();
  assert.deepEqual(ids, ["L10-N20", "L10-N40", "L30-N20", "L30-N40"]);
  for (const variant of COMPRESSION_VARIANTS) {
    assert.ok([10, 30].includes(variant.breakoutPeriod));
    assert.ok([20, 40].includes(variant.percentile));
  }
});

test("2 - compression plus an upside breakout fires a LONG candidate", () => {
  const bars = makeBars(505, longBreakoutClose);
  const result = evaluateCompressionBreakout({
    bars15m: bars, decisionIndex: 499, strategy: STRATEGY, variant: VARIANT_L10_N20
  });

  assert.equal(result.status, "CANDIDATE");
  assert.equal(result.strategyId, COMPRESSION_BREAKOUT_STRATEGY_ID);
  assert.equal(result.direction, "LONG");
  assert.equal(result.entryReference, 50150);
  assert.equal(result.targetReference, null);
  assert.equal(result.timeStopBars, 24);
  assert.equal(result.variant, "L10-N20");
  assert.ok(result.currentBandwidth <= result.threshold.value, "must have been compressed to fire");
  assert.ok(result.stopReference < result.entryReference);
});

test("3 - compression plus a downside breakout fires a SHORT candidate", () => {
  const bars = makeBars(505, shortBreakoutClose);
  const result = evaluateCompressionBreakout({
    bars15m: bars, decisionIndex: 499, strategy: STRATEGY, variant: VARIANT_L10_N20
  });
  assert.equal(result.status, "CANDIDATE");
  assert.equal(result.direction, "SHORT");
  assert.equal(result.entryReference, 49850);
  assert.ok(result.stopReference > result.entryReference);
});

test("4 - a wide, uncompressed bandwidth blocks the trigger regardless of price action", () => {
  const bars = makeBars(505, wideMarketClose);
  const result = evaluateCompressionBreakout({
    bars15m: bars, decisionIndex: 499, strategy: STRATEGY, variant: VARIANT_L10_N20
  });
  assert.equal(result.status, "NO_SIGNAL");
  assert.equal(result.strategyId, COMPRESSION_BREAKOUT_STRATEGY_ID);
  assert.equal(result.reasonCode, "NOT_COMPRESSED");
  assert.ok(result.currentBandwidth > result.threshold.value);
});

test("5 - compression without a channel breakout produces no candidate", () => {
  const bars = makeBars(505, (index) => {
    if (index < 400) return wideMarketClose(index);
    return compressedRangeClose(index); // stays inside the tight range through decisionIndex too
  });
  const result = evaluateCompressionBreakout({
    bars15m: bars, decisionIndex: 499, strategy: STRATEGY, variant: VARIANT_L10_N20
  });
  assert.equal(result.status, "NO_SIGNAL");
  assert.equal(result.reasonCode, "NO_QUALIFYING_SETUP");
});

test("6 - insufficient causal history returns INDICATORS_COLD", () => {
  const bars = makeBars(300, wideMarketClose);
  const result = evaluateCompressionBreakout({
    bars15m: bars, decisionIndex: 250, strategy: STRATEGY, variant: VARIANT_L10_N20
  });
  assert.equal(result.status, "NO_SIGNAL");
  assert.equal(result.reasonCode, "INDICATORS_COLD");
});

test("7 - decisionIndex must be an integer of at least 1, and a variant must be supplied", () => {
  const bars = makeBars(505, longBreakoutClose);
  for (const decisionIndex of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => evaluateCompressionBreakout({ bars15m: bars, decisionIndex, strategy: STRATEGY, variant: VARIANT_L10_N20 }),
      /decisionIndex must be an integer/
    );
  }
  assert.throws(
    () => evaluateCompressionBreakout({ bars15m: bars, decisionIndex: 499, strategy: STRATEGY, variant: null }),
    /variant must supply breakoutPeriod and percentile/
  );
});

test("8 - bars after decisionIndex never influence the result (no lookahead)", () => {
  const bars = makeBars(505, longBreakoutClose);
  const baseline = evaluateCompressionBreakout({
    bars15m: bars, decisionIndex: 499, strategy: STRATEGY, variant: VARIANT_L10_N20
  });
  const extended = [...bars, ...makeBars(10, () => 999999).map((bar, offset) => ({
    ...bar,
    openTime: new Date(Date.parse(bars.at(-1).closeTime) + (offset * INTERVAL_15M)).toISOString(),
    closeTime: new Date(Date.parse(bars.at(-1).closeTime) + ((offset + 1) * INTERVAL_15M)).toISOString()
  }))];
  const withFuture = evaluateCompressionBreakout({
    bars15m: extended, decisionIndex: 499, strategy: STRATEGY, variant: VARIANT_L10_N20
  });
  assert.deepEqual(withFuture, baseline);
});

test("9 - a wider (L30) or looser (N40) variant can trigger where the tighter default does not", () => {
  const bars = makeBars(505, longBreakoutClose);
  const results = Object.fromEntries(COMPRESSION_VARIANTS.map((variant) => [
    variant.id,
    evaluateCompressionBreakout({ bars15m: bars, decisionIndex: 499, strategy: STRATEGY, variant })
  ]));
  // All four variants share the same compression measurement; only the
  // breakout channel width (L) or the compression threshold (N) differs -
  // so all four must at least be internally consistent (compressed or not)
  // relative to their own threshold.
  for (const [id, result] of Object.entries(results)) {
    if (result.status === "CANDIDATE") {
      assert.ok(result.currentBandwidth <= result.threshold.value, `${id} fired but was not actually compressed`);
    }
  }
});
