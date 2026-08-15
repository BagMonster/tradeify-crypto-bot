import { INDICATOR_WARMUP_REQUIREMENTS, calculateAtr, donchianChannel } from "../../indicators.js";

export const DONCHIAN_STRATEGY_ID = "donchian-breakout";

const ENTRY_PERIOD = 20;
const EXIT_PERIOD = 10;

/**
 * Purely-additive exports (Step 26.6) of this module's already-fixed
 * parameters, so a freeze record (src/research/manifest.js's
 * buildFreezeRecord) can cite the single source of truth instead of a
 * hand-copied duplicate that could silently drift from this file. No
 * existing behavior changes - ENTRY_PERIOD/EXIT_PERIOD are still used
 * exactly as before everywhere else in this module.
 */
export const DONCHIAN_ENTRY_PERIOD = ENTRY_PERIOD;
export const DONCHIAN_EXIT_PERIOD = EXIT_PERIOD;

/**
 * The bare minimum trailing 15m history this module's OWN math needs to
 * produce a first value: the larger of the entry channel's 20-bar window
 * and production's own indicator warm-up floor
 * (INDICATOR_WARMUP_REQUIREMENTS["15m"] = 50), which this module reuses for
 * its ATR window below rather than inventing a separate number. This is a
 * standalone-computability floor, NOT the frozen contract's Section 4.2
 * "per-strategy live warm-up" table (50 / 150 / 500 bars) - that table is
 * explicitly scoped to "a future activation chapter... not implemented in
 * Chapter 26." In a real backtest this floor is always dwarfed by the
 * ~3,841-bar (40 completed daily bar) research burn-in that a future
 * router.js (Step 26.5) must enforce before calling any strategy's evaluate
 * function at all - this constant only matters for this module's own
 * standalone correctness and tests.
 */
const REQUIRED_WARMUP_BARS = Math.max(ENTRY_PERIOD, INDICATOR_WARMUP_REQUIREMENTS["15m"]);

function noSignal(reasonCode, reason, details = {}) {
  return Object.freeze({
    status: "NO_SIGNAL",
    strategyId: DONCHIAN_STRATEGY_ID,
    direction: null,
    reasonCode,
    reason,
    ...details
  });
}

/**
 * ATR over a trailing window ending at decisionIndex, sized the same way
 * production sizes atr15m (INDICATOR_WARMUP_REQUIREMENTS["15m"] = 50 bars) -
 * matching src/research/strategies/meanReversion.js's precedent of using a
 * fixed, bounded trailing window rather than "everything available," since
 * calculateAtr's Wilder smoothing is itself path-dependent on how much
 * history is fed to it.
 */
function atrAt(bars15m, decisionIndex, atrPeriod) {
  const windowStart = Math.max(0, decisionIndex - INDICATOR_WARMUP_REQUIREMENTS["15m"] + 1);
  const window = bars15m.slice(windowStart, decisionIndex + 1);
  return calculateAtr(window, { period: atrPeriod, timeframe: "15m" });
}

/**
 * Section 3, Slot 1 - entry only. The channel exit ("Close < lowest low of
 * the prior 10 completed 15m bars" for a long / the mirror for a short) is
 * DYNAMIC: it is recomputed from a fresh 10-bar trailing window on every bar
 * a position is open, not a fixed price level set once at entry the way
 * Slot 3's Bollinger-middle target is.
 *
 * src/research/backtestEngine.js as delivered in Step 26.3 only models a
 * STATIC bracket (a fixed stop and a fixed target, both set once at entry) -
 * it has no hook to re-evaluate a strategy-specific exit condition bar by
 * bar. Wiring that in is Step 26.5's job (router.js, and very likely a small
 * generalization of resolveOpenPosition). Feeding a Donchian candidate into
 * today's runBacktest as-is would silently only ever exit via
 * protective-stop, time-stop, or hard-flat - never the channel exit - which
 * would NOT reproduce Slot 1's frozen rules. checkDonchianChannelExit below
 * exists now as a tested, ready-to-wire building block for that later step;
 * it is not wired into anything yet.
 */
export function evaluateDonchian({ bars15m, decisionIndex, strategy }) {
  if (!Number.isInteger(decisionIndex) || decisionIndex < 1) {
    throw new Error("decisionIndex must be an integer of at least 1 (a prior bar must exist)");
  }
  if (decisionIndex < REQUIRED_WARMUP_BARS) {
    return noSignal("INDICATORS_COLD", "Insufficient causal 15m history for the Donchian channel");
  }

  const currentBar = bars15m[decisionIndex];
  const priorWindow = bars15m.slice(decisionIndex - ENTRY_PERIOD, decisionIndex);
  const channel = donchianChannel(priorWindow, ENTRY_PERIOD);

  const longEntry = currentBar.close > channel.highestHigh;
  const shortEntry = currentBar.close < channel.lowestLow;
  if (longEntry === shortEntry) {
    return noSignal(
      longEntry ? "CONFLICTING_SIGNAL" : "NO_QUALIFYING_SETUP",
      longEntry
        ? "Conflicting long and short breakout conditions fail closed"
        : "Close did not break the prior 20-bar channel in either direction",
      { channel }
    );
  }
  const direction = longEntry ? "LONG" : "SHORT";

  let atr;
  try {
    atr = atrAt(bars15m, decisionIndex, strategy.signal.atrPeriod);
  } catch (error) {
    return noSignal("INDICATORS_COLD", error.message, { channel });
  }
  const stopDistance = atr.value * strategy.signal.stopAtrMultiple;
  if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
    return noSignal("INVALID_STOP_DISTANCE", "ATR must produce a positive stop distance", { channel });
  }
  const entryReference = currentBar.close;
  const stopReference = direction === "LONG"
    ? entryReference - stopDistance
    : entryReference + stopDistance;
  if (stopReference <= 0) {
    return noSignal("NON_POSITIVE_TRADE_GEOMETRY", "The calculated stop must be positive", { channel });
  }

  return Object.freeze({
    status: "CANDIDATE",
    strategyId: DONCHIAN_STRATEGY_ID,
    direction,
    source: currentBar.source,
    symbol: currentBar.symbol,
    asOf: currentBar.closeTime,
    entryReference,
    stopReference,
    // Slot 1 has no fixed target - it exits via the dynamic channel exit,
    // the time stop, or hard-flat. null (not a number) so a static-bracket
    // execution engine's Number.isFinite(targetReference) guard correctly
    // treats this candidate as having no target to check.
    targetReference: null,
    stopDistance,
    timeStopBars: strategy.signal.timeStopBars,
    channel
  });
}

/**
 * Section 3, Slot 1's dynamic channel exit, evaluated fresh at a given
 * decisionIndex for an already-open position: "Close < lowest low of the
 * prior 10 completed 15m bars" (long) / "Close > highest high of the prior
 * 10" (short). Not wired into runBacktest yet - see the note on
 * evaluateDonchian above.
 */
export function checkDonchianChannelExit({ bars15m, decisionIndex, direction }) {
  if (!Number.isInteger(decisionIndex) || decisionIndex < EXIT_PERIOD) {
    return Object.freeze({ exit: false, reason: "INDICATORS_COLD" });
  }
  if (direction !== "LONG" && direction !== "SHORT") {
    throw new Error('direction must be "LONG" or "SHORT"');
  }
  const currentBar = bars15m[decisionIndex];
  const priorWindow = bars15m.slice(decisionIndex - EXIT_PERIOD, decisionIndex);
  const channel = donchianChannel(priorWindow, EXIT_PERIOD);
  const exit = direction === "LONG"
    ? currentBar.close < channel.lowestLow
    : currentBar.close > channel.highestHigh;
  return Object.freeze({ exit, channel });
}
