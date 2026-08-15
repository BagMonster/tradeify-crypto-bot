import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAccountDayBoundary,
  checkAccountFailure,
  createResearchAccountState,
  crossedAccountDayBoundary,
  evaluateResearchDailyControl,
  evaluateResearchRiskGate,
  markUnrealized,
  nextAccountDayBoundaryMs,
  openPosition,
  recordTradeClose
} from "../src/research/accountModel.js";

const account = Object.freeze({
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
});

const strategy = Object.freeze({
  risk: Object.freeze({
    stage1RiskCap: 100,
    stage2RiskCap: 100,
    stage2Threshold: 53000,
    dailySoftStop: -750,
    dailyHardStop: -1000,
    stage1ProfitCeiling: 500,
    stage2ProfitCeiling: 700,
    maxNotional: 100000,
    floorSafetyMargin: 750
  })
});

function baseContext(overrides = {}) {
  return {
    liveEquity: 50000,
    lockedOut: false,
    indicatorsWarm: true,
    feedStale: false,
    regimeAllowed: true,
    newsBlackout: false,
    ...overrides
  };
}

test("1 - a fresh research account state matches the D-010 initial floors and zeroed counters", () => {
  const state = createResearchAccountState(account);
  assert.equal(state.closedBalance, 50000);
  assert.equal(state.mllFloor, 47000);
  assert.equal(state.dailyRealizedPnl, 0);
  assert.equal(state.dailyUnrealizedPnl, 0);
  assert.equal(state.lossesToday, 0);
  assert.equal(state.stage, 1);
  assert.equal(state.hasOpenPosition, false);
});

test("2 - createResearchAccountState rejects a stage outside 1 or 2", () => {
  assert.throws(() => createResearchAccountState(account, { stage: 3 }), /stage must be 1 or 2/);
});

test("3 - openPosition sets hasOpenPosition and refuses to double-open", () => {
  const state = openPosition(createResearchAccountState(account));
  assert.equal(state.hasOpenPosition, true);
  assert.throws(() => openPosition(state), /already open/);
});

test("4 - markUnrealized updates the running mark-to-market P&L", () => {
  const state = markUnrealized(createResearchAccountState(account), -42.5);
  assert.equal(state.dailyUnrealizedPnl, -42.5);
  assert.throws(() => markUnrealized(state, Number.NaN), /finite number/);
});

test("5 - recordTradeClose updates closedBalance, daily P&L, loss count, and ratchets the MLL floor", () => {
  let state = createResearchAccountState(account);
  state = openPosition(state);
  state = recordTradeClose(state, account, { realizedPnl: 3000 });

  assert.equal(state.closedBalance, 53000);
  assert.equal(state.dailyRealizedPnl, 3000);
  assert.equal(state.lossesToday, 0);
  assert.equal(state.hasOpenPosition, false);
  assert.equal(state.mllFloor, 50000);

  state = openPosition(state);
  state = recordTradeClose(state, account, { realizedPnl: -100 });
  assert.equal(state.closedBalance, 52900);
  assert.equal(state.dailyRealizedPnl, 2900);
  assert.equal(state.lossesToday, 1);
  assert.equal(state.mllFloor, 50000, "the MLL floor never moves down");
});

test("6 - recordTradeClose rejects a non-finite realizedPnl", () => {
  const state = createResearchAccountState(account);
  assert.throws(() => recordTradeClose(state, account, { realizedPnl: Number.NaN }), /finite number/);
});

test("7 - nextAccountDayBoundaryMs finds the next 22:00 UTC instant, rolling over past midnight", () => {
  const beforeSnapshot = Date.parse("2026-08-14T10:00:00.000Z");
  assert.equal(
    nextAccountDayBoundaryMs(beforeSnapshot, "22:00"),
    Date.parse("2026-08-14T22:00:00.000Z")
  );

  const afterSnapshot = Date.parse("2026-08-14T23:00:00.000Z");
  assert.equal(
    nextAccountDayBoundaryMs(afterSnapshot, "22:00"),
    Date.parse("2026-08-15T22:00:00.000Z")
  );

  const exactBoundary = Date.parse("2026-08-14T22:00:00.000Z");
  assert.equal(
    nextAccountDayBoundaryMs(exactBoundary, "22:00"),
    Date.parse("2026-08-15T22:00:00.000Z")
  );
});

test("8 - crossedAccountDayBoundary detects a 22:00 UTC snapshot between two bar closes", () => {
  assert.equal(
    crossedAccountDayBoundary(
      Date.parse("2026-08-14T21:45:00.000Z"),
      Date.parse("2026-08-14T22:00:00.000Z")
    ),
    true
  );
  assert.equal(
    crossedAccountDayBoundary(
      Date.parse("2026-08-14T21:30:00.000Z"),
      Date.parse("2026-08-14T21:45:00.000Z")
    ),
    false
  );
  assert.throws(
    () => crossedAccountDayBoundary(
      Date.parse("2026-08-14T22:00:00.000Z"),
      Date.parse("2026-08-14T21:00:00.000Z")
    ),
    /must not precede/
  );
});

test("9 - applyAccountDayBoundary snapshots the closed balance and resets daily counters", () => {
  let state = createResearchAccountState(account);
  state = openPosition(state);
  state = recordTradeClose(state, account, { realizedPnl: -400 });
  state = markUnrealized(state, 15);
  assert.equal(state.dailyRealizedPnl, -400);
  assert.equal(state.lossesToday, 1);

  state = applyAccountDayBoundary(state);
  assert.equal(state.prevDayClose, 49600);
  assert.equal(state.dailyRealizedPnl, 0);
  assert.equal(state.dailyUnrealizedPnl, 0);
  assert.equal(state.lossesToday, 0);
  assert.equal(state.closedBalance, 49600, "closedBalance itself is untouched by the snapshot");
});

test("10 - checkAccountFailure fires when live equity touches or breaches the active floor", () => {
  const state = createResearchAccountState(account);
  assert.equal(checkAccountFailure(49000, state, account).failed, false);
  assert.equal(checkAccountFailure(48500, state, account).failed, true, "touching the floor fails");
  assert.equal(checkAccountFailure(48000, state, account).failed, true);
  assert.throws(() => checkAccountFailure(Number.NaN, state, account), /finite number/);
});

test("11 - evaluateResearchDailyControl halves risk after two losses and locks at the hard stop", () => {
  let state = createResearchAccountState(account);
  state = recordTradeClose(state, account, { realizedPnl: -100 });
  state = recordTradeClose(state, account, { realizedPnl: -100 });
  assert.equal(evaluateResearchDailyControl(state, strategy).action, "HALVE_RISK");

  const hardStopState = { ...state, dailyRealizedPnl: -1000 };
  assert.equal(evaluateResearchDailyControl(hardStopState, strategy).action, "FLATTEN_AND_LOCK");
});

test("12 - evaluateResearchRiskGate passes a healthy context and blocks on an open position", () => {
  const state = createResearchAccountState(account);
  assert.equal(evaluateResearchRiskGate(state, account, strategy, baseContext()).ok, true);

  const busy = openPosition(state);
  const blocked = evaluateResearchRiskGate(busy, account, strategy, baseContext());
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /one open position/i);
});

test("13 - evaluateResearchRiskGate fails closed when the caller omits a required context field", () => {
  const state = createResearchAccountState(account);
  const { indicatorsWarm, ...missingIndicatorsWarm } = baseContext();
  const result = evaluateResearchRiskGate(state, account, strategy, missingIndicatorsWarm);
  assert.equal(result.ok, false, "an omitted boolean gate must never silently default to passing");
  assert.match(result.reason, /cold/i);

  const { liveEquity, ...missingLiveEquity } = baseContext();
  const numericResult = evaluateResearchRiskGate(state, account, strategy, missingLiveEquity);
  assert.equal(numericResult.ok, false);
  assert.match(numericResult.reason, /invalid/i);
});
