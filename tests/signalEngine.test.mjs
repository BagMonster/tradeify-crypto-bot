import test from "node:test";
import assert from "node:assert/strict";
import {
  SIGNAL_STRATEGY_ID,
  evaluateMarketRegime,
  evaluateSignal
} from "../src/signalEngine.js";

const STRATEGY = Object.freeze({
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

function snapshot({
  asOf = "2026-08-14T12:15:00.000Z",
  close = 100,
  middle = 100,
  standardDeviation = 5,
  rsi = 50,
  atr15m = 2,
  dailyAtrPct = 0.02,
  adx = 20,
  warm = true,
  source = "binance",
  symbol = "BTCUSDT"
} = {}) {
  return {
    warm,
    source,
    symbol,
    counts: { "15m": 50, "4h": 40, "1d": 25 },
    required: { "15m": 50, "4h": 40, "1d": 25 },
    asOf: {
      "15m": asOf,
      "4h": "2026-08-14T12:00:00.000Z",
      "1d": "2026-08-14T00:00:00.000Z"
    },
    bollinger15m: {
      period: 20,
      stdDevMultiplier: 2,
      middle,
      upper: middle + (standardDeviation * 2),
      lower: middle - (standardDeviation * 2),
      standardDeviation,
      latestClose: close
    },
    rsi15m: { period: 14, value: rsi },
    atr15m: {
      period: 14,
      timeframe: "15m",
      value: atr15m,
      latestClose: close,
      percentOfClose: atr15m / close
    },
    adx4h: {
      period: 14,
      timeframe: "4h",
      value: adx,
      plusDi: 20,
      minusDi: 20
    },
    atr1d: {
      period: 14,
      timeframe: "1d",
      value: 1_000,
      latestClose: 1_000 / dailyAtrPct,
      percentOfClose: dailyAtrPct
    }
  };
}

function pair({
  previousClose,
  currentClose,
  currentRsi,
  middle = 100,
  standardDeviation = 5,
  ...currentOverrides
}) {
  return {
    previous: snapshot({
      asOf: "2026-08-14T12:00:00.000Z",
      close: previousClose,
      middle,
      standardDeviation,
      rsi: currentRsi
    }),
    current: snapshot({
      close: currentClose,
      middle,
      standardDeviation,
      rsi: currentRsi,
      ...currentOverrides
    })
  };
}

test("1 - range regime is allowed only inside daily ATR and ADX limits", () => {
  const result = evaluateMarketRegime(snapshot(), STRATEGY);

  assert.equal(result.allowed, true);
  assert.equal(result.classification, "RANGE");
  assert.equal(result.reasonCode, "REGIME_ALLOWED");
});

test("2 - quiet, extreme-volatility, uncertain, and trending regimes fail closed", () => {
  const cases = [
    [snapshot({ dailyAtrPct: 0.014 }), "DAILY_ATR_BELOW_MINIMUM"],
    [snapshot({ dailyAtrPct: 0.038 }), "DAILY_ATR_ABOVE_MAXIMUM"],
    [snapshot({ adx: 26 }), "ADX_UNCERTAIN"],
    [snapshot({ adx: 30 }), "ADX_STAND_DOWN"]
  ];

  for (const [input, reasonCode] of cases) {
    const result = evaluateMarketRegime(input, STRATEGY);
    assert.equal(result.allowed, false);
    assert.equal(result.reasonCode, reasonCode);
  }
});

test("3 - a completed lower-band re-entry with oversold RSI produces a long candidate", () => {
  const input = pair({ previousClose: 89, currentClose: 91, currentRsi: 30 });
  const result = evaluateSignal({ ...input, strategy: STRATEGY });

  assert.equal(result.status, "CANDIDATE");
  assert.equal(result.strategyId, SIGNAL_STRATEGY_ID);
  assert.equal(result.direction, "LONG");
  assert.equal(result.entryReference, 91);
  assert.equal(result.stopDistance, 3);
  assert.equal(result.stopReference, 88);
  assert.equal(result.targetReference, 100);
  assert.equal(result.expectedReward, 9);
  assert.equal(result.rewardRiskRatio, 3);
  assert.equal(result.timeStopBars, 24);
  assert.equal(result.regime.allowed, true);
});

test("4 - a completed upper-band re-entry with overbought RSI produces a short candidate", () => {
  const input = pair({ previousClose: 111, currentClose: 109, currentRsi: 70 });
  const result = evaluateSignal({ ...input, strategy: STRATEGY });

  assert.equal(result.status, "CANDIDATE");
  assert.equal(result.direction, "SHORT");
  assert.equal(result.entryReference, 109);
  assert.equal(result.stopReference, 112);
  assert.equal(result.targetReference, 100);
  assert.equal(result.expectedReward, 9);
  assert.equal(result.rewardRiskRatio, 3);
});

test("5 - missing the re-entry or RSI threshold produces an explicit no-signal result", () => {
  const noExcursion = pair({ previousClose: 95, currentClose: 91, currentRsi: 30 });
  const noRsi = pair({ previousClose: 89, currentClose: 91, currentRsi: 40 });

  for (const input of [noExcursion, noRsi]) {
    const result = evaluateSignal({ ...input, strategy: STRATEGY });
    assert.equal(result.status, "NO_SIGNAL");
    assert.equal(result.direction, null);
    assert.equal(result.reasonCode, "NO_QUALIFYING_SETUP");
  }
});

test("6 - every blocked regime produces no signal even when entry conditions qualify", () => {
  const blockedCases = [
    [pair({ previousClose: 89, currentClose: 91, currentRsi: 30,
      dailyAtrPct: 0.01 }), "DAILY_ATR_BELOW_MINIMUM"],
    [pair({ previousClose: 89, currentClose: 91, currentRsi: 30,
      dailyAtrPct: 0.04 }), "DAILY_ATR_ABOVE_MAXIMUM"],
    [pair({ previousClose: 89, currentClose: 91, currentRsi: 30,
      adx: 27 }), "ADX_UNCERTAIN"],
    [pair({ previousClose: 89, currentClose: 91, currentRsi: 30,
      adx: 31 }), "ADX_STAND_DOWN"]
  ];

  for (const [input, reasonCode] of blockedCases) {
    const result = evaluateSignal({ ...input, strategy: STRATEGY });
    assert.equal(result.status, "NO_SIGNAL");
    assert.equal(result.reasonCode, reasonCode);
  }
});

test("7 - cold, malformed, mismatched, and non-consecutive snapshots fail closed", () => {
  const valid = pair({ previousClose: 89, currentClose: 91, currentRsi: 30 });
  const cold = { ...valid, current: { ...valid.current, warm: false } };
  const malformed = {
    ...valid,
    current: {
      ...valid.current,
      atr15m: { ...valid.current.atr15m, percentOfClose: 999 }
    }
  };
  const mismatch = {
    ...valid,
    current: { ...valid.current, source: "dxtrade" }
  };
  const gap = {
    ...valid,
    current: {
      ...valid.current,
      asOf: { ...valid.current.asOf, "15m": "2026-08-14T12:30:00.000Z" }
    }
  };

  assert.equal(evaluateSignal({ ...cold, strategy: STRATEGY }).reasonCode, "INDICATORS_COLD");
  assert.equal(evaluateSignal({ ...malformed, strategy: STRATEGY }).reasonCode, "INVALID_INPUT");
  assert.equal(evaluateSignal({ ...mismatch, strategy: STRATEGY }).reasonCode,
    "IDENTITY_MISMATCH");
  assert.equal(evaluateSignal({ ...gap, strategy: STRATEGY }).reasonCode,
    "NON_CONSECUTIVE_SNAPSHOTS");
});

test("8 - a higher-timeframe value dated after the 15-minute close fails closed", () => {
  const input = pair({ previousClose: 89, currentClose: 91, currentRsi: 30 });
  input.current.asOf["4h"] = "2026-08-14T16:00:00.000Z";

  const result = evaluateSignal({ ...input, strategy: STRATEGY });

  assert.equal(result.status, "NO_SIGNAL");
  assert.equal(result.reasonCode, "INVALID_INPUT");
  assert.match(result.reason, /future higher-timeframe/i);
});

test("9 - forged warm history and regressing higher-timeframe context fail closed", () => {
  const input = pair({ previousClose: 89, currentClose: 91, currentRsi: 30 });
  const forgedWarm = {
    ...input,
    current: { ...input.current, counts: { "15m": 49, "4h": 40, "1d": 25 } }
  };
  const regression = {
    ...input,
    previous: {
      ...input.previous,
      asOf: { ...input.previous.asOf, "4h": "2026-08-14T12:00:00.000Z" }
    },
    current: {
      ...input.current,
      asOf: { ...input.current.asOf, "4h": "2026-08-14T08:00:00.000Z" }
    }
  };
  const loweredPolicy = {
    ...input,
    current: {
      ...input.current,
      counts: { "15m": 1, "4h": 1, "1d": 1 },
      required: { "15m": 1, "4h": 1, "1d": 1 }
    }
  };
  const countRegression = {
    ...input,
    previous: {
      ...input.previous,
      counts: { "15m": 51, "4h": 41, "1d": 26 }
    }
  };

  assert.equal(evaluateSignal({ ...forgedWarm, strategy: STRATEGY }).reasonCode,
    "INVALID_INPUT");
  assert.equal(evaluateSignal({ ...loweredPolicy, strategy: STRATEGY }).reasonCode,
    "INVALID_INPUT");
  assert.equal(evaluateSignal({ ...regression, strategy: STRATEGY }).reasonCode,
    "NON_MONOTONIC_CONTEXT");
  assert.equal(evaluateSignal({ ...countRegression, strategy: STRATEGY }).reasonCode,
    "NON_MONOTONIC_CONTEXT");
});

test("10 - non-positive trade geometry is rejected instead of emitting a candidate", () => {
  const input = pair({
    previousClose: 89,
    currentClose: 101,
    currentRsi: 30,
    middle: 100,
    standardDeviation: 5
  });

  const result = evaluateSignal({ ...input, strategy: STRATEGY });

  assert.equal(result.status, "NO_SIGNAL");
  assert.equal(result.reasonCode, "NON_POSITIVE_TRADE_GEOMETRY");
});

test("11 - disabling close-inside-band requires a current outside-band fade", () => {
  const strategy = {
    ...STRATEGY,
    signal: { ...STRATEGY.signal, requireCloseInsideBand: false }
  };
  const outside = pair({ previousClose: 89, currentClose: 89, currentRsi: 30 });
  const inside = pair({ previousClose: 89, currentClose: 91, currentRsi: 30 });

  assert.equal(evaluateSignal({ ...outside, strategy }).direction, "LONG");
  assert.equal(evaluateSignal({ ...inside, strategy }).reasonCode, "NO_QUALIFYING_SETUP");
});
