import { INDICATOR_WARMUP_REQUIREMENTS, calculateAtr, ema, timeSeriesMomentum } from "../../indicators.js";

export const TS_MOMENTUM_STRATEGY_ID = "ts-momentum-ema-pullback";

const MOMENTUM_LOOKBACK = 96; // 24 hours of 15m bars
const EMA_PERIOD = 20;

/**
 * Standalone-computability floor for this module (see donchian.js's longer
 * note on the same pattern): the larger of the momentum lookback (needs
 * `lookback + 1` closes) and production's own indicator warm-up floor,
 * reused for the ATR window below. NOT the Section 4.2 "future activation"
 * table's 150-bar figure for this slot - that number governs a later
 * chapter's live readiness gate, not this module's own minimum.
 */
const REQUIRED_WARMUP_BARS = Math.max(
  MOMENTUM_LOOKBACK + 1,
  EMA_PERIOD,
  INDICATOR_WARMUP_REQUIREMENTS["15m"]
);

function noSignal(reasonCode, reason, details = {}) {
  return Object.freeze({
    status: "NO_SIGNAL",
    strategyId: TS_MOMENTUM_STRATEGY_ID,
    direction: null,
    reasonCode,
    reason,
    ...details
  });
}

/** Same fixed-window ATR convention as donchian.js's atrAt - see its comment. */
function atrAt(bars15m, decisionIndex, atrPeriod) {
  const windowStart = Math.max(0, decisionIndex - INDICATOR_WARMUP_REQUIREMENTS["15m"] + 1);
  const window = bars15m.slice(windowStart, decisionIndex + 1);
  return calculateAtr(window, { period: atrPeriod, timeframe: "15m" });
}

/**
 * Computes the EMA20 series once, over every causal close from bar 0 of
 * `bars15m` through decisionIndex. ema() is recursive (see its doc comment
 * in src/indicators.js) - its value depends on every prior point back to
 * the seed, so unlike Bollinger/ATR it cannot correctly be windowed to just
 * the trailing N bars without changing the resulting value. Section 3, Slot
 * 2 requires the series to be "seeded... explicit[ly]" from "the first 20
 * available bars," so this seeds from bars15m[0] every call.
 *
 * This is O(decisionIndex) work on every call - an accepted trade-off for
 * Step 26.4's correctness-first scope. A future router.js (Step 26.5) can
 * cache and incrementally extend one EMA series across an entire backtest
 * run if the full ~35,000-bar dataset needs it to run faster; nothing here
 * depends on that optimization existing.
 */
function emaSeriesThrough(bars15m, decisionIndex) {
  const closes = bars15m.slice(0, decisionIndex + 1).map((bar) => bar.close);
  return ema(closes, EMA_PERIOD);
}

/**
 * Section 3, Slot 2 - entry only. The exit ("EMA20 cross against the
 * position") is DYNAMIC, recomputed bar by bar - the same wiring caveat as
 * src/research/strategies/donchian.js's evaluateDonchian: not wired into
 * runBacktest yet (Step 26.5). checkTsMomentumEmaCrossExit below exists as
 * a tested, ready-to-wire building block.
 */
export function evaluateTsMomentum({ bars15m, decisionIndex, strategy }) {
  if (!Number.isInteger(decisionIndex) || decisionIndex < 1) {
    throw new Error("decisionIndex must be an integer of at least 1 (a prior bar must exist)");
  }
  if (decisionIndex < REQUIRED_WARMUP_BARS) {
    return noSignal("INDICATORS_COLD", "Insufficient causal 15m history for momentum + EMA20");
  }

  const closes = bars15m.slice(0, decisionIndex + 1).map((bar) => bar.close);
  const momentum = timeSeriesMomentum(closes, MOMENTUM_LOOKBACK);
  if (momentum.direction === "FLAT") {
    return noSignal(
      "NO_QUALIFYING_SETUP",
      "Momentum is exactly flat; Section 3 requires no trade on a tie",
      { momentum }
    );
  }

  const emaSeries = emaSeriesThrough(bars15m, decisionIndex);
  const currentEma = emaSeries.values[decisionIndex];
  const previousEma = emaSeries.values[decisionIndex - 1];
  if (currentEma === null || previousEma === null) {
    return noSignal("INDICATORS_COLD", "EMA20 has not seeded yet", { momentum });
  }

  const currentBar = bars15m[decisionIndex];
  const previousBar = bars15m[decisionIndex - 1];
  const longReclaim = previousBar.close < previousEma && currentBar.close > currentEma;
  const shortReclaim = previousBar.close > previousEma && currentBar.close < currentEma;

  const longQualified = momentum.direction === "LONG" && longReclaim;
  const shortQualified = momentum.direction === "SHORT" && shortReclaim;
  if (!longQualified && !shortQualified) {
    return noSignal(
      "NO_QUALIFYING_SETUP",
      "Momentum direction and the EMA20 reclaim did not align",
      { momentum, ema: { current: currentEma, previous: previousEma } }
    );
  }
  const direction = longQualified ? "LONG" : "SHORT";

  let atr;
  try {
    atr = atrAt(bars15m, decisionIndex, strategy.signal.atrPeriod);
  } catch (error) {
    return noSignal("INDICATORS_COLD", error.message, { momentum });
  }
  const stopDistance = atr.value * strategy.signal.stopAtrMultiple;
  if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
    return noSignal("INVALID_STOP_DISTANCE", "ATR must produce a positive stop distance", { momentum });
  }
  const entryReference = currentBar.close;
  const stopReference = direction === "LONG"
    ? entryReference - stopDistance
    : entryReference + stopDistance;
  if (stopReference <= 0) {
    return noSignal("NON_POSITIVE_TRADE_GEOMETRY", "The calculated stop must be positive", { momentum });
  }

  return Object.freeze({
    status: "CANDIDATE",
    strategyId: TS_MOMENTUM_STRATEGY_ID,
    direction,
    source: currentBar.source,
    symbol: currentBar.symbol,
    asOf: currentBar.closeTime,
    entryReference,
    stopReference,
    targetReference: null, // Slot 1's note applies identically: no fixed target, exits via EMA cross / time stop / hard-flat
    stopDistance,
    timeStopBars: strategy.signal.timeStopBars,
    momentum,
    ema: { current: currentEma, previous: previousEma }
  });
}

/**
 * Section 3, Slot 2's dynamic exit: "EMA20 cross against the position." Not
 * wired into runBacktest yet - see the note on evaluateTsMomentum above.
 */
export function checkTsMomentumEmaCrossExit({ bars15m, decisionIndex, direction }) {
  if (!Number.isInteger(decisionIndex) || decisionIndex < EMA_PERIOD - 1) {
    return Object.freeze({ exit: false, reason: "INDICATORS_COLD" });
  }
  if (direction !== "LONG" && direction !== "SHORT") {
    throw new Error('direction must be "LONG" or "SHORT"');
  }
  const emaSeries = emaSeriesThrough(bars15m, decisionIndex);
  const currentEma = emaSeries.values[decisionIndex];
  if (currentEma === null) return Object.freeze({ exit: false, reason: "INDICATORS_COLD" });
  const currentBar = bars15m[decisionIndex];
  const exit = direction === "LONG" ? currentBar.close < currentEma : currentBar.close > currentEma;
  return Object.freeze({ exit, ema: currentEma });
}
