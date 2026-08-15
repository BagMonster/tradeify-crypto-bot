import { calculateAdx, calculateAtr } from "../indicators.js";

export const REGIME_LABELS = Object.freeze({
  EXCLUDED_VOL: "EXCLUDED_VOL",
  RANGE: "RANGE",
  TRANSITIONAL: "TRANSITIONAL",
  TREND: "TREND"
});

/**
 * D-013: research burn-in of 40 completed daily bars, stricter than
 * production's 25, so daily Wilder ADX(14) has converged before any regime
 * label is trusted. This is the binding constraint (calculateAdx itself only
 * requires period * 2 = 28 daily bars).
 */
export const DAILY_REGIME_BURN_IN_BARS = 40;

function requireFiniteNumber(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function requireThresholds(thresholds) {
  if (!thresholds || typeof thresholds !== "object" || Array.isArray(thresholds)) {
    throw new Error("thresholds must be an object");
  }
  const minDailyAtrPct = requireFiniteNumber("thresholds.minDailyAtrPct", thresholds.minDailyAtrPct);
  const maxDailyAtrPct = requireFiniteNumber("thresholds.maxDailyAtrPct", thresholds.maxDailyAtrPct);
  const adxMax = requireFiniteNumber("thresholds.adxMax", thresholds.adxMax);
  const adxStandDown = requireFiniteNumber("thresholds.adxStandDown", thresholds.adxStandDown);
  if (minDailyAtrPct <= 0 || maxDailyAtrPct <= minDailyAtrPct) {
    throw new Error("thresholds.maxDailyAtrPct must exceed a positive minDailyAtrPct");
  }
  if (adxMax < 0 || adxStandDown <= adxMax) {
    throw new Error("thresholds.adxStandDown must exceed a non-negative adxMax");
  }
  return { minDailyAtrPct, maxDailyAtrPct, adxMax, adxStandDown };
}

/**
 * Section 5.2 regime taxonomy. Separates the taxonomy (a label describing the
 * market) from the permission gate (whether a specific route may trade in
 * that label) — see isRegimeTradable. Both of production's no-trade
 * conditions (daily ATR% band, ADX >= adxStandDown) survive intact as global
 * guards; TREND becomes a labelled, evaluable state instead of a blanket
 * stand-down.
 */
export function classifyDailyRegime({ dailyAtrPct, dailyAdx }, thresholds) {
  const settings = requireThresholds(thresholds);
  const atrPct = requireFiniteNumber("dailyAtrPct", dailyAtrPct);
  const adx = requireFiniteNumber("dailyAdx", dailyAdx);

  let label;
  if (atrPct < settings.minDailyAtrPct || atrPct > settings.maxDailyAtrPct) {
    label = REGIME_LABELS.EXCLUDED_VOL;
  } else if (adx <= settings.adxMax) {
    label = REGIME_LABELS.RANGE;
  } else if (adx <= settings.adxStandDown) {
    label = REGIME_LABELS.TRANSITIONAL;
  } else {
    label = REGIME_LABELS.TREND;
  }

  return Object.freeze({ label, dailyAtrPct: atrPct, dailyAdx: adx });
}

/** EXCLUDED_VOL and TRANSITIONAL permit no route; RANGE and TREND do. */
export function isRegimeTradable(label) {
  return label === REGIME_LABELS.RANGE || label === REGIME_LABELS.TREND;
}

/**
 * Computes a chronological regime label for every daily bar from the 40th
 * bar onward (D-013 burn-in), using only bars up to and including that bar
 * (causal — no lookahead). Each entry's ADX and ATR% are calculated with the
 * existing, unmodified src/indicators.js exports called against completed
 * daily bars (calculateAdx/calculateAtr are generic over timeframe; no new
 * indicator function is required for this).
 */
export function calculateDailyRegimeTimeline(dailyBars, { period = 14, thresholds } = {}) {
  if (!Array.isArray(dailyBars) || dailyBars.length < DAILY_REGIME_BURN_IN_BARS) {
    throw new Error(`dailyBars must contain at least ${DAILY_REGIME_BURN_IN_BARS} completed bars`);
  }
  const settings = requireThresholds(thresholds);

  const timeline = [];
  for (let index = DAILY_REGIME_BURN_IN_BARS - 1; index < dailyBars.length; index += 1) {
    const trailing = dailyBars.slice(0, index + 1);
    const adx = calculateAdx(trailing, { period, timeframe: "1d" });
    const atr = calculateAtr(trailing, { period, timeframe: "1d" });
    const classification = classifyDailyRegime(
      { dailyAtrPct: atr.percentOfClose, dailyAdx: adx.value },
      settings
    );

    const closeTimeMs = Date.parse(dailyBars[index].closeTime);
    if (!Number.isFinite(closeTimeMs)) {
      throw new Error(`dailyBars[${index}] must have a valid ISO closeTime`);
    }
    timeline.push(Object.freeze({
      closeTime: dailyBars[index].closeTime,
      closeTimeMs,
      label: classification.label,
      dailyAtrPct: classification.dailyAtrPct,
      dailyAdx: classification.dailyAdx
    }));
  }

  return Object.freeze(timeline);
}

/**
 * Section 5.2: "evaluated at each 15m decision time using the most recent
 * daily bar whose close time is at or before that decision time." Returns
 * null when no daily regime label exists yet at or before decisionTime (the
 * dataset is still inside the D-013 daily burn-in) — callers must treat a
 * null regime as no-trade, the same as EXCLUDED_VOL/TRANSITIONAL.
 */
export function regimeAtDecisionTime(timeline, decisionTime) {
  if (!Array.isArray(timeline)) throw new Error("timeline must be an array");
  const decisionTimeMs = typeof decisionTime === "number" ? decisionTime : Date.parse(decisionTime);
  if (!Number.isFinite(decisionTimeMs)) throw new Error("decisionTime must be a valid timestamp");

  let selected = null;
  for (const entry of timeline) {
    if (entry.closeTimeMs > decisionTimeMs) break;
    selected = entry;
  }
  return selected;
}

const VALID_DIRECTIONS = Object.freeze(["LONG", "SHORT"]);

/**
 * Section 5.3: a route is the triple (strategy, direction, regime label).
 * Only RANGE and TREND labels form valid routes — EXCLUDED_VOL and
 * TRANSITIONAL permit no route, so no strategy/direction may pair with them.
 */
export function routeId({ strategy, direction, regimeLabel }) {
  if (typeof strategy !== "string" || strategy.trim() === "") {
    throw new Error("strategy must be a non-empty string");
  }
  if (!VALID_DIRECTIONS.includes(direction)) {
    throw new Error("direction must be LONG or SHORT");
  }
  if (!isRegimeTradable(regimeLabel)) {
    throw new Error("regimeLabel must be RANGE or TREND to form a route");
  }
  const normalizedStrategy = strategy.trim();
  return Object.freeze({
    strategy: normalizedStrategy,
    direction,
    regimeLabel,
    id: `${normalizedStrategy}:${direction}:${regimeLabel}`
  });
}
