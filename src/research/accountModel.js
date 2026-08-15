import {
  activeFloor,
  applyDailySnapshot,
  computeSize,
  createInitialFloorState,
  dailyFloor,
  evaluateDailyControl,
  markPayoutTaken,
  riskGate,
  updateMll
} from "../riskEngine.js";

export { activeFloor, computeSize, dailyFloor, markPayoutTaken };

function requireFiniteNumber(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

/**
 * Section 9: the research account state layers Chapter 26 bookkeeping
 * (closedBalance, daily counters, stage, open-position flag) on top of
 * src/riskEngine.js's pure floor-math state (prevDayClose, highWater,
 * mllFloor, payoutTaken). riskEngine's exported functions spread their state
 * argument, so they compose directly against this superset object.
 *
 * Chapter 26 research always runs stage 1 with the stage risk cap fixed at
 * $100 per Section 9.1 ("the backtest runs that formula ... with the stage
 * cap parameter set to $100 for every research run") — stage is accepted as
 * a parameter rather than hardcoded so tests and any future chapter can
 * still exercise it explicitly.
 */
export function createResearchAccountState(account, { stage = 1 } = {}) {
  if (stage !== 1 && stage !== 2) throw new Error("stage must be 1 or 2");
  const floorState = createInitialFloorState(account);
  return Object.freeze({
    ...floorState,
    closedBalance: account.startingBalance,
    dailyRealizedPnl: 0,
    dailyUnrealizedPnl: 0,
    lossesToday: 0,
    stage,
    hasOpenPosition: false
  });
}

/** Marks a position open. hasOpenPosition then blocks riskGate/evaluateResearchRiskGate. */
export function openPosition(state) {
  if (state.hasOpenPosition) throw new Error("a position is already open");
  return Object.freeze({ ...state, hasOpenPosition: true });
}

/**
 * Updates the running mark-to-market P&L of an open position. Callers must
 * pass 0 (not omit the call) once a position is flat again, since this value
 * feeds both the daily-control evaluation and the account-failure check.
 */
export function markUnrealized(state, dailyUnrealizedPnl) {
  return Object.freeze({
    ...state,
    dailyUnrealizedPnl: requireFiniteNumber("dailyUnrealizedPnl", dailyUnrealizedPnl)
  });
}

/**
 * Applies a closed trade: updates closedBalance and the daily realized P&L
 * and loss count, ratchets the MLL floor via riskEngine's updateMll against
 * the new closedBalance, and clears hasOpenPosition. dailyUnrealizedPnl is
 * not reset here — callers should follow with markUnrealized(state, 0) once
 * the position is confirmed flat.
 */
export function recordTradeClose(state, account, { realizedPnl }) {
  const pnl = requireFiniteNumber("realizedPnl", realizedPnl);
  const closedBalance = state.closedBalance + pnl;
  const withFloor = updateMll(closedBalance, state, account);
  return Object.freeze({
    ...withFloor,
    closedBalance,
    dailyRealizedPnl: state.dailyRealizedPnl + pnl,
    lossesToday: state.lossesToday + (pnl < 0 ? 1 : 0),
    hasOpenPosition: false
  });
}

function parseUtcClockMinutes(clock) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(clock ?? "");
  if (!match) throw new Error('dailySnapshotUtc must be an "HH:MM" 24-hour UTC time');
  return (Number(match[1]) * 60) + Number(match[2]);
}

/**
 * Returns the first account-day boundary instant (ms) strictly after
 * afterTimeMs, for the configured UTC snapshot clock (account.json's
 * dailySnapshotUtc, "22:00").
 */
export function nextAccountDayBoundaryMs(afterTimeMs, dailySnapshotUtc = "22:00") {
  const afterMs = requireFiniteNumber("afterTimeMs", afterTimeMs);
  const snapshotMinutes = parseUtcClockMinutes(dailySnapshotUtc);
  const afterDate = new Date(afterMs);
  const dayStartMs = Date.UTC(
    afterDate.getUTCFullYear(),
    afterDate.getUTCMonth(),
    afterDate.getUTCDate()
  );
  let boundaryMs = dayStartMs + (snapshotMinutes * 60 * 1000);
  if (boundaryMs <= afterMs) boundaryMs += 24 * 60 * 60 * 1000;
  return boundaryMs;
}

/**
 * True if an account-day boundary falls in (previousCloseTimeMs,
 * currentCloseTimeMs] — i.e. the caller's bar loop just crossed 22:00 UTC and
 * must apply the daily snapshot before evaluating the next decision.
 */
export function crossedAccountDayBoundary(
  previousCloseTimeMs,
  currentCloseTimeMs,
  dailySnapshotUtc = "22:00"
) {
  const previous = requireFiniteNumber("previousCloseTimeMs", previousCloseTimeMs);
  const current = requireFiniteNumber("currentCloseTimeMs", currentCloseTimeMs);
  if (current < previous) throw new Error("currentCloseTimeMs must not precede previousCloseTimeMs");
  const boundaryMs = nextAccountDayBoundaryMs(previous, dailySnapshotUtc);
  return boundaryMs <= current;
}

/**
 * Section 9.2's "Account day boundary: Snapshot, reset daily counters."
 * Wraps riskEngine's applyDailySnapshot using the account's closed (realized)
 * balance — hard-flat at 21:45 UTC means no position is open at the 22:00 UTC
 * snapshot in this research context, so closedBalance is unambiguous.
 */
export function applyAccountDayBoundary(state) {
  const snapshotted = applyDailySnapshot(state.closedBalance, state);
  return Object.freeze({
    ...snapshotted,
    dailyRealizedPnl: 0,
    dailyUnrealizedPnl: 0,
    lossesToday: 0
  });
}

/**
 * Section 9.2: "Account failure = live equity including unrealised P&L
 * touches or breaches activeFloor at any point."
 */
export function checkAccountFailure(liveEquity, state, account) {
  const equity = requireFiniteNumber("liveEquity", liveEquity);
  const floor = activeFloor(state, account);
  return Object.freeze({ failed: equity <= floor, liveEquity: equity, activeFloor: floor });
}

/** Thin wrapper binding the research state's daily counters into riskEngine's evaluateDailyControl. */
export function evaluateResearchDailyControl(state, strategy) {
  return evaluateDailyControl({
    realizedPnl: state.dailyRealizedPnl,
    unrealizedPnl: state.dailyUnrealizedPnl,
    lossesToday: state.lossesToday,
    stage: state.stage
  }, strategy);
}

/**
 * Thin wrapper binding the research state's floor/daily/position fields into
 * riskEngine's riskGate. context must supply the fields riskGate still needs
 * from the caller directly: liveEquity, lockedOut, indicatorsWarm, feedStale,
 * regimeAllowed, newsBlackout. No defaults are applied for those — an
 * omitted field fails closed exactly as riskGate already fails closed on a
 * non-finite or non-boolean input.
 */
export function evaluateResearchRiskGate(state, account, strategy, context) {
  const floor = activeFloor(state, account);
  return riskGate({
    ...context,
    activeFloor: floor,
    dailyRealizedPnl: state.dailyRealizedPnl,
    dailyUnrealizedPnl: state.dailyUnrealizedPnl,
    stage: state.stage,
    hasOpenPosition: state.hasOpenPosition
  }, strategy);
}
