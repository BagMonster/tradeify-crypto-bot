import { assessIndicatorReadiness, calculateIndicatorSnapshot } from "../../indicators.js";
import { SIGNAL_STRATEGY_ID, evaluateSignal } from "../../signalEngine.js";

export { SIGNAL_STRATEGY_ID };

/**
 * Section 4's warm-up minimums as production computes them for the
 * configured strategy: the same public assessIndicatorReadiness formula,
 * evaluated with zero counts so only its derived `required` figures are
 * used. This is never re-implemented separately here, so a future change to
 * that formula in src/indicators.js is picked up automatically.
 */
export function requiredWarmupCounts(strategy) {
  return assessIndicatorReadiness({ "15m": 0, "4h": 0, "1d": 0 }, strategy).required;
}

/**
 * The trailing `count` bars whose closeTime is at or before asOfMs. Returns
 * fewer than `count` (down to an empty array) rather than throwing when not
 * enough causal history exists yet — calculateIndicatorSnapshot's own
 * readiness check turns that into a cold snapshot, matching the codebase's
 * existing "cold means no partial values" behavior.
 */
function causalSlice(bars, asOfMs, count) {
  let end = -1;
  for (let index = bars.length - 1; index >= 0; index -= 1) {
    if (Date.parse(bars[index].closeTime) <= asOfMs) {
      end = index;
      break;
    }
  }
  if (end === -1) return [];
  const start = Math.max(0, end - count + 1);
  return bars.slice(start, end + 1);
}

function snapshotAt(bars15m, bars4h, bars1d, index, required, strategy) {
  const asOfMs = Date.parse(bars15m[index].closeTime);
  const window15m = bars15m.slice(Math.max(0, index - required["15m"] + 1), index + 1);
  const window4h = causalSlice(bars4h, asOfMs, required["4h"]);
  const window1d = causalSlice(bars1d, asOfMs, required["1d"]);
  return calculateIndicatorSnapshot({ bars15m: window15m, bars4h: window4h, bars1d: window1d, strategy });
}

/**
 * Section 3 Slot 3: calls evaluateSignal from src/signalEngine.js
 * unmodified. This adapter's only job is shaping stored bars into the
 * two-consecutive-snapshot input the engine already requires, using exactly
 * production's trailing warm-up window sizes (requiredWarmupCounts) ending
 * at each decision time — never the full available history, matching how
 * src/indicators.js's refreshStoredIndicatorSnapshot always fetches exactly
 * readiness.required[timeframe] bars, not everything on hand. No strategy
 * logic lives here: if research and the live bot ever disagree about this
 * strategy, that is a defect in this file, not a difference of opinion.
 */
export function evaluateMeanReversion({ bars15m, bars4h, bars1d, decisionIndex, strategy }) {
  if (!Number.isInteger(decisionIndex) || decisionIndex < 1) {
    throw new Error("decisionIndex must be an integer of at least 1 (a prior bar must exist)");
  }
  const required = requiredWarmupCounts(strategy);
  const current = snapshotAt(bars15m, bars4h, bars1d, decisionIndex, required, strategy);
  const previous = snapshotAt(bars15m, bars4h, bars1d, decisionIndex - 1, required, strategy);
  return evaluateSignal({ previous, current, strategy });
}
