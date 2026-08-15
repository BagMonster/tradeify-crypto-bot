import test from "node:test";
import assert from "node:assert/strict";
import {
  DONCHIAN_STRATEGY_ID,
  checkDonchianChannelExit,
  evaluateDonchian
} from "../src/research/strategies/donchian.js";

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

// Tight 4-bar-repeating oscillation (50000-50030) for the first 55 bars,
// keeping the 20-bar entry channel narrow, then a clean breakout on the
// decision bar - numerically verified against the real implementation
// before being locked into this fixture, matching the project's fixture
// workflow used in tests/research.meanReversionAdapter.test.mjs.
function rangeBoundClose(index) {
  return 50000 + ((index % 4) * 10);
}

test("1 - a close above the prior 20-bar high fires a LONG candidate", () => {
  const bars = makeBars(60, (index) => (index < 55 ? rangeBoundClose(index) : 51000));
  const result = evaluateDonchian({ bars15m: bars, decisionIndex: 55, strategy: STRATEGY });

  assert.equal(result.status, "CANDIDATE");
  assert.equal(result.strategyId, DONCHIAN_STRATEGY_ID);
  assert.equal(result.direction, "LONG");
  assert.equal(result.source, "binance");
  assert.equal(result.symbol, "BTCUSDT");
  assert.equal(result.entryReference, 51000);
  assert.equal(result.targetReference, null, "Slot 1 has no fixed target");
  assert.equal(result.timeStopBars, 24);
  assert.equal(result.channel.highestHigh, 50035);
  assert.equal(result.channel.lowestLow, 49995);
  assert.ok(result.stopReference < result.entryReference, "a LONG stop sits below entry");
  assert.ok(Math.abs(result.stopDistance - ((result.entryReference - result.stopReference))) < 1e-9);
});

test("2 - a close below the prior 20-bar low fires a SHORT candidate", () => {
  const bars = makeBars(60, (index) => (index < 55 ? rangeBoundClose(index) : 49000));
  const result = evaluateDonchian({ bars15m: bars, decisionIndex: 55, strategy: STRATEGY });

  assert.equal(result.status, "CANDIDATE");
  assert.equal(result.direction, "SHORT");
  assert.equal(result.entryReference, 49000);
  assert.ok(result.stopReference > result.entryReference, "a SHORT stop sits above entry");
});

test("3 - a close that stays inside the channel produces no candidate", () => {
  const bars = makeBars(60, rangeBoundClose);
  const result = evaluateDonchian({ bars15m: bars, decisionIndex: 55, strategy: STRATEGY });
  assert.equal(result.status, "NO_SIGNAL");
  assert.equal(result.strategyId, DONCHIAN_STRATEGY_ID);
  assert.equal(result.reasonCode, "NO_QUALIFYING_SETUP");
});

test("4 - insufficient causal history returns INDICATORS_COLD", () => {
  const bars = makeBars(60, rangeBoundClose);
  const result = evaluateDonchian({ bars15m: bars.slice(0, 30), decisionIndex: 25, strategy: STRATEGY });
  assert.equal(result.status, "NO_SIGNAL");
  assert.equal(result.reasonCode, "INDICATORS_COLD");
});

test("5 - decisionIndex must be an integer of at least 1", () => {
  const bars = makeBars(60, rangeBoundClose);
  for (const decisionIndex of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => evaluateDonchian({ bars15m: bars, decisionIndex, strategy: STRATEGY }),
      /decisionIndex must be an integer/
    );
  }
});

test("6 - bars after decisionIndex never influence the result (no lookahead)", () => {
  const bars = makeBars(60, (index) => (index < 55 ? rangeBoundClose(index) : 51000));
  const baseline = evaluateDonchian({ bars15m: bars, decisionIndex: 55, strategy: STRATEGY });
  const extended = [...bars, ...makeBars(10, () => 999999).map((bar, offset) => ({
    ...bar,
    openTime: new Date(Date.parse(bars.at(-1).closeTime) + (offset * INTERVAL_15M)).toISOString(),
    closeTime: new Date(Date.parse(bars.at(-1).closeTime) + ((offset + 1) * INTERVAL_15M)).toISOString()
  }))];
  const withFuture = evaluateDonchian({ bars15m: extended, decisionIndex: 55, strategy: STRATEGY });
  assert.deepEqual(withFuture, baseline);
});

test("7 - the channel exit fires once close breaks the stabilized prior 10-bar low (LONG)", () => {
  // Entry breakout at bar 55, then a flat hold through bar 64 (stabilizing
  // the trailing 10-bar low around the entry bar's own low), then a clean
  // break below that stabilized low at bar 65.
  const bars = makeBars(70, (index) => {
    if (index < 55) return rangeBoundClose(index);
    if (index === 55) return 51000;
    if (index < 65) return 51000;
    return 49900;
  });

  for (const index of [60, 63, 64]) {
    const held = checkDonchianChannelExit({ bars15m: bars, decisionIndex: index, direction: "LONG" });
    assert.equal(held.exit, false, `bar ${index} should still be held`);
  }
  const exited = checkDonchianChannelExit({ bars15m: bars, decisionIndex: 65, direction: "LONG" });
  assert.equal(exited.exit, true);
  assert.equal(exited.channel.lowestLow, 50015);

  const shortSideCheck = checkDonchianChannelExit({ bars15m: bars, decisionIndex: 65, direction: "SHORT" });
  assert.equal(shortSideCheck.exit, false, "the same bar must not also trigger a SHORT exit");
});

test("8 - checkDonchianChannelExit fails closed on insufficient history and rejects an invalid direction", () => {
  const bars = makeBars(15, rangeBoundClose);
  const cold = checkDonchianChannelExit({ bars15m: bars, decisionIndex: 5, direction: "LONG" });
  assert.equal(cold.exit, false);
  assert.equal(cold.reason, "INDICATORS_COLD");
  assert.throws(
    () => checkDonchianChannelExit({ bars15m: bars, decisionIndex: 12, direction: "SIDEWAYS" }),
    /direction must be "LONG" or "SHORT"/
  );
});
