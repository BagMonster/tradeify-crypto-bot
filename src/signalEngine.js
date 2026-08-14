import { INDICATOR_WARMUP_REQUIREMENTS } from "./indicators.js";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const TIMEFRAME_MS = Object.freeze({
  "15m": FIFTEEN_MINUTES_MS,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000
});

export const SIGNAL_STRATEGY_ID = "bollinger-rsi-mean-reversion";

function requireObject(name, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function requireBoolean(name, value) {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}

function requireFiniteNumber(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function requirePositiveNumber(name, value) {
  const number = requireFiniteNumber(name, value);
  if (number <= 0) throw new Error(`${name} must be positive`);
  return number;
}

function requireNonNegativeNumber(name, value) {
  const number = requireFiniteNumber(name, value);
  if (number < 0) throw new Error(`${name} must be non-negative`);
  return number;
}

function requirePositiveInteger(name, value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function requireText(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function requireUtcTimestamp(name, value) {
  const text = requireText(name, value);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    throw new Error(`${name} must be a canonical UTC timestamp`);
  }
  return milliseconds;
}

function nearlyEqual(left, right) {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= (Number.EPSILON * scale * 32);
}

function freezeResult(value) {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object" && !Object.isFrozen(nested)) {
      Object.freeze(nested);
    }
  }
  return Object.freeze(value);
}

function normalizeStrategy(strategy) {
  const input = requireObject("strategy", strategy);
  const signal = requireObject("strategy.signal", input.signal);
  const regime = requireObject("strategy.regime", input.regime);

  const normalized = {
    bbPeriod: requirePositiveInteger("strategy.signal.bbPeriod", signal.bbPeriod),
    bbStdDev: requirePositiveNumber("strategy.signal.bbStdDev", signal.bbStdDev),
    rsiPeriod: requirePositiveInteger("strategy.signal.rsiPeriod", signal.rsiPeriod),
    rsiLongThreshold: requireFiniteNumber(
      "strategy.signal.rsiLongThreshold",
      signal.rsiLongThreshold
    ),
    rsiShortThreshold: requireFiniteNumber(
      "strategy.signal.rsiShortThreshold",
      signal.rsiShortThreshold
    ),
    requireCloseInsideBand: requireBoolean(
      "strategy.signal.requireCloseInsideBand",
      signal.requireCloseInsideBand
    ),
    atrPeriod: requirePositiveInteger("strategy.signal.atrPeriod", signal.atrPeriod),
    stopAtrMultiple: requirePositiveNumber(
      "strategy.signal.stopAtrMultiple",
      signal.stopAtrMultiple
    ),
    timeStopBars: requirePositiveInteger("strategy.signal.timeStopBars", signal.timeStopBars),
    minDailyAtrPct: requirePositiveNumber(
      "strategy.regime.minDailyAtrPct",
      regime.minDailyAtrPct
    ),
    maxDailyAtrPct: requirePositiveNumber(
      "strategy.regime.maxDailyAtrPct",
      regime.maxDailyAtrPct
    ),
    adxPeriod: requirePositiveInteger("strategy.regime.adxPeriod", regime.adxPeriod),
    adxMax: requireNonNegativeNumber("strategy.regime.adxMax", regime.adxMax),
    adxStandDown: requirePositiveNumber(
      "strategy.regime.adxStandDown",
      regime.adxStandDown
    ),
    rangeBandStdDev: requirePositiveNumber(
      "strategy.regime.rangeBandStdDev",
      regime.rangeBandStdDev
    )
  };

  if (normalized.rsiLongThreshold < 0 || normalized.rsiShortThreshold > 100 ||
      normalized.rsiLongThreshold >= normalized.rsiShortThreshold) {
    throw new Error("strategy RSI thresholds must satisfy 0 <= long < short <= 100");
  }
  if (normalized.maxDailyAtrPct <= normalized.minDailyAtrPct) {
    throw new Error("strategy.regime.maxDailyAtrPct must exceed minDailyAtrPct");
  }
  if (normalized.adxMax > 100 || normalized.adxStandDown > 100 ||
      normalized.adxStandDown <= normalized.adxMax) {
    throw new Error("strategy ADX thresholds must satisfy 0 <= max < stand-down <= 100");
  }
  if (normalized.rangeBandStdDev <= normalized.bbStdDev) {
    throw new Error("strategy.regime.rangeBandStdDev must exceed signal.bbStdDev");
  }
  return Object.freeze(normalized);
}

function normalizeBollinger(name, value, settings) {
  const input = requireObject(name, value);
  const period = requirePositiveInteger(`${name}.period`, input.period);
  const stdDevMultiplier = requirePositiveNumber(
    `${name}.stdDevMultiplier`,
    input.stdDevMultiplier
  );
  const middle = requirePositiveNumber(`${name}.middle`, input.middle);
  const upper = requirePositiveNumber(`${name}.upper`, input.upper);
  const lower = requirePositiveNumber(`${name}.lower`, input.lower);
  const standardDeviation = requireNonNegativeNumber(
    `${name}.standardDeviation`,
    input.standardDeviation
  );
  const latestClose = requirePositiveNumber(`${name}.latestClose`, input.latestClose);

  if (period !== settings.bbPeriod || !nearlyEqual(stdDevMultiplier, settings.bbStdDev)) {
    throw new Error(`${name} does not match the configured Bollinger settings`);
  }
  if (lower > middle || middle > upper) throw new Error(`${name} bands are inconsistent`);
  if (!nearlyEqual(upper, middle + (standardDeviation * stdDevMultiplier)) ||
      !nearlyEqual(lower, middle - (standardDeviation * stdDevMultiplier))) {
    throw new Error(`${name} values are internally inconsistent`);
  }
  return Object.freeze({ period, stdDevMultiplier, middle, upper, lower, standardDeviation,
    latestClose });
}

function normalizeRsi(name, value, settings) {
  const input = requireObject(name, value);
  const period = requirePositiveInteger(`${name}.period`, input.period);
  const result = requireFiniteNumber(`${name}.value`, input.value);
  if (period !== settings.rsiPeriod) throw new Error(`${name} period is not configured`);
  if (result < 0 || result > 100) throw new Error(`${name}.value must be between 0 and 100`);
  return Object.freeze({ period, value: result });
}

function normalizeAtr(name, value, settings, timeframe) {
  const input = requireObject(name, value);
  const period = requirePositiveInteger(`${name}.period`, input.period);
  if (period !== settings.atrPeriod || input.timeframe !== timeframe) {
    throw new Error(`${name} does not match the configured ATR settings`);
  }
  const result = requireNonNegativeNumber(`${name}.value`, input.value);
  const latestClose = requirePositiveNumber(`${name}.latestClose`, input.latestClose);
  const percentOfClose = requireNonNegativeNumber(
    `${name}.percentOfClose`,
    input.percentOfClose
  );
  if (!nearlyEqual(percentOfClose, result / latestClose)) {
    throw new Error(`${name}.percentOfClose is inconsistent`);
  }
  return Object.freeze({ period, timeframe, value: result, latestClose, percentOfClose });
}

function normalizeAdx(name, value, settings) {
  const input = requireObject(name, value);
  const period = requirePositiveInteger(`${name}.period`, input.period);
  if (period !== settings.adxPeriod || input.timeframe !== "4h") {
    throw new Error(`${name} does not match the configured ADX settings`);
  }
  const result = requireFiniteNumber(`${name}.value`, input.value);
  const plusDi = requireFiniteNumber(`${name}.plusDi`, input.plusDi);
  const minusDi = requireFiniteNumber(`${name}.minusDi`, input.minusDi);
  for (const [label, number] of [["value", result], ["plusDi", plusDi], ["minusDi", minusDi]]) {
    if (number < 0 || number > 100) throw new Error(`${name}.${label} must be between 0 and 100`);
  }
  return Object.freeze({ period, timeframe: "4h", value: result, plusDi, minusDi });
}

function normalizeWarmSnapshot(name, snapshot, settings) {
  const input = requireObject(name, snapshot);
  if (input.warm !== true) throw new Error(`${name} is not warm`);
  const source = requireText(`${name}.source`, input.source);
  const symbol = requireText(`${name}.symbol`, input.symbol);
  const asOf = requireObject(`${name}.asOf`, input.asOf);
  const asOfMs = Object.freeze({
    "15m": requireUtcTimestamp(`${name}.asOf.15m`, asOf["15m"]),
    "4h": requireUtcTimestamp(`${name}.asOf.4h`, asOf["4h"]),
    "1d": requireUtcTimestamp(`${name}.asOf.1d`, asOf["1d"])
  });
  for (const [timeframe, milliseconds] of Object.entries(asOfMs)) {
    if (milliseconds % TIMEFRAME_MS[timeframe] !== 0) {
      throw new Error(`${name}.asOf.${timeframe} must be UTC-aligned`);
    }
  }
  if (asOfMs["4h"] > asOfMs["15m"] || asOfMs["1d"] > asOfMs["15m"]) {
    throw new Error(`${name} contains a future higher-timeframe indicator`);
  }

  const countsInput = requireObject(`${name}.counts`, input.counts);
  const requiredInput = requireObject(`${name}.required`, input.required);
  const counts = {};
  const required = {};
  for (const timeframe of Object.keys(TIMEFRAME_MS)) {
    const count = requireNonNegativeNumber(`${name}.counts.${timeframe}`, countsInput[timeframe]);
    const minimum = requirePositiveInteger(
      `${name}.required.${timeframe}`,
      requiredInput[timeframe]
    );
    if (minimum !== INDICATOR_WARMUP_REQUIREMENTS[timeframe]) {
      throw new Error(`${name}.required.${timeframe} does not match indicator warm-up policy`);
    }
    if (!Number.isInteger(count)) throw new Error(`${name}.counts.${timeframe} must be an integer`);
    if (count < minimum) throw new Error(`${name} does not satisfy ${timeframe} warm-up history`);
    counts[timeframe] = count;
    required[timeframe] = minimum;
  }

  const bollinger15m = normalizeBollinger(
    `${name}.bollinger15m`,
    input.bollinger15m,
    settings
  );
  const rsi15m = normalizeRsi(`${name}.rsi15m`, input.rsi15m, settings);
  const atr15m = normalizeAtr(`${name}.atr15m`, input.atr15m, settings, "15m");
  const atr1d = normalizeAtr(`${name}.atr1d`, input.atr1d, settings, "1d");
  const adx4h = normalizeAdx(`${name}.adx4h`, input.adx4h, settings);
  if (!nearlyEqual(bollinger15m.latestClose, atr15m.latestClose)) {
    throw new Error(`${name} 15-minute indicators do not share one close`);
  }

  return freezeResult({ source, symbol, asOf: Object.freeze({ ...asOf }), asOfMs,
    counts: Object.freeze(counts), required: Object.freeze(required),
    bollinger15m, rsi15m, atr15m, atr1d, adx4h });
}

function noSignal(reasonCode, reason, details = {}) {
  return freezeResult({
    status: "NO_SIGNAL",
    strategyId: SIGNAL_STRATEGY_ID,
    direction: null,
    reasonCode,
    reason,
    ...details
  });
}

function allowedRegime(snapshot, settings) {
  const dailyAtrPct = snapshot.atr1d.percentOfClose;
  const adx = snapshot.adx4h.value;
  const deviation = snapshot.bollinger15m.standardDeviation;
  const zScore = deviation === 0
    ? 0
    : Math.abs(snapshot.bollinger15m.latestClose - snapshot.bollinger15m.middle) / deviation;

  if (dailyAtrPct < settings.minDailyAtrPct) {
    return freezeResult({ allowed: false, classification: "QUIET",
      reasonCode: "DAILY_ATR_BELOW_MINIMUM", dailyAtrPct, adx, zScore });
  }
  if (dailyAtrPct > settings.maxDailyAtrPct) {
    return freezeResult({ allowed: false, classification: "EXTREME_VOLATILITY",
      reasonCode: "DAILY_ATR_ABOVE_MAXIMUM", dailyAtrPct, adx, zScore });
  }
  if (adx >= settings.adxStandDown) {
    return freezeResult({ allowed: false, classification: "TRENDING",
      reasonCode: "ADX_STAND_DOWN", dailyAtrPct, adx, zScore });
  }
  if (adx > settings.adxMax) {
    return freezeResult({ allowed: false, classification: "UNCERTAIN",
      reasonCode: "ADX_UNCERTAIN", dailyAtrPct, adx, zScore });
  }
  if (zScore > settings.rangeBandStdDev) {
    return freezeResult({ allowed: false, classification: "EXTREME_PRICE",
      reasonCode: "PRICE_OUTSIDE_RANGE_BAND", dailyAtrPct, adx, zScore });
  }
  if (deviation === 0) {
    return freezeResult({ allowed: false, classification: "FLAT",
      reasonCode: "BOLLINGER_BAND_FLAT", dailyAtrPct, adx, zScore });
  }
  return freezeResult({ allowed: true, classification: "RANGE",
    reasonCode: "REGIME_ALLOWED", dailyAtrPct, adx, zScore });
}

export function evaluateMarketRegime(snapshot, strategy) {
  const settings = normalizeStrategy(strategy);
  const normalized = normalizeWarmSnapshot("snapshot", snapshot, settings);
  return allowedRegime(normalized, settings);
}

export function evaluateSignal({ previous, current, strategy }) {
  let settings;
  let previousSnapshot;
  let currentSnapshot;
  try {
    settings = normalizeStrategy(strategy);
    if (previous?.warm !== true || current?.warm !== true) {
      return noSignal("INDICATORS_COLD", "Both consecutive indicator snapshots must be warm");
    }
    previousSnapshot = normalizeWarmSnapshot("previous", previous, settings);
    currentSnapshot = normalizeWarmSnapshot("current", current, settings);
  } catch (error) {
    return noSignal("INVALID_INPUT", error.message);
  }

  const identity = Object.freeze({
    source: currentSnapshot.source,
    symbol: currentSnapshot.symbol,
    asOf: currentSnapshot.asOf["15m"]
  });
  if (previousSnapshot.source !== currentSnapshot.source ||
      previousSnapshot.symbol !== currentSnapshot.symbol) {
    return noSignal("IDENTITY_MISMATCH", "Snapshots must use one source and symbol", identity);
  }
  if (currentSnapshot.asOfMs["15m"] - previousSnapshot.asOfMs["15m"] !==
      FIFTEEN_MINUTES_MS) {
    return noSignal(
      "NON_CONSECUTIVE_SNAPSHOTS",
      "Signal evaluation requires consecutive completed 15-minute snapshots",
      identity
    );
  }
  if (currentSnapshot.asOfMs["4h"] < previousSnapshot.asOfMs["4h"] ||
      currentSnapshot.asOfMs["1d"] < previousSnapshot.asOfMs["1d"]) {
    return noSignal(
      "NON_MONOTONIC_CONTEXT",
      "Higher-timeframe indicator timestamps cannot move backward",
      identity
    );
  }
  if (Object.keys(TIMEFRAME_MS).some(
    (timeframe) => currentSnapshot.counts[timeframe] < previousSnapshot.counts[timeframe]
  )) {
    return noSignal(
      "NON_MONOTONIC_CONTEXT",
      "Indicator history counts cannot move backward",
      identity
    );
  }

  const regime = allowedRegime(currentSnapshot, settings);
  if (!regime.allowed) {
    return noSignal(regime.reasonCode, "The configured market regime blocks this signal", {
      ...identity,
      regime
    });
  }

  const previousBand = previousSnapshot.bollinger15m;
  const currentBand = currentSnapshot.bollinger15m;
  const currentClose = currentBand.latestClose;
  const currentInsideBand = currentClose >= currentBand.lower &&
    currentClose <= currentBand.upper;
  const longBandCondition = previousBand.latestClose < previousBand.lower &&
    (settings.requireCloseInsideBand
      ? currentInsideBand && currentClose >= currentBand.lower
      : currentClose <= currentBand.lower);
  const shortBandCondition = previousBand.latestClose > previousBand.upper &&
    (settings.requireCloseInsideBand
      ? currentInsideBand && currentClose <= currentBand.upper
      : currentClose >= currentBand.upper);
  const longRsiCondition = currentSnapshot.rsi15m.value <= settings.rsiLongThreshold;
  const shortRsiCondition = currentSnapshot.rsi15m.value >= settings.rsiShortThreshold;
  const longQualified = longBandCondition && longRsiCondition;
  const shortQualified = shortBandCondition && shortRsiCondition;
  const conditions = Object.freeze({
    previousClose: previousBand.latestClose,
    currentClose,
    currentRsi: currentSnapshot.rsi15m.value,
    longBandCondition,
    longRsiCondition,
    shortBandCondition,
    shortRsiCondition
  });

  if (longQualified === shortQualified) {
    return noSignal(
      longQualified ? "CONFLICTING_SIGNAL" : "NO_QUALIFYING_SETUP",
      longQualified
        ? "Conflicting long and short conditions fail closed"
        : "No completed Bollinger re-entry and RSI combination qualifies",
      { ...identity, regime, conditions }
    );
  }

  const direction = longQualified ? "LONG" : "SHORT";
  const stopDistance = currentSnapshot.atr15m.value * settings.stopAtrMultiple;
  if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
    return noSignal("INVALID_STOP_DISTANCE", "ATR must produce a positive stop distance", {
      ...identity,
      regime,
      conditions
    });
  }
  const stopReference = direction === "LONG"
    ? currentClose - stopDistance
    : currentClose + stopDistance;
  const targetReference = currentBand.middle;
  const expectedReward = direction === "LONG"
    ? targetReference - currentClose
    : currentClose - targetReference;
  if (stopReference <= 0 || expectedReward <= 0) {
    return noSignal(
      "NON_POSITIVE_TRADE_GEOMETRY",
      "The calculated stop and middle-band target must define positive risk and reward",
      { ...identity, regime, conditions }
    );
  }

  return freezeResult({
    status: "CANDIDATE",
    strategyId: SIGNAL_STRATEGY_ID,
    direction,
    source: identity.source,
    symbol: identity.symbol,
    asOf: identity.asOf,
    entryReference: currentClose,
    stopReference,
    targetReference,
    stopDistance,
    expectedReward,
    rewardRiskRatio: expectedReward / stopDistance,
    timeStopBars: settings.timeStopBars,
    regime,
    conditions
  });
}
