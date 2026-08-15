import {
  INDICATOR_WARMUP_REQUIREMENTS,
  calculateAtr,
  calculateBollingerBands,
  donchianChannel,
  bollingerBandwidthPercentile
} from "../../indicators.js";

export const COMPRESSION_BREAKOUT_STRATEGY_ID = "compression-breakout";

/**
 * Section 3, Slot 4: "L in {10, 30} x N in {20th, 40th} = 4 variants...
 * Exactly one variant is selected using development-partition evidence
 * only (Section 6), then frozen." Selecting that one variant is Step 26.6's
 * job; this module just needs to be able to evaluate any of the four so a
 * later selection step has something to compare.
 */
export const COMPRESSION_VARIANTS = Object.freeze([
  Object.freeze({ id: "L10-N20", breakoutPeriod: 10, percentile: 20 }),
  Object.freeze({ id: "L10-N40", breakoutPeriod: 10, percentile: 40 }),
  Object.freeze({ id: "L30-N20", breakoutPeriod: 30, percentile: 20 }),
  Object.freeze({ id: "L30-N40", breakoutPeriod: 30, percentile: 40 })
]);

const PERCENTILE_WINDOW = 480; // 5 days of 15m bars

function noSignal(reasonCode, reason, details = {}) {
  return Object.freeze({
    status: "NO_SIGNAL",
    strategyId: COMPRESSION_BREAKOUT_STRATEGY_ID,
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

function bandwidthAt(bars15m, barIndex, bbPeriod, bbStdDev) {
  const closes = bars15m.slice(barIndex - bbPeriod + 1, barIndex + 1).map((bar) => bar.close);
  const bands = calculateBollingerBands(closes, { period: bbPeriod, stdDevMultiplier: bbStdDev });
  return (bands.upper - bands.lower) / bands.middle;
}

/**
 * The trailing PERCENTILE_WINDOW bandwidth values ending the bar BEFORE
 * decisionIndex - "the prior 480 completed bars" (current bar's own
 * bandwidth excluded, matching Slot 1's "current bar excluded" wording for
 * the same kind of prior-window rule). Bollinger bandwidth is
 * non-recursive (each point depends only on its own trailing bbPeriod
 * window), so unlike ema()'s series this can be, and is, recomputed fresh
 * on every call rather than cached - O(PERCENTILE_WINDOW * bbPeriod) per
 * call, same accepted correctness-first trade-off noted in
 * tsMomentum.js's emaSeriesThrough.
 */
function priorBandwidthSeries(bars15m, decisionIndex, bbPeriod, bbStdDev) {
  const series = [];
  for (let index = decisionIndex - PERCENTILE_WINDOW; index < decisionIndex; index += 1) {
    series.push(bandwidthAt(bars15m, index, bbPeriod, bbStdDev));
  }
  return series;
}

/**
 * Section 3, Slot 4 - entry only. Unlike Slots 1 and 2, this slot's table
 * lists only a protective stop and a time stop - no channel exit, no
 * trailing target. That means it needs no dynamic per-bar exit hook and is
 * fully compatible with src/research/backtestEngine.js's existing static
 * bracket as delivered in Step 26.3 (targetReference: null is already
 * handled there via Number.isFinite(position.targetReference)).
 */
export function evaluateCompressionBreakout({ bars15m, decisionIndex, strategy, variant }) {
  if (!Number.isInteger(decisionIndex) || decisionIndex < 1) {
    throw new Error("decisionIndex must be an integer of at least 1 (a prior bar must exist)");
  }
  if (!variant || !Number.isInteger(variant.breakoutPeriod) || !Number.isFinite(variant.percentile)) {
    throw new Error("variant must supply breakoutPeriod and percentile (see COMPRESSION_VARIANTS)");
  }

  const bbPeriod = strategy.signal.bbPeriod;
  const bbStdDev = strategy.signal.bbStdDev;
  // The earliest of the 480 prior bandwidth points itself needs bbPeriod - 1
  // bars of its own trailing history, so the true floor is
  // PERCENTILE_WINDOW + bbPeriod - 1 (499 at bbPeriod = 20) - independently
  // derived, and consistent with, but not copied from, the Section 4.2
  // "future activation" table's 500-bar figure for this slot.
  const requiredWarmupBars = PERCENTILE_WINDOW + bbPeriod - 1;
  if (decisionIndex < requiredWarmupBars) {
    return noSignal("INDICATORS_COLD", "Insufficient causal 15m history for the bandwidth percentile", { variant });
  }
  if (decisionIndex < variant.breakoutPeriod) {
    return noSignal("INDICATORS_COLD", "Insufficient causal 15m history for the breakout channel", { variant });
  }

  const priorBandwidths = priorBandwidthSeries(bars15m, decisionIndex, bbPeriod, bbStdDev);
  const threshold = bollingerBandwidthPercentile(priorBandwidths, PERCENTILE_WINDOW, variant.percentile);
  const currentBandwidth = bandwidthAt(bars15m, decisionIndex, bbPeriod, bbStdDev);
  const compressed = currentBandwidth <= threshold.value;
  if (!compressed) {
    return noSignal(
      "NOT_COMPRESSED",
      "Current bandwidth is above the trailing percentile threshold",
      { variant, currentBandwidth, threshold }
    );
  }

  const currentBar = bars15m[decisionIndex];
  const priorWindow = bars15m.slice(decisionIndex - variant.breakoutPeriod, decisionIndex);
  const channel = donchianChannel(priorWindow, variant.breakoutPeriod);
  const longEntry = currentBar.close > channel.highestHigh;
  const shortEntry = currentBar.close < channel.lowestLow;
  if (longEntry === shortEntry) {
    return noSignal(
      longEntry ? "CONFLICTING_SIGNAL" : "NO_QUALIFYING_SETUP",
      longEntry
        ? "Conflicting long and short breakout conditions fail closed"
        : "Compressed, but close did not break the variant's channel",
      { variant, currentBandwidth, threshold, channel }
    );
  }
  const direction = longEntry ? "LONG" : "SHORT";

  let atr;
  try {
    atr = atrAt(bars15m, decisionIndex, strategy.signal.atrPeriod);
  } catch (error) {
    return noSignal("INDICATORS_COLD", error.message, { variant });
  }
  const stopDistance = atr.value * strategy.signal.stopAtrMultiple;
  if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
    return noSignal("INVALID_STOP_DISTANCE", "ATR must produce a positive stop distance", { variant });
  }
  const entryReference = currentBar.close;
  const stopReference = direction === "LONG"
    ? entryReference - stopDistance
    : entryReference + stopDistance;
  if (stopReference <= 0) {
    return noSignal("NON_POSITIVE_TRADE_GEOMETRY", "The calculated stop must be positive", { variant });
  }

  return Object.freeze({
    status: "CANDIDATE",
    strategyId: COMPRESSION_BREAKOUT_STRATEGY_ID,
    direction,
    source: currentBar.source,
    symbol: currentBar.symbol,
    asOf: currentBar.closeTime,
    entryReference,
    stopReference,
    targetReference: null,
    stopDistance,
    timeStopBars: strategy.signal.timeStopBars,
    variant: variant.id,
    currentBandwidth,
    threshold,
    channel
  });
}
