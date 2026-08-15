import test from "node:test";
import assert from "node:assert/strict";
import {
  ALL_STRATEGY_IDS,
  COMPRESSION_BREAKOUT_STRATEGY_ID,
  DEFAULT_STRATEGY_PRIORITY,
  DONCHIAN_STRATEGY_ID,
  DYNAMIC_EXIT_FNS_BY_STRATEGY_ID,
  MEAN_REVERSION_STRATEGY_ID,
  TS_MOMENTUM_STRATEGY_ID,
  createSignalRouter
} from "../src/research/router.js";
import { COMPRESSION_VARIANTS } from "../src/research/strategies/compressionBreakout.js";

const INTERVAL_15M = 15 * 60 * 1000;
const INTERVAL_4H = 4 * 60 * 60 * 1000;
const INTERVAL_1D = 24 * 60 * 60 * 1000;

function makeBars15m(startIso, closes) {
  const startMs = Date.parse(startIso);
  return closes.map((close, index) => {
    const openMs = startMs + (index * INTERVAL_15M);
    const open = index > 0 ? closes[index - 1] : close;
    const high = Math.max(open, close) + 5;
    const low = Math.min(open, close) - 5;
    return {
      source: "binance",
      symbol: "BTCUSDT",
      timeframe: "15m",
      openTime: new Date(openMs).toISOString(),
      closeTime: new Date(openMs + INTERVAL_15M).toISOString(),
      open, high, low, close,
      volume: 100 + index,
      isClosed: true
    };
  });
}

function timelineEntry(closeIso, label) {
  return Object.freeze({
    closeTime: closeIso,
    closeTimeMs: Date.parse(closeIso),
    label,
    dailyAtrPct: 0.02,
    dailyAdx: label === "TREND" ? 35 : (label === "TRANSITIONAL" ? 27 : 15)
  });
}

const RANGE_TIMELINE_FROM_2025 = Object.freeze([timelineEntry("2025-01-01T00:00:00.000Z", "RANGE")]);

const DONCHIAN_TS_STRATEGY = Object.freeze({
  signal: Object.freeze({ atrPeriod: 14, stopAtrMultiple: 1.5, timeStopBars: 24 })
});

/**
 * Both slot 1 (Donchian) and slot 2 (TS momentum) confirm a LONG candidate
 * on the same decision bar: a gentle 100-bar uptrend (bars 0-99, giving
 * slot 2's 96-bar-back momentum a clear LONG baseline and letting EMA20 lag
 * below price), a pullback into a tight 19-bar consolidation (bars 100-118,
 * which doubles as slot 1's trailing 20-bar entry channel and pulls price
 * back under EMA20), then a single decisive breakout bar (index 120) that
 * both clears the consolidation's high (slot 1) and reclaims EMA20 (slot
 * 2). Numerically verified against both real evaluate* implementations
 * (both return CANDIDATE/LONG at decisionIndex 120) before being locked in
 * here, matching the project's established fixture-tuning workflow.
 */
function buildDualFireCloses() {
  const closes = [];
  for (let i = 0; i <= 99; i += 1) closes.push(40000 + (i * 40));
  for (let i = 0; i <= 9; i += 1) closes.push(43960 - ((i + 1) * 26));
  const dipLow = closes[closes.length - 1];
  for (let i = 0; i <= 8; i += 1) closes.push(dipLow + ((i % 3) * 3));
  closes.push(dipLow + 2);
  closes.push(dipLow + 500);
  return closes;
}

const DUAL_FIRE_START = "2025-06-02T00:00:00.000Z";
const DUAL_FIRE_DECISION_INDEX = 120;

function dualFireBars() {
  return makeBars15m(DUAL_FIRE_START, buildDualFireCloses());
}

// Well before any bar in dualFireBars() / rangeBoundBars(), so it is the
// sole applicable regime entry throughout.
const DUAL_FIRE_RANGE_TIMELINE = Object.freeze([timelineEntry("2025-06-01T00:00:00.000Z", "RANGE")]);

// Tight 4-bar-repeating oscillation that never breaks its own 20-bar
// channel - reused from tests/research.donchian.test.mjs's own no-signal
// fixture (test 3) to exercise the router's "regime allows it, but nothing
// fired" path without inventing a new numeric fixture.
function rangeBoundClose(index) {
  return 50000 + ((index % 4) * 10);
}
function rangeBoundBars() {
  return makeBars15m(DUAL_FIRE_START, Array.from({ length: 60 }, (_, index) => rangeBoundClose(index)));
}

const MEAN_REVERSION_STRATEGY = Object.freeze({
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

const MR_START = Date.parse("2025-01-01T00:00:00.000Z");
const MR_BASE = 50000;
const MR_AMPLITUDE = 900;

function makeMrBars(timeframe, count, intervalMs, priceFn) {
  return Array.from({ length: count }, (_, index) => {
    const openTime = MR_START + (index * intervalMs);
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
      open, high, low, close,
      volume: 100 + index,
      isClosed: true
    };
  });
}

/**
 * Identical construction to tests/research.meanReversionAdapter.test.mjs's
 * firingDataset() (same BASE/AMPLITUDE/oscillation/overrides), reused here
 * rather than re-derived so this file's mean-reversion candidate is known
 * to be genuine without a second numeric-tuning pass.
 */
function meanReversionFiringDataset() {
  const total15m = 2500;
  const oscillate = (index) => MR_BASE + (MR_AMPLITUDE * Math.sin(index / 6));
  const overrides = { [total15m - 2]: 51700, [total15m - 1]: 51550 };
  const price15m = (index) => overrides[index] ?? oscillate(index);

  const bars15m = makeMrBars("15m", total15m, INTERVAL_15M, price15m);
  const bars4h = makeMrBars(
    "4h",
    Math.ceil((total15m * INTERVAL_15M) / INTERVAL_4H) + 2,
    INTERVAL_4H,
    (index) => MR_BASE + (MR_AMPLITUDE * Math.sin((index * (INTERVAL_4H / INTERVAL_15M)) / 6))
  );
  const bars1d = makeMrBars(
    "1d",
    Math.ceil((total15m * INTERVAL_15M) / INTERVAL_1D) + 2,
    INTERVAL_1D,
    (index) => MR_BASE + (MR_AMPLITUDE * Math.sin((index * (INTERVAL_1D / INTERVAL_15M)) / 6))
  );
  return { bars15m, bars4h, bars1d };
}

// Well before 2025-01-01, so it is the sole applicable regime entry
// throughout meanReversionFiringDataset()'s ~26-day span.
const MR_RANGE_TIMELINE = Object.freeze([timelineEntry("2024-12-01T00:00:00.000Z", "RANGE")]);

const COMPRESSION_STRATEGY = Object.freeze({
  signal: Object.freeze({ bbPeriod: 20, bbStdDev: 2, atrPeriod: 14, stopAtrMultiple: 1.5, timeStopBars: 24 })
});
const COMPRESSION_VARIANT_L10_N20 = COMPRESSION_VARIANTS[0];

// Identical construction to tests/research.compressionBreakout.test.mjs's
// longBreakoutClose fixture (test 2), reused here for the same reason as
// meanReversionFiringDataset() above.
function compressionWideMarketClose(index) {
  return 50000 + (500 * Math.sin(index / 15));
}
function compressionCompressedRangeClose(index) {
  return 50000 + ((index % 3) * 5);
}
function compressionLongBreakoutClose(index) {
  if (index < 400) return compressionWideMarketClose(index);
  if (index < 499) return compressionCompressedRangeClose(index);
  return 50150;
}
function compressionBars() {
  return makeBars15m(DUAL_FIRE_START, Array.from({ length: 505 }, (_, index) => compressionLongBreakoutClose(index)));
}
const COMPRESSION_DECISION_INDEX = 499;
const COMPRESSION_RANGE_TIMELINE = Object.freeze([timelineEntry("2025-06-01T00:00:00.000Z", "RANGE")]);

test("1 - createSignalRouter requires a non-empty regimeTimeline", () => {
  assert.throws(
    () => createSignalRouter({ regimeTimeline: [], enabledStrategyIds: [DONCHIAN_STRATEGY_ID] }),
    /regimeTimeline must be a non-empty array/
  );
});

test("2 - createSignalRouter requires a non-empty enabledStrategyIds", () => {
  assert.throws(
    () => createSignalRouter({ regimeTimeline: RANGE_TIMELINE_FROM_2025, enabledStrategyIds: [] }),
    /enabledStrategyIds must be a non-empty array/
  );
});

test("3 - createSignalRouter rejects duplicate enabledStrategyIds", () => {
  assert.throws(
    () => createSignalRouter({
      regimeTimeline: RANGE_TIMELINE_FROM_2025,
      enabledStrategyIds: [DONCHIAN_STRATEGY_ID, DONCHIAN_STRATEGY_ID]
    }),
    /must not contain duplicates/
  );
});

test("4 - createSignalRouter rejects an unknown strategyId", () => {
  assert.throws(
    () => createSignalRouter({
      regimeTimeline: RANGE_TIMELINE_FROM_2025,
      enabledStrategyIds: ["not-a-real-strategy"]
    }),
    /unknown strategyId/
  );
});

test("5 - createSignalRouter requires priorityOrder to rank every enabled strategy", () => {
  assert.throws(
    () => createSignalRouter({
      regimeTimeline: RANGE_TIMELINE_FROM_2025,
      enabledStrategyIds: [DONCHIAN_STRATEGY_ID, TS_MOMENTUM_STRATEGY_ID],
      priorityOrder: [DONCHIAN_STRATEGY_ID]
    }),
    /priorityOrder must rank every enabled strategy/
  );
});

test("6 - createSignalRouter requires a valid compressionVariant when slot 4 is enabled", () => {
  assert.throws(
    () => createSignalRouter({
      regimeTimeline: RANGE_TIMELINE_FROM_2025,
      enabledStrategyIds: [COMPRESSION_BREAKOUT_STRATEGY_ID]
    }),
    /compressionVariant must be one of/
  );
  assert.throws(
    () => createSignalRouter({
      regimeTimeline: RANGE_TIMELINE_FROM_2025,
      enabledStrategyIds: [COMPRESSION_BREAKOUT_STRATEGY_ID],
      compressionVariant: "not-a-real-variant"
    }),
    /compressionVariant must be one of/
  );
});

test("7 - compressionVariant resolves from either a variant object or a bare id string", () => {
  const byObject = createSignalRouter({
    regimeTimeline: RANGE_TIMELINE_FROM_2025,
    enabledStrategyIds: [COMPRESSION_BREAKOUT_STRATEGY_ID],
    compressionVariant: COMPRESSION_VARIANT_L10_N20
  });
  assert.equal(byObject.compressionVariant, COMPRESSION_VARIANT_L10_N20);

  const byId = createSignalRouter({
    regimeTimeline: RANGE_TIMELINE_FROM_2025,
    enabledStrategyIds: [COMPRESSION_BREAKOUT_STRATEGY_ID],
    compressionVariant: "L10-N20"
  });
  assert.equal(byId.compressionVariant, COMPRESSION_VARIANT_L10_N20);

  const notEnabled = createSignalRouter({
    regimeTimeline: RANGE_TIMELINE_FROM_2025,
    enabledStrategyIds: [DONCHIAN_STRATEGY_ID]
  });
  assert.equal(notEnabled.compressionVariant, null);
});

test("8 - a decision time before the regime timeline's first entry blocks with REGIME_BURN_IN, ahead of any strategy", () => {
  const router = createSignalRouter({
    regimeTimeline: [timelineEntry("2030-01-01T00:00:00.000Z", "RANGE")],
    enabledStrategyIds: [DONCHIAN_STRATEGY_ID, TS_MOMENTUM_STRATEGY_ID]
  });
  const bars15m = dualFireBars();
  const result = router.signalFn({
    bars15m, bars4h: [], bars1d: [], decisionIndex: DUAL_FIRE_DECISION_INDEX, strategy: DONCHIAN_TS_STRATEGY
  });
  assert.equal(result.status, "NO_SIGNAL");
  assert.equal(result.reasonCode, "REGIME_BURN_IN");
  assert.equal(result.regimeLabel, null);
});

test("9 - EXCLUDED_VOL blocks a bar that would otherwise fire two real candidates", () => {
  const router = createSignalRouter({
    regimeTimeline: [timelineEntry("2025-06-01T00:00:00.000Z", "EXCLUDED_VOL")],
    enabledStrategyIds: [DONCHIAN_STRATEGY_ID, TS_MOMENTUM_STRATEGY_ID]
  });
  const bars15m = dualFireBars();
  const result = router.signalFn({
    bars15m, bars4h: [], bars1d: [], decisionIndex: DUAL_FIRE_DECISION_INDEX, strategy: DONCHIAN_TS_STRATEGY
  });
  assert.equal(result.status, "NO_SIGNAL");
  assert.equal(result.reasonCode, "REGIME_NOT_TRADABLE");
  assert.equal(result.regimeLabel, "EXCLUDED_VOL");
  assert.equal(result.strategyId, null);
});

test("10 - TRANSITIONAL also blocks, same as EXCLUDED_VOL", () => {
  const router = createSignalRouter({
    regimeTimeline: [timelineEntry("2025-06-01T00:00:00.000Z", "TRANSITIONAL")],
    enabledStrategyIds: [DONCHIAN_STRATEGY_ID, TS_MOMENTUM_STRATEGY_ID]
  });
  const bars15m = dualFireBars();
  const result = router.signalFn({
    bars15m, bars4h: [], bars1d: [], decisionIndex: DUAL_FIRE_DECISION_INDEX, strategy: DONCHIAN_TS_STRATEGY
  });
  assert.equal(result.status, "NO_SIGNAL");
  assert.equal(result.reasonCode, "REGIME_NOT_TRADABLE");
  assert.equal(result.regimeLabel, "TRANSITIONAL");
});

test("11 - a tradable regime plus a single enabled strategy (Donchian) routes its real candidate through", () => {
  const router = createSignalRouter({
    regimeTimeline: DUAL_FIRE_RANGE_TIMELINE,
    enabledStrategyIds: [DONCHIAN_STRATEGY_ID]
  });
  const bars15m = dualFireBars();
  const result = router.signalFn({
    bars15m, bars4h: [], bars1d: [], decisionIndex: DUAL_FIRE_DECISION_INDEX, strategy: DONCHIAN_TS_STRATEGY
  });
  assert.equal(result.status, "CANDIDATE");
  assert.equal(result.strategyId, DONCHIAN_STRATEGY_ID);
  assert.equal(result.direction, "LONG");
  assert.equal(result.regime.classification, "RANGE");
  assert.equal(result.routeRegimeLabel, "RANGE");
  assert.equal(result.shadowCandidates, undefined);
  assert.equal(result.productionSignalRegime, undefined);
});

test("12 - the same bar with only TS momentum enabled routes TS momentum's real candidate instead", () => {
  const router = createSignalRouter({
    regimeTimeline: DUAL_FIRE_RANGE_TIMELINE,
    enabledStrategyIds: [TS_MOMENTUM_STRATEGY_ID]
  });
  const bars15m = dualFireBars();
  const result = router.signalFn({
    bars15m, bars4h: [], bars1d: [], decisionIndex: DUAL_FIRE_DECISION_INDEX, strategy: DONCHIAN_TS_STRATEGY
  });
  assert.equal(result.status, "CANDIDATE");
  assert.equal(result.strategyId, TS_MOMENTUM_STRATEGY_ID);
  assert.equal(result.direction, "LONG");
});

test("13 - with both slot 1 and slot 2 enabled and firing together, the default priority order (slot 1 before slot 2) wins and slot 2 is reported shadowed", () => {
  const router = createSignalRouter({
    regimeTimeline: DUAL_FIRE_RANGE_TIMELINE,
    enabledStrategyIds: [DONCHIAN_STRATEGY_ID, TS_MOMENTUM_STRATEGY_ID]
  });
  assert.deepEqual(router.priorityOrder, DEFAULT_STRATEGY_PRIORITY);
  const bars15m = dualFireBars();
  const result = router.signalFn({
    bars15m, bars4h: [], bars1d: [], decisionIndex: DUAL_FIRE_DECISION_INDEX, strategy: DONCHIAN_TS_STRATEGY
  });
  assert.equal(result.status, "CANDIDATE");
  assert.equal(result.strategyId, DONCHIAN_STRATEGY_ID);
  assert.deepEqual(result.shadowCandidates, [{ strategyId: TS_MOMENTUM_STRATEGY_ID, direction: "LONG" }]);
});

test("14 - a caller-supplied priorityOrder overrides the default tie-break", () => {
  const router = createSignalRouter({
    regimeTimeline: DUAL_FIRE_RANGE_TIMELINE,
    enabledStrategyIds: [DONCHIAN_STRATEGY_ID, TS_MOMENTUM_STRATEGY_ID],
    priorityOrder: [TS_MOMENTUM_STRATEGY_ID, DONCHIAN_STRATEGY_ID]
  });
  const bars15m = dualFireBars();
  const result = router.signalFn({
    bars15m, bars4h: [], bars1d: [], decisionIndex: DUAL_FIRE_DECISION_INDEX, strategy: DONCHIAN_TS_STRATEGY
  });
  assert.equal(result.status, "CANDIDATE");
  assert.equal(result.strategyId, TS_MOMENTUM_STRATEGY_ID);
  assert.deepEqual(result.shadowCandidates, [{ strategyId: DONCHIAN_STRATEGY_ID, direction: "LONG" }]);
});

test("15 - a tradable regime with nothing qualifying returns NO_QUALIFYING_SETUP, not a strategy-specific reason", () => {
  const router = createSignalRouter({
    regimeTimeline: DUAL_FIRE_RANGE_TIMELINE,
    enabledStrategyIds: [DONCHIAN_STRATEGY_ID]
  });
  const bars15m = rangeBoundBars();
  const result = router.signalFn({
    bars15m, bars4h: [], bars1d: [], decisionIndex: 55, strategy: DONCHIAN_TS_STRATEGY
  });
  assert.equal(result.status, "NO_SIGNAL");
  assert.equal(result.reasonCode, "NO_QUALIFYING_SETUP");
  assert.equal(result.regimeLabel, "RANGE");
});

test("16 - a mean-reversion candidate keeps its own production regime evidence under productionSignalRegime, while regime/routeRegimeLabel carry the router's regime.js label", () => {
  const router = createSignalRouter({
    regimeTimeline: MR_RANGE_TIMELINE,
    enabledStrategyIds: [MEAN_REVERSION_STRATEGY_ID]
  });
  const { bars15m, bars4h, bars1d } = meanReversionFiringDataset();
  const decisionIndex = bars15m.length - 1;
  const result = router.signalFn({ bars15m, bars4h, bars1d, decisionIndex, strategy: MEAN_REVERSION_STRATEGY });

  assert.equal(result.status, "CANDIDATE");
  assert.equal(result.strategyId, MEAN_REVERSION_STRATEGY_ID);
  assert.equal(result.direction, "SHORT");
  assert.equal(result.regime.classification, "RANGE");
  assert.equal(result.routeRegimeLabel, "RANGE");
  assert.ok(result.productionSignalRegime, "the strategy's own regime evidence must be preserved");
  assert.equal(result.productionSignalRegime.allowed, true);
  assert.equal(result.productionSignalRegime.classification, "RANGE");
});

test("17 - a compression-breakout candidate (slot 4) routes through with its resolved variant", () => {
  const router = createSignalRouter({
    regimeTimeline: COMPRESSION_RANGE_TIMELINE,
    enabledStrategyIds: [COMPRESSION_BREAKOUT_STRATEGY_ID],
    compressionVariant: "L10-N20"
  });
  const bars15m = compressionBars();
  const result = router.signalFn({
    bars15m, bars4h: [], bars1d: [], decisionIndex: COMPRESSION_DECISION_INDEX, strategy: COMPRESSION_STRATEGY
  });
  assert.equal(result.status, "CANDIDATE");
  assert.equal(result.strategyId, COMPRESSION_BREAKOUT_STRATEGY_ID);
  assert.equal(result.direction, "LONG");
  assert.equal(result.variant, "L10-N20");
  assert.equal(result.regime.classification, "RANGE");
});

test("18 - dynamicExitFns includes only the enabled dynamic-exit strategies (slots 1 and 2, never 3 or 4)", () => {
  const router = createSignalRouter({
    regimeTimeline: RANGE_TIMELINE_FROM_2025,
    enabledStrategyIds: ALL_STRATEGY_IDS,
    compressionVariant: "L10-N20"
  });
  assert.deepEqual(
    Object.keys(router.dynamicExitFns).sort(),
    [DONCHIAN_STRATEGY_ID, TS_MOMENTUM_STRATEGY_ID].sort()
  );
  assert.equal(router.dynamicExitFns[DONCHIAN_STRATEGY_ID], DYNAMIC_EXIT_FNS_BY_STRATEGY_ID[DONCHIAN_STRATEGY_ID]);
  assert.equal(
    router.dynamicExitFns[TS_MOMENTUM_STRATEGY_ID],
    DYNAMIC_EXIT_FNS_BY_STRATEGY_ID[TS_MOMENTUM_STRATEGY_ID]
  );
});

test("19 - dynamicExitFns is empty when only static-bracket strategies are enabled", () => {
  const router = createSignalRouter({
    regimeTimeline: RANGE_TIMELINE_FROM_2025,
    enabledStrategyIds: [MEAN_REVERSION_STRATEGY_ID]
  });
  assert.deepEqual(router.dynamicExitFns, {});
});

test("20 - the router's own returned fields are frozen and independent of the caller's arrays", () => {
  const enabledStrategyIds = [DONCHIAN_STRATEGY_ID, TS_MOMENTUM_STRATEGY_ID];
  const priorityOrder = [TS_MOMENTUM_STRATEGY_ID, DONCHIAN_STRATEGY_ID];
  const router = createSignalRouter({
    regimeTimeline: RANGE_TIMELINE_FROM_2025,
    enabledStrategyIds,
    priorityOrder
  });
  assert.ok(Object.isFrozen(router));
  assert.ok(Object.isFrozen(router.enabledStrategyIds));
  assert.ok(Object.isFrozen(router.priorityOrder));
  assert.ok(Object.isFrozen(router.dynamicExitFns));

  enabledStrategyIds.push(COMPRESSION_BREAKOUT_STRATEGY_ID);
  priorityOrder.push(MEAN_REVERSION_STRATEGY_ID);
  assert.deepEqual(router.enabledStrategyIds, [DONCHIAN_STRATEGY_ID, TS_MOMENTUM_STRATEGY_ID]);
  assert.deepEqual(router.priorityOrder, [TS_MOMENTUM_STRATEGY_ID, DONCHIAN_STRATEGY_ID]);
});
