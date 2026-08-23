import test from "node:test";
import assert from "node:assert/strict";
import { calculateAccountFloors, evaluateGridRisk, payoutEligibility } from "../src/risk/accountRules.js";

const BASE = {
  startingBalance: 50_000,
  dailyLossLimit: 1_500,
  maxLossOffset: 3_000,
  previousDayClosingBalance: 50_000,
  peakClosedBalance: 50_000,
  payoutTaken: false,
  liveEquity: 50_000,
  currentNotional: 1_000,
  proposedAdditionalNotional: 250,
  maxNotional: 100_000,
  operatorPaused: false,
  safetyHalt: false,
  accountLocked: false,
  feedHealthy: true,
  accountDataFresh: true,
  nettingConfirmed: true
};

test("floors use previous-day close and end-of-trade trailing balance", () => {
  assert.deepEqual(calculateAccountFloors(BASE), {
    dailyFloor: 48_500,
    mllFloor: 47_000,
    activeFloor: 48_500
  });
  const raised = calculateAccountFloors({ ...BASE, peakClosedBalance: 52_000, previousDayClosingBalance: 52_000 });
  assert.deepEqual(raised, { dailyFloor: 50_500, mllFloor: 49_000, activeFloor: 50_500 });
  const capped = calculateAccountFloors({ ...BASE, peakClosedBalance: 54_000, previousDayClosingBalance: 54_000 });
  assert.equal(capped.mllFloor, 50_000);
});

test("protective flatten outranks pause and stale feeds", () => {
  const result = evaluateGridRisk({
    ...BASE,
    liveEquity: 48_400,
    operatorPaused: true,
    feedHealthy: false,
    accountDataFresh: false
  });
  assert.equal(result.protectiveAction, "FLATTEN_AND_LOCK");
  assert.match(result.reason, /Daily-loss/i);
});

test("stale Binance feed blocks new grid actions without inventing a protective exit", () => {
  const result = evaluateGridRisk({ ...BASE, feedHealthy: false });
  assert.equal(result.allowNewGridAction, false);
  assert.equal(result.protectiveAction, null);
  assert.match(result.reason, /Binance/i);
});

test("payout policy requires 57k for 30 days and at least 55k afterward", () => {
  assert.equal(payoutEligibility({ currentEquity: 57_100, consecutiveDaysAtOrAbove57000: 30, requestedPayout: 2_000 }).allowed, true);
  assert.equal(payoutEligibility({ currentEquity: 57_100, consecutiveDaysAtOrAbove57000: 29, requestedPayout: 2_000 }).allowed, false);
  assert.equal(payoutEligibility({ currentEquity: 57_100, consecutiveDaysAtOrAbove57000: 30, requestedPayout: 2_101 }).allowed, false);
});
