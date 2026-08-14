import test from "node:test";
import assert from "node:assert/strict";
import {
  activeFloor,
  applyDailySnapshot,
  calculateConsistency,
  computeSize,
  createInitialFloorState,
  dailyFloor,
  evaluateDailyControl,
  markPayoutTaken,
  riskGate,
  updateMll
} from "../src/riskEngine.js";

const account = {
  startingBalance: 50000,
  dailyLossLimit: 1500,
  maxLossOffset: 3000,
  maxLossFloorCap: 50000,
  leverage: 2,
  maxNotional: 100000,
  consistencyMax: 0.2,
  minimumPayout: 100,
  profitSplit: 0.95,
  minimumHoldSeconds: 20,
  dailySnapshotUtc: "22:00"
};

const strategy = {
  instruments: { "BTC/USD": { enabled: true }, "SOL/USD": { enabled: false } },
  signal: {
    bbPeriod: 20,
    bbStdDev: 2,
    rsiPeriod: 14,
    rsiLongThreshold: 32,
    rsiShortThreshold: 68,
    requireCloseInsideBand: true,
    atrPeriod: 14,
    stopAtrMultiple: 1.5,
    timeStopBars: 24
  },
  regime: {
    minDailyAtrPct: 0.015,
    maxDailyAtrPct: 0.037,
    adxPeriod: 14,
    adxMax: 25,
    adxStandDown: 30,
    rangeBandStdDev: 2.5
  },
  risk: {
    stage1RiskCap: 200,
    stage2RiskCap: 300,
    stage2Threshold: 53000,
    dailySoftStop: -750,
    dailyHardStop: -1000,
    stage1ProfitCeiling: 500,
    stage2ProfitCeiling: 700,
    maxNotional: 100000,
    floorSafetyMargin: 750
  },
  execution: {
    minHoldSeconds: 25,
    slippageCapPct: 0.0005,
    hardFlatUtc: "21:45",
    autoExecute: false
  }
};

function baseGate(overrides = {}) {
  return {
    source: "auto",
    instrument: "BTC/USD",
    side: "BUY",
    balance: 50000,
    liveEquity: 50000,
    activeFloor: 48500,
    dailyRealizedPnl: 0,
    dailyUnrealizedPnl: 0,
    stage: 1,
    hasOpenPosition: false,
    lockedOut: false,
    indicatorsWarm: true,
    feedStale: false,
    regimeAllowed: true,
    newsBlackout: false,
    ...overrides
  };
}

function baseSize(overrides = {}) {
  return {
    instrument: "BTC/USD",
    price: 65000,
    atr15m: 200,
    stopAtrMultiple: 1.5,
    dailyStopRemaining: 1000,
    liveEquity: 50000,
    activeFloor: 47000,
    stageRiskCap: 200,
    maxNotional: 100000,
    rules: { minLot: 0.001, lotIncrement: 0.001 },
    ...overrides
  };
}

test("1 - initial floors match the account rules", () => {
  const state = createInitialFloorState(account);
  assert.equal(state.mllFloor, 47000);
  assert.equal(dailyFloor(state, account), 48500);
  assert.equal(activeFloor(state, account), 48500);
});

test("2 - MLL ratchets on closed-trade highs and caps at 50000", () => {
  let state = createInitialFloorState(account);
  state = updateMll(51000, state, account);
  assert.equal(state.mllFloor, 48000);
  state = updateMll(52500, state, account);
  assert.equal(state.mllFloor, 49500);
  state = updateMll(54000, state, account);
  assert.equal(state.mllFloor, 50000);
});

test("3 - MLL never moves down", () => {
  let state = updateMll(52000, createInitialFloorState(account), account);
  state = updateMll(51000, state, account);
  assert.equal(state.mllFloor, 49000);
  assert.equal(state.highWater, 52000);
});

test("4 - daily snapshot changes the daily floor", () => {
  let state = updateMll(53000, createInitialFloorState(account), account);
  state = applyDailySnapshot(53000, state);
  assert.equal(dailyFloor(state, account), 51500);
  assert.equal(activeFloor(state, account), 51500);
});

test("5 - payout locks the hard floor at 50000", () => {
  const state = markPayoutTaken(createInitialFloorState(account), account);
  assert.equal(state.payoutTaken, true);
  assert.equal(state.mllFloor, 50000);
  assert.equal(activeFloor(state, account), 50000);
});

test("6 - consistency passes at exactly 20 percent", () => {
  const result = calculateConsistency([
    { dateUtc: "2026-08-01", realizedPnl: 500 },
    { dateUtc: "2026-08-02", realizedPnl: 500 },
    { dateUtc: "2026-08-03", realizedPnl: 500 },
    { dateUtc: "2026-08-04", realizedPnl: 500 },
    { dateUtc: "2026-08-05", realizedPnl: 500 }
  ]);
  assert.equal(result.score, 0.2);
  assert.equal(result.compliant, true);
});

test("7 - large best day reports required profit", () => {
  const result = calculateConsistency([
    { dateUtc: "2026-08-01", realizedPnl: 1000 },
    { dateUtc: "2026-08-02", realizedPnl: 500 },
    { dateUtc: "2026-08-03", realizedPnl: 500 }
  ]);
  assert.equal(result.compliant, false);
  assert.equal(result.profitRequiredForCompliance, 5000);
});

test("8 - BTC sizing uses risk divided by stop distance", () => {
  const result = computeSize({
    instrument: "BTC/USD",
    price: 65000,
    atr15m: 200,
    stopAtrMultiple: 1.5,
    dailyStopRemaining: 1000,
    liveEquity: 50000,
    activeFloor: 47000,
    stageRiskCap: 200,
    maxNotional: 100000,
    rules: { minLot: 0.001, lotIncrement: 0.001 }
  });
  assert.ok(result);
  assert.equal(result.qty, 0.666);
  assert.equal(result.stopDistance, 300);
  assert.ok(Math.abs(result.risk - 199.8) < 1e-9);
});

test("9 - sizing refuses positions beyond max notional", () => {
  const result = computeSize({
    instrument: "BTC/USD",
    price: 100000,
    atr15m: 50,
    stopAtrMultiple: 1,
    dailyStopRemaining: 10000,
    liveEquity: 60000,
    activeFloor: 50000,
    stageRiskCap: 1000,
    maxNotional: 100000,
    rules: { minLot: 0.001, lotIncrement: 0.001 }
  });
  assert.equal(result, null);
});

test("10 - risk gate passes a healthy context", () => {
  assert.equal(riskGate(baseGate(), strategy).ok, true);
});

test("11 - risk gate blocks at the daily soft stop", () => {
  const result = riskGate(baseGate({ dailyRealizedPnl: -750 }), strategy);
  assert.equal(result.ok, false);
  assert.match(result.reason, /soft stop/i);
});

test("12 - risk gate blocks at the daily profit ceiling", () => {
  const result = riskGate(baseGate({ dailyRealizedPnl: 500 }), strategy);
  assert.equal(result.ok, false);
  assert.match(result.reason, /profit ceiling/i);
});

test("13 - daily control halves risk after two losses", () => {
  const result = evaluateDailyControl({
    realizedPnl: -200,
    unrealizedPnl: 0,
    lossesToday: 2,
    stage: 1
  }, strategy);
  assert.equal(result.action, "HALVE_RISK");
  assert.equal(result.effectiveRiskMultiplier, 0.5);
});

test("14 - daily control blocks non-finite PnL", () => {
  for (const invalidPnl of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const result = evaluateDailyControl({
      realizedPnl: invalidPnl,
      unrealizedPnl: 0,
      lossesToday: 0,
      stage: 1
    }, strategy);
    assert.equal(result.action, "NO_NEW_ENTRIES");
    assert.equal(result.effectiveRiskMultiplier, 0);
    assert.match(result.reason, /invalid/i);
  }
});

test("15 - daily control blocks invalid stage and loss count", () => {
  for (const invalidInput of [
    { realizedPnl: 0, unrealizedPnl: 0, lossesToday: -1, stage: 1 },
    { realizedPnl: 0, unrealizedPnl: 0, lossesToday: 1.5, stage: 1 },
    { realizedPnl: 0, unrealizedPnl: 0, lossesToday: 0, stage: 3 }
  ]) {
    const result = evaluateDailyControl(invalidInput, strategy);
    assert.equal(result.action, "NO_NEW_ENTRIES");
    assert.equal(result.effectiveRiskMultiplier, 0);
    assert.match(result.reason, /invalid/i);
  }
});

test("16 - risk gate blocks non-finite runtime values", () => {
  for (const overrides of [
    { liveEquity: Number.NaN },
    { activeFloor: Number.POSITIVE_INFINITY },
    { dailyRealizedPnl: Number.NEGATIVE_INFINITY },
    { dailyUnrealizedPnl: Number.NaN },
    { stage: Number.NaN }
  ]) {
    const result = riskGate(baseGate(overrides), strategy);
    assert.equal(result.ok, false);
    assert.match(result.reason, /invalid/i);
  }
});

test("17 - sizing rejects non-finite runtime values", () => {
  for (const context of [
    baseSize({ price: Number.NaN }),
    baseSize({ atr15m: Number.POSITIVE_INFINITY }),
    baseSize({ dailyStopRemaining: Number.NEGATIVE_INFINITY }),
    baseSize({ liveEquity: Number.NaN }),
    baseSize({ activeFloor: Number.POSITIVE_INFINITY }),
    baseSize({ rules: { minLot: 0.001, lotIncrement: Number.NaN } })
  ]) {
    assert.equal(computeSize(context), null);
  }
});

test("18 - sizing rejects invalid positive-only inputs", () => {
  for (const context of [
    baseSize({ price: 0 }),
    baseSize({ atr15m: -1 }),
    baseSize({ stopAtrMultiple: 0 }),
    baseSize({ stageRiskCap: -1 }),
    baseSize({ maxNotional: 0 }),
    baseSize({ rules: { minLot: 0, lotIncrement: 0.001 } }),
    baseSize({ rules: { minLot: 0.001, lotIncrement: 0 } })
  ]) {
    assert.equal(computeSize(context), null);
  }
});
