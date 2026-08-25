export const LADDER_ACTIONS = Object.freeze({
  NORMAL: "NORMAL",
  BRAKE: "BRAKE",
  PARTIAL_CUT: "PARTIAL_CUT",
  FULL_FLATTEN: "FULL_FLATTEN",
  HALTED_FOR_DAY: "HALTED_FOR_DAY"
});

export const ACCOUNT_DAY_OFFSET_MS = 2 * 60 * 60 * 1000;

function finite(name, value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new TypeError(`${name} must be finite`);
  return n;
}

function positive(name, value) {
  const n = finite(name, value);
  if (n <= 0) throw new TypeError(`${name} must be positive`);
  return n;
}

export function accountDayKey(timestampMs) {
  const ms = finite("timestampMs", timestampMs);
  return new Date(ms + ACCOUNT_DAY_OFFSET_MS).toISOString().slice(0, 10);
}

export function createInitialLadderState() {
  return Object.freeze({
    dayKey: null,
    baselineClosedBalanceUsd: null,
    brakeEngaged: false,
    partialCutDone: false,
    flattenDone: false,
    haltedForDay: false,
    worstDrawdownUsd: 0
  });
}

export function normalizeLadderState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("risk ladder state must be an object");
  const dayKey = input.dayKey == null ? null : String(input.dayKey);
  if (dayKey !== null && !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) throw new TypeError("risk ladder dayKey is invalid");
  const baseline = input.baselineClosedBalanceUsd == null ? null : positive("baselineClosedBalanceUsd", input.baselineClosedBalanceUsd);
  const worst = finite("worstDrawdownUsd", input.worstDrawdownUsd ?? 0);
  return Object.freeze({
    dayKey,
    baselineClosedBalanceUsd: baseline,
    brakeEngaged: input.brakeEngaged === true,
    partialCutDone: input.partialCutDone === true,
    flattenDone: input.flattenDone === true,
    haltedForDay: input.haltedForDay === true,
    worstDrawdownUsd: Math.min(0, worst)
  });
}

export function rollAccountDay(state, nowMs, closedBalanceUsd) {
  const current = normalizeLadderState(state);
  const key = accountDayKey(nowMs);
  if (current.dayKey === key) return Object.freeze({ state: current, rolled: false });
  const baseline = positive("closedBalanceUsd", closedBalanceUsd);
  return Object.freeze({
    state: Object.freeze({
      dayKey: key,
      baselineClosedBalanceUsd: baseline,
      brakeEngaged: false,
      partialCutDone: false,
      flattenDone: false,
      haltedForDay: false,
      worstDrawdownUsd: 0
    }),
    rolled: true
  });
}

export function evaluateRiskLadder(state, config, equityUsd) {
  const current = normalizeLadderState(state);
  if (!config || config.enabled !== true) {
    return Object.freeze({ action: LADDER_ACTIONS.NORMAL, drawdownUsd: 0, reason: "ladder-disabled" });
  }
  if (!Number.isFinite(Number(equityUsd)) || !Number.isFinite(Number(current.baselineClosedBalanceUsd))) {
    return Object.freeze({ action: LADDER_ACTIONS.BRAKE, drawdownUsd: 0, reason: "unknown-equity-or-baseline" });
  }

  const entryBrakeUsd = positive("riskLadder.entryBrakeUsd", config.entryBrakeUsd);
  const partialCutUsd = positive("riskLadder.partialCutUsd", config.partialCutUsd);
  const fullFlattenUsd = positive("riskLadder.fullFlattenUsd", config.fullFlattenUsd);
  const partialCutFraction = positive("riskLadder.partialCutFraction", config.partialCutFraction);
  if (partialCutFraction <= 0 || partialCutFraction >= 1) throw new TypeError("riskLadder.partialCutFraction must be between 0 and 1");
  if (!(entryBrakeUsd < partialCutUsd && partialCutUsd < fullFlattenUsd)) {
    throw new TypeError("risk ladder thresholds must increase from brake to cut to flatten");
  }

  const drawdownUsd = Number(equityUsd) - current.baselineClosedBalanceUsd;

  if (current.haltedForDay || current.flattenDone) {
    return Object.freeze({ action: LADDER_ACTIONS.HALTED_FOR_DAY, drawdownUsd, reason: "flattened-this-day" });
  }
  if (drawdownUsd <= -fullFlattenUsd) {
    return Object.freeze({ action: LADDER_ACTIONS.FULL_FLATTEN, drawdownUsd, reason: "full-flatten-threshold" });
  }
  if (!current.partialCutDone && drawdownUsd <= -partialCutUsd) {
    return Object.freeze({ action: LADDER_ACTIONS.PARTIAL_CUT, drawdownUsd, reason: "partial-cut-threshold" });
  }
  if (drawdownUsd <= -entryBrakeUsd) {
    return Object.freeze({ action: LADDER_ACTIONS.BRAKE, drawdownUsd, reason: "entry-brake-threshold" });
  }
  return Object.freeze({ action: LADDER_ACTIONS.NORMAL, drawdownUsd, reason: "within-limits" });
}

export function withLadderObservation(state, { drawdownUsd, brakeEngaged }) {
  const current = normalizeLadderState(state);
  const drawdown = finite("drawdownUsd", drawdownUsd);
  return normalizeLadderState({
    ...current,
    brakeEngaged: brakeEngaged === true,
    worstDrawdownUsd: Math.min(current.worstDrawdownUsd, drawdown)
  });
}

export function markPartialCutDone(state, drawdownUsd) {
  const current = normalizeLadderState(state);
  return normalizeLadderState({
    ...current,
    brakeEngaged: true,
    partialCutDone: true,
    worstDrawdownUsd: Math.min(current.worstDrawdownUsd, finite("drawdownUsd", drawdownUsd))
  });
}

export function markFlattenDone(state, drawdownUsd) {
  const current = normalizeLadderState(state);
  return normalizeLadderState({
    ...current,
    brakeEngaged: true,
    flattenDone: true,
    haltedForDay: true,
    worstDrawdownUsd: Math.min(current.worstDrawdownUsd, finite("drawdownUsd", drawdownUsd))
  });
}
