const BAR_INTERVAL_MS = Object.freeze({
  "15m": 15 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000
});

export const INDICATOR_WARMUP_REQUIREMENTS = Object.freeze({
  "15m": 50,
  "4h": 40,
  "1d": 25
});

function requirePositiveInteger(name, value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function requirePositiveNumber(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return value;
}

function requireFiniteNumber(name, value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be finite`);
  return number;
}

function requireStrategy(strategy) {
  if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) {
    throw new Error("strategy must be an object");
  }
  const signal = strategy.signal;
  const regime = strategy.regime;
  if (!signal || !regime) throw new Error("strategy must define signal and regime settings");
  return Object.freeze({
    bbPeriod: requirePositiveInteger("strategy.signal.bbPeriod", signal.bbPeriod),
    bbStdDev: requirePositiveNumber("strategy.signal.bbStdDev", signal.bbStdDev),
    rsiPeriod: requirePositiveInteger("strategy.signal.rsiPeriod", signal.rsiPeriod),
    atrPeriod: requirePositiveInteger("strategy.signal.atrPeriod", signal.atrPeriod),
    adxPeriod: requirePositiveInteger("strategy.regime.adxPeriod", regime.adxPeriod)
  });
}

function normalizeCloses(closes, minimumLength, name = "closes") {
  if (!Array.isArray(closes) || closes.length < minimumLength) {
    throw new Error(`${name} must contain at least ${minimumLength} values`);
  }
  return closes.map((value, index) => requirePositiveNumber(`${name}[${index}]`, value));
}

function normalizeBars(bars, timeframe) {
  const intervalMs = BAR_INTERVAL_MS[timeframe];
  if (!intervalMs) throw new Error("timeframe must be 15m, 4h, or 1d");
  if (!Array.isArray(bars)) throw new Error(`${timeframe} bars must be an array`);

  let expectedSource = null;
  let expectedSymbol = null;
  let previousCloseTime = null;
  return bars.map((input, index) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error(`${timeframe} bars[${index}] must be an object`);
    }
    if (input.isClosed !== true) {
      throw new Error(`${timeframe} bars[${index}] must be completed`);
    }
    if (input.timeframe !== timeframe) {
      throw new Error(`${timeframe} bars[${index}] has the wrong timeframe`);
    }
    if (typeof input.source !== "string" || input.source.trim() === "" ||
        typeof input.symbol !== "string" || input.symbol.trim() === "") {
      throw new Error(`${timeframe} bars[${index}] must preserve source and symbol`);
    }

    const source = input.source.trim();
    const symbol = input.symbol.trim();
    expectedSource ??= source;
    expectedSymbol ??= symbol;
    if (source !== expectedSource || symbol !== expectedSymbol) {
      throw new Error(`${timeframe} bars must use one source and symbol`);
    }

    const openTime = Date.parse(input.openTime);
    const closeTime = Date.parse(input.closeTime);
    if (!Number.isFinite(openTime) || !Number.isFinite(closeTime)) {
      throw new Error(`${timeframe} bars[${index}] must have valid timestamps`);
    }
    if (openTime % intervalMs !== 0 || closeTime - openTime !== intervalMs) {
      throw new Error(`${timeframe} bars[${index}] must be UTC-aligned and completed`);
    }
    if (previousCloseTime !== null && openTime !== previousCloseTime) {
      throw new Error(`${timeframe} bars must be chronological and contiguous`);
    }
    previousCloseTime = closeTime;

    const open = requirePositiveNumber(`${timeframe} bars[${index}].open`, Number(input.open));
    const high = requirePositiveNumber(`${timeframe} bars[${index}].high`, Number(input.high));
    const low = requirePositiveNumber(`${timeframe} bars[${index}].low`, Number(input.low));
    const close = requirePositiveNumber(`${timeframe} bars[${index}].close`, Number(input.close));
    if (high < Math.max(open, low, close) || low > Math.min(open, high, close)) {
      throw new Error(`${timeframe} bars[${index}] has inconsistent OHLC values`);
    }

    return Object.freeze({
      source,
      symbol,
      timeframe,
      openTime,
      closeTime,
      open,
      high,
      low,
      close,
      isClosed: true
    });
  });
}

function freezeIndicator(value) {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object" && !Object.isFrozen(nested)) Object.freeze(nested);
  }
  return Object.freeze(value);
}

export function calculateBollingerBands(closes, { period, stdDevMultiplier }) {
  const normalizedPeriod = requirePositiveInteger("period", period);
  const multiplier = requirePositiveNumber("stdDevMultiplier", stdDevMultiplier);
  const values = normalizeCloses(closes, normalizedPeriod);
  const window = values.slice(-normalizedPeriod);
  const middle = window.reduce((sum, value) => sum + value, 0) / normalizedPeriod;
  const variance = window.reduce((sum, value) => sum + ((value - middle) ** 2), 0) /
    normalizedPeriod;
  const standardDeviation = Math.sqrt(variance);
  return Object.freeze({
    period: normalizedPeriod,
    stdDevMultiplier: multiplier,
    middle,
    upper: middle + (standardDeviation * multiplier),
    lower: middle - (standardDeviation * multiplier),
    standardDeviation,
    latestClose: window.at(-1)
  });
}

export function calculateRsi(closes, { period }) {
  const normalizedPeriod = requirePositiveInteger("period", period);
  const values = normalizeCloses(closes, normalizedPeriod + 1);
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= normalizedPeriod; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain += Math.max(change, 0);
    averageLoss += Math.max(-change, 0);
  }
  averageGain /= normalizedPeriod;
  averageLoss /= normalizedPeriod;

  for (let index = normalizedPeriod + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    averageGain = ((averageGain * (normalizedPeriod - 1)) + gain) / normalizedPeriod;
    averageLoss = ((averageLoss * (normalizedPeriod - 1)) + loss) / normalizedPeriod;
  }

  let value;
  if (averageGain === 0 && averageLoss === 0) value = 50;
  else if (averageLoss === 0) value = 100;
  else if (averageGain === 0) value = 0;
  else value = 100 - (100 / (1 + (averageGain / averageLoss)));

  return Object.freeze({ period: normalizedPeriod, value, averageGain, averageLoss });
}

function trueRange(current, previousClose) {
  return Math.max(
    current.high - current.low,
    Math.abs(current.high - previousClose),
    Math.abs(current.low - previousClose)
  );
}

export function calculateAtr(bars, { period, timeframe }) {
  const normalizedPeriod = requirePositiveInteger("period", period);
  const normalizedBars = normalizeBars(bars, timeframe);
  if (normalizedBars.length < normalizedPeriod + 1) {
    throw new Error(`${timeframe} bars must contain at least ${normalizedPeriod + 1} values for ATR`);
  }

  const ranges = [];
  for (let index = 1; index < normalizedBars.length; index += 1) {
    ranges.push(trueRange(normalizedBars[index], normalizedBars[index - 1].close));
  }
  let value = ranges.slice(0, normalizedPeriod)
    .reduce((sum, range) => sum + range, 0) / normalizedPeriod;
  for (let index = normalizedPeriod; index < ranges.length; index += 1) {
    value = ((value * (normalizedPeriod - 1)) + ranges[index]) / normalizedPeriod;
  }

  const latestClose = normalizedBars.at(-1).close;
  return Object.freeze({
    period: normalizedPeriod,
    timeframe,
    value,
    percentOfClose: value / latestClose,
    latestClose
  });
}

function directionalValues(current, previous) {
  const upwardMove = current.high - previous.high;
  const downwardMove = previous.low - current.low;
  return {
    trueRange: trueRange(current, previous.close),
    plusDm: upwardMove > downwardMove && upwardMove > 0 ? upwardMove : 0,
    minusDm: downwardMove > upwardMove && downwardMove > 0 ? downwardMove : 0
  };
}

function directionalIndex(smoothedTrueRange, smoothedPlusDm, smoothedMinusDm) {
  if (smoothedTrueRange === 0) return { plusDi: 0, minusDi: 0, dx: 0 };
  const plusDi = 100 * (smoothedPlusDm / smoothedTrueRange);
  const minusDi = 100 * (smoothedMinusDm / smoothedTrueRange);
  const total = plusDi + minusDi;
  const dx = total === 0 ? 0 : 100 * (Math.abs(plusDi - minusDi) / total);
  return { plusDi, minusDi, dx };
}

export function calculateAdx(bars, { period, timeframe = "4h" }) {
  const normalizedPeriod = requirePositiveInteger("period", period);
  const normalizedBars = normalizeBars(bars, timeframe);
  const minimumBars = normalizedPeriod * 2;
  if (normalizedBars.length < minimumBars) {
    throw new Error(`${timeframe} bars must contain at least ${minimumBars} values for ADX`);
  }

  const values = [];
  for (let index = 1; index < normalizedBars.length; index += 1) {
    values.push(directionalValues(normalizedBars[index], normalizedBars[index - 1]));
  }

  let smoothedTrueRange = 0;
  let smoothedPlusDm = 0;
  let smoothedMinusDm = 0;
  for (let index = 0; index < normalizedPeriod; index += 1) {
    smoothedTrueRange += values[index].trueRange;
    smoothedPlusDm += values[index].plusDm;
    smoothedMinusDm += values[index].minusDm;
  }

  const directionalIndexes = [directionalIndex(
    smoothedTrueRange,
    smoothedPlusDm,
    smoothedMinusDm
  )];
  for (let index = normalizedPeriod; index < values.length; index += 1) {
    smoothedTrueRange = smoothedTrueRange - (smoothedTrueRange / normalizedPeriod) +
      values[index].trueRange;
    smoothedPlusDm = smoothedPlusDm - (smoothedPlusDm / normalizedPeriod) +
      values[index].plusDm;
    smoothedMinusDm = smoothedMinusDm - (smoothedMinusDm / normalizedPeriod) +
      values[index].minusDm;
    directionalIndexes.push(directionalIndex(
      smoothedTrueRange,
      smoothedPlusDm,
      smoothedMinusDm
    ));
  }

  if (directionalIndexes.length < normalizedPeriod) {
    throw new Error(`${timeframe} bars do not contain enough directional indexes for ADX`);
  }
  let value = directionalIndexes.slice(0, normalizedPeriod)
    .reduce((sum, item) => sum + item.dx, 0) / normalizedPeriod;
  for (let index = normalizedPeriod; index < directionalIndexes.length; index += 1) {
    value = ((value * (normalizedPeriod - 1)) + directionalIndexes[index].dx) /
      normalizedPeriod;
  }

  const latest = directionalIndexes.at(-1);
  return Object.freeze({
    period: normalizedPeriod,
    timeframe,
    value,
    plusDi: latest.plusDi,
    minusDi: latest.minusDi
  });
}

export function assessIndicatorReadiness(counts, strategy) {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    throw new Error("counts must be an object");
  }
  const settings = requireStrategy(strategy);
  const normalizedCounts = {};
  for (const timeframe of Object.keys(INDICATOR_WARMUP_REQUIREMENTS)) {
    const value = requireFiniteNumber(`counts.${timeframe}`, counts[timeframe]);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`counts.${timeframe} must be a non-negative integer`);
    }
    normalizedCounts[timeframe] = value;
  }

  const required = Object.freeze({
    "15m": Math.max(
      INDICATOR_WARMUP_REQUIREMENTS["15m"],
      settings.bbPeriod,
      settings.rsiPeriod + 1,
      settings.atrPeriod + 1
    ),
    "4h": Math.max(INDICATOR_WARMUP_REQUIREMENTS["4h"], settings.adxPeriod * 2),
    "1d": Math.max(INDICATOR_WARMUP_REQUIREMENTS["1d"], settings.atrPeriod + 1)
  });
  const missing = Object.freeze(Object.fromEntries(
    Object.keys(required)
      .filter((timeframe) => normalizedCounts[timeframe] < required[timeframe])
      .map((timeframe) => [timeframe, required[timeframe] - normalizedCounts[timeframe]])
  ));
  return freezeIndicator({
    warm: Object.keys(missing).length === 0,
    counts: Object.freeze(normalizedCounts),
    required,
    missing
  });
}

export function calculateIndicatorSnapshot({ bars15m, bars4h, bars1d, strategy }) {
  const normalized15m = normalizeBars(bars15m, "15m");
  const normalized4h = normalizeBars(bars4h, "4h");
  const normalized1d = normalizeBars(bars1d, "1d");
  const settings = requireStrategy(strategy);
  const readiness = assessIndicatorReadiness({
    "15m": normalized15m.length,
    "4h": normalized4h.length,
    "1d": normalized1d.length
  }, strategy);

  if (!readiness.warm) {
    return freezeIndicator({
      ...readiness,
      source: normalized15m[0]?.source ?? normalized4h[0]?.source ?? normalized1d[0]?.source ?? null,
      symbol: normalized15m[0]?.symbol ?? normalized4h[0]?.symbol ?? normalized1d[0]?.symbol ?? null,
      asOf: null,
      bollinger15m: null,
      rsi15m: null,
      atr15m: null,
      adx4h: null,
      atr1d: null
    });
  }

  const source = normalized15m[0].source;
  const symbol = normalized15m[0].symbol;
  for (const bars of [normalized4h, normalized1d]) {
    if (bars[0].source !== source || bars[0].symbol !== symbol) {
      throw new Error("all indicator timeframes must use one source and symbol");
    }
  }

  const closes15m = normalized15m.map((bar) => bar.close);
  const snapshot = {
    ...readiness,
    source,
    symbol,
    asOf: Object.freeze({
      "15m": new Date(normalized15m.at(-1).closeTime).toISOString(),
      "4h": new Date(normalized4h.at(-1).closeTime).toISOString(),
      "1d": new Date(normalized1d.at(-1).closeTime).toISOString()
    }),
    bollinger15m: calculateBollingerBands(closes15m, {
      period: settings.bbPeriod,
      stdDevMultiplier: settings.bbStdDev
    }),
    rsi15m: calculateRsi(closes15m, { period: settings.rsiPeriod }),
    atr15m: calculateAtr(bars15m, { period: settings.atrPeriod, timeframe: "15m" }),
    adx4h: calculateAdx(bars4h, { period: settings.adxPeriod, timeframe: "4h" }),
    atr1d: calculateAtr(bars1d, { period: settings.atrPeriod, timeframe: "1d" })
  };
  return freezeIndicator(snapshot);
}

export async function refreshStoredIndicatorSnapshot({
  database,
  strategy,
  source = "binance",
  symbol = "BTCUSDT"
}) {
  if (!database || typeof database.getBarCounts !== "function" ||
      typeof database.getBars !== "function" ||
      typeof database.setIndicatorsWarm !== "function") {
    throw new Error("database must provide getBarCounts, getBars, and setIndicatorsWarm");
  }
  if (typeof source !== "string" || source.trim() === "" ||
      typeof symbol !== "string" || symbol.trim() === "") {
    throw new Error("source and symbol must be non-empty strings");
  }

  await database.setIndicatorsWarm(false);
  const counts = await database.getBarCounts({ source, symbol });
  const readiness = assessIndicatorReadiness(counts, strategy);
  if (!readiness.warm) return readiness;

  const [bars15m, bars4h, bars1d] = await Promise.all([
    database.getBars({ source, symbol, timeframe: "15m", limit: readiness.required["15m"] }),
    database.getBars({ source, symbol, timeframe: "4h", limit: readiness.required["4h"] }),
    database.getBars({ source, symbol, timeframe: "1d", limit: readiness.required["1d"] })
  ]);
  const snapshot = calculateIndicatorSnapshot({ bars15m, bars4h, bars1d, strategy });
  await database.setIndicatorsWarm(snapshot.warm);
  return snapshot;
}

// ---------------------------------------------------------------------------
// Chapter 26 research additions (frozen contract Section 4.1). Everything
// above this line is byte-for-byte unchanged: INDICATOR_WARMUP_REQUIREMENTS,
// calculateBollingerBands, calculateRsi, calculateAtr, calculateAdx,
// assessIndicatorReadiness, calculateIndicatorSnapshot, and
// refreshStoredIndicatorSnapshot are untouched, and index.mjs's Stage A
// readiness contract is unaffected. A diff against the pre-Chapter-26 file
// must show additions only, at the end of the file.
// ---------------------------------------------------------------------------

/**
 * Standard EMA, seeded with the SMA of the first `period` values of
 * `values`, then the usual alpha = 2/(period+1) recursion (Section 3, Slot
 * 2: "EMA20 seeded with the SMA of the first 20 available bars ... Seeding
 * must be explicit or the series is not reproducible"). EMA is recursive -
 * unlike calculateBollingerBands/calculateAtr its value depends on every
 * prior point back to the seed, not just a trailing window - so this
 * returns the full causal series (one entry per input value) rather than a
 * single "latest" snapshot: callers that need two consecutive points (as
 * Slot 2's EMA-reclaim rule does) read two adjacent indices of one series
 * computed once, instead of re-seeding twice from two different windows.
 * Entries before the seed point (index < period - 1) are null.
 */
export function ema(values, period) {
  const normalizedPeriod = requirePositiveInteger("period", period);
  const series = normalizeCloses(values, normalizedPeriod, "values");
  const alpha = 2 / (normalizedPeriod + 1);
  const result = new Array(series.length).fill(null);
  const seed = series.slice(0, normalizedPeriod)
    .reduce((sum, value) => sum + value, 0) / normalizedPeriod;
  result[normalizedPeriod - 1] = seed;
  let previous = seed;
  for (let index = normalizedPeriod; index < series.length; index += 1) {
    previous += (series[index] - previous) * alpha;
    result[index] = previous;
  }
  return Object.freeze({ period: normalizedPeriod, alpha, values: Object.freeze(result) });
}

/**
 * Section 3, Slot 1: highest high / lowest low over the trailing `period`
 * bars in `bars` - the same "pass a window, read the latest point" shape as
 * calculateBollingerBands/calculateAtr. Callers pass the PRIOR N bars
 * (current bar excluded) to get "highest high of the prior 20 completed 15m
 * bars (current bar excluded)"; this function does not exclude anything
 * itself, it windows whatever it is given. 15m-only, matching Section 3's
 * "Timeframe: 15m" for every slot that uses this.
 */
export function donchianChannel(bars, period) {
  const normalizedPeriod = requirePositiveInteger("period", period);
  const normalizedBars = normalizeBars(bars, "15m");
  if (normalizedBars.length < normalizedPeriod) {
    throw new Error(`15m bars must contain at least ${normalizedPeriod} values for the Donchian channel`);
  }
  const window = normalizedBars.slice(-normalizedPeriod);
  return Object.freeze({
    period: normalizedPeriod,
    highestHigh: Math.max(...window.map((bar) => bar.high)),
    lowestLow: Math.min(...window.map((bar) => bar.low))
  });
}

/**
 * Section 3, Slot 2: sign(close[t] - close[t-lookback]). Non-recursive - the
 * result depends only on two fixed points, not a running series - so unlike
 * ema() this evaluates the LATEST point in `closes`, matching the
 * calculateBollingerBands/calculateAtr calling convention.
 */
export function timeSeriesMomentum(closes, lookback) {
  const normalizedLookback = requirePositiveInteger("lookback", lookback);
  const series = normalizeCloses(closes, normalizedLookback + 1, "closes");
  const current = series.at(-1);
  const past = series.at(-1 - normalizedLookback);
  const change = current - past;
  return Object.freeze({
    lookback: normalizedLookback,
    current,
    past,
    change,
    direction: change > 0 ? "LONG" : (change < 0 ? "SHORT" : "FLAT")
  });
}

/**
 * Section 3, Slot 4: the Nth percentile of the trailing `window` Bollinger
 * bandwidth values, using the nearest-rank method (no interpolation) for a
 * deterministic, unambiguous threshold - the contract specifies "the Nth
 * percentile" without naming a method, so nearest-rank is this file's
 * explicit, documented choice. `bandwidths` must already be
 * (upper - lower) / middle values computed elsewhere (this function does not
 * compute Bollinger bands itself); callers pass the PRIOR `window`
 * bandwidths (the current bar's own bandwidth excluded), matching "the
 * prior 480 completed bars."
 */
export function bollingerBandwidthPercentile(bandwidths, window, percentile) {
  const normalizedWindow = requirePositiveInteger("window", window);
  const normalizedPercentile = requireFiniteNumber("percentile", percentile);
  if (normalizedPercentile < 0 || normalizedPercentile > 100) {
    throw new Error("percentile must be between 0 and 100");
  }
  if (!Array.isArray(bandwidths) || bandwidths.length < normalizedWindow) {
    throw new Error(`bandwidths must contain at least ${normalizedWindow} values`);
  }
  const values = bandwidths.map((value, index) => {
    const number = requireFiniteNumber(`bandwidths[${index}]`, value);
    if (number < 0) throw new Error(`bandwidths[${index}] must be non-negative`);
    return number;
  });
  const sorted = values.slice(-normalizedWindow).sort((left, right) => left - right);
  const rank = Math.min(
    sorted.length,
    Math.max(1, Math.ceil((normalizedPercentile / 100) * sorted.length))
  );
  return Object.freeze({
    window: normalizedWindow,
    percentile: normalizedPercentile,
    value: sorted[rank - 1]
  });
}
