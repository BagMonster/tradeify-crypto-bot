import test from "node:test";
import assert from "node:assert/strict";
import {
  LADDER_ACTIONS,
  accountDayKey,
  createInitialLadderState,
  evaluateRiskLadder,
  markFlattenDone,
  markPartialCutDone,
  rollAccountDay
} from "../src/risk/dailyRiskLadder.js";

const config = Object.freeze({
  enabled: true,
  entryBrakeUsd: 300,
  partialCutUsd: 1000,
  partialCutFraction: 0.5,
  fullFlattenUsd: 1250
});

test("Tradeify account day rolls at 22:00 UTC", () => {
  assert.equal(accountDayKey(Date.parse("2026-08-24T21:59:59.999Z")), "2026-08-24");
  assert.equal(accountDayKey(Date.parse("2026-08-24T22:00:00.000Z")), "2026-08-25");
});

test("rollAccountDay uses the confirmed closed-balance baseline and clears prior layers", () => {
  const old = markFlattenDone({
    dayKey: "2026-08-24",
    baselineClosedBalanceUsd: 50000,
    brakeEngaged: true,
    partialCutDone: true,
    flattenDone: false,
    haltedForDay: false,
    worstDrawdownUsd: -1250
  }, -1250);
  const result = rollAccountDay(old, Date.parse("2026-08-24T22:00:00.000Z"), 50100);
  assert.equal(result.rolled, true);
  assert.equal(result.state.dayKey, "2026-08-25");
  assert.equal(result.state.baselineClosedBalanceUsd, 50100);
  assert.equal(result.state.brakeEngaged, false);
  assert.equal(result.state.partialCutDone, false);
  assert.equal(result.state.flattenDone, false);
  assert.equal(result.state.haltedForDay, false);
  assert.equal(result.state.worstDrawdownUsd, 0);
});

test("D-049 threshold ordering is normal, brake, cut, then full flatten", () => {
  const base = rollAccountDay(createInitialLadderState(), Date.parse("2026-08-24T20:00:00.000Z"), 50000).state;
  assert.equal(evaluateRiskLadder(base, config, 49701).action, LADDER_ACTIONS.NORMAL);
  assert.equal(evaluateRiskLadder(base, config, 49700).action, LADDER_ACTIONS.BRAKE);
  assert.equal(evaluateRiskLadder(base, config, 49000).action, LADDER_ACTIONS.PARTIAL_CUT);
  assert.equal(evaluateRiskLadder(base, config, 48750).action, LADDER_ACTIONS.FULL_FLATTEN);
});

test("unknown equity or baseline fails closed to the entry brake", () => {
  const result = evaluateRiskLadder(createInitialLadderState(), config, Number.NaN);
  assert.equal(result.action, LADDER_ACTIONS.BRAKE);
  assert.equal(result.reason, "unknown-equity-or-baseline");
});

test("partial cut fires at most once per account day", () => {
  const base = rollAccountDay(createInitialLadderState(), Date.parse("2026-08-24T20:00:00.000Z"), 50000).state;
  const first = evaluateRiskLadder(base, config, 49000);
  assert.equal(first.action, LADDER_ACTIONS.PARTIAL_CUT);
  const cut = markPartialCutDone(base, first.drawdownUsd);
  const after = evaluateRiskLadder(cut, config, 48950);
  assert.equal(after.action, LADDER_ACTIONS.BRAKE);
  assert.equal(cut.partialCutDone, true);
});

test("full flatten persists a halt until the next account-day rollover", () => {
  const base = rollAccountDay(createInitialLadderState(), Date.parse("2026-08-24T20:00:00.000Z"), 50000).state;
  const flat = markFlattenDone(base, -1250);
  assert.equal(evaluateRiskLadder(flat, config, 50000).action, LADDER_ACTIONS.HALTED_FOR_DAY);
  const next = rollAccountDay(flat, Date.parse("2026-08-24T22:00:00.000Z"), 48750).state;
  assert.equal(next.haltedForDay, false);
  assert.equal(evaluateRiskLadder(next, config, 48750).action, LADDER_ACTIONS.NORMAL);
});
