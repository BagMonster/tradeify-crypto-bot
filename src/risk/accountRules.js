function finite(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return value;
}

function positive(name, value) {
  const number = finite(name, value);
  if (number <= 0) throw new TypeError(`${name} must be greater than zero`);
  return number;
}

function bool(name, value) {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
  return value;
}

export function calculateDailyFloor(previousDayClosingBalance, dailyLossLimit) {
  return finite("previousDayClosingBalance", previousDayClosingBalance) - positive("dailyLossLimit", dailyLossLimit);
}

export function calculateMllFloor({ startingBalance, maxLossOffset, peakClosedBalance, payoutTaken }) {
  const start = positive("startingBalance", startingBalance);
  const offset = positive("maxLossOffset", maxLossOffset);
  const peak = finite("peakClosedBalance", peakClosedBalance);
  const payout = bool("payoutTaken", payoutTaken);
  if (peak < start) throw new TypeError("peakClosedBalance cannot be below startingBalance");
  if (payout) return start;
  return Math.min(start, peak - offset);
}

export function calculateAccountFloors(input) {
  const dailyFloor = calculateDailyFloor(input.previousDayClosingBalance, input.dailyLossLimit);
  const mllFloor = calculateMllFloor(input);
  return Object.freeze({ dailyFloor, mllFloor, activeFloor: Math.max(dailyFloor, mllFloor) });
}

export function evaluateGridRisk(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("risk input must be an object");
  }

  const liveEquity = finite("liveEquity", input.liveEquity);
  const currentNotional = Math.abs(finite("currentNotional", input.currentNotional));
  const proposedAdditionalNotional = Math.max(0, finite("proposedAdditionalNotional", input.proposedAdditionalNotional));
  const maxNotional = positive("maxNotional", input.maxNotional);
  const flags = {
    operatorPaused: bool("operatorPaused", input.operatorPaused),
    safetyHalt: bool("safetyHalt", input.safetyHalt),
    accountLocked: bool("accountLocked", input.accountLocked),
    feedHealthy: bool("feedHealthy", input.feedHealthy),
    accountDataFresh: bool("accountDataFresh", input.accountDataFresh),
    nettingConfirmed: bool("nettingConfirmed", input.nettingConfirmed)
  };
  const floors = calculateAccountFloors(input);

  // Protective actions are evaluated first. Pause, stale market data, and entry guards
  // can never suppress a required defensive flatten.
  if (liveEquity <= floors.mllFloor) {
    return Object.freeze({
      allowNewGridAction: false,
      protectiveAction: "FLATTEN_AND_LOCK",
      reason: "Maximum-loss floor reached",
      ...floors
    });
  }
  if (liveEquity <= floors.dailyFloor) {
    return Object.freeze({
      allowNewGridAction: false,
      protectiveAction: "FLATTEN_AND_LOCK",
      reason: "Daily-loss floor reached",
      ...floors
    });
  }

  if (flags.accountLocked || flags.safetyHalt || flags.operatorPaused) {
    return Object.freeze({
      allowNewGridAction: false,
      protectiveAction: null,
      reason: flags.accountLocked ? "Account is locked" : flags.safetyHalt ? "Safety halt is active" : "Operator pause is active",
      ...floors
    });
  }
  if (!flags.accountDataFresh) {
    return Object.freeze({
      allowNewGridAction: false,
      protectiveAction: null,
      reason: "Account data is stale",
      ...floors
    });
  }
  if (!flags.feedHealthy) {
    return Object.freeze({
      allowNewGridAction: false,
      protectiveAction: null,
      reason: "Binance market data is stale or unhealthy",
      ...floors
    });
  }
  if (!flags.nettingConfirmed) {
    return Object.freeze({
      allowNewGridAction: false,
      protectiveAction: null,
      reason: "DXtrade netting mode is not confirmed",
      ...floors
    });
  }
  if (currentNotional + proposedAdditionalNotional > maxNotional) {
    return Object.freeze({
      allowNewGridAction: false,
      protectiveAction: null,
      reason: "Maximum notional would be exceeded",
      ...floors
    });
  }

  return Object.freeze({
    allowNewGridAction: true,
    protectiveAction: null,
    reason: "Grid risk checks passed",
    ...floors
  });
}

export function payoutEligibility({
  currentEquity,
  consecutiveDaysAtOrAbove57000,
  requestedPayout
}) {
  const equity = finite("currentEquity", currentEquity);
  const payout = positive("requestedPayout", requestedPayout);
  if (!Number.isInteger(consecutiveDaysAtOrAbove57000) || consecutiveDaysAtOrAbove57000 < 0) {
    throw new TypeError("consecutiveDaysAtOrAbove57000 must be a non-negative integer");
  }
  if (equity < 57_000) return Object.freeze({ allowed: false, reason: "Equity is below $57,000" });
  if (consecutiveDaysAtOrAbove57000 < 30) {
    return Object.freeze({ allowed: false, reason: "The 30-day $57,000 holding period is incomplete" });
  }
  if (equity - payout < 55_000) {
    return Object.freeze({ allowed: false, reason: "Payout would reduce equity below $55,000" });
  }
  return Object.freeze({ allowed: true, reason: "Payout policy checks passed" });
}
