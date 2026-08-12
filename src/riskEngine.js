export function createInitialFloorState(account) {
  return {
    prevDayClose: account.startingBalance,
    highWater: account.startingBalance,
    mllFloor: account.startingBalance - account.maxLossOffset,
    payoutTaken: false
  };
}

export function dailyFloor(state, account) {
  return state.prevDayClose - account.dailyLossLimit;
}

export function updateMll(closedBalance, state, account) {
  if (!Number.isFinite(closedBalance)) throw new Error("closedBalance must be finite");
  if (closedBalance <= state.highWater) return state;
  const next = Math.min(closedBalance - account.maxLossOffset, account.maxLossFloorCap);
  return {
    ...state,
    highWater: closedBalance,
    mllFloor: Math.max(state.mllFloor, next)
  };
}

export function activeFloor(state, account) {
  const hardFloor = state.payoutTaken ? account.startingBalance : state.mllFloor;
  return Math.max(dailyFloor(state, account), hardFloor);
}

export function applyDailySnapshot(closedBalance, state) {
  if (!Number.isFinite(closedBalance)) throw new Error("closedBalance must be finite");
  return { ...state, prevDayClose: closedBalance };
}

export function markPayoutTaken(state, account) {
  return {
    ...state,
    payoutTaken: true,
    mllFloor: Math.max(state.mllFloor, account.startingBalance)
  };
}

export function determineStage(balance, strategy) {
  return balance >= strategy.risk.stage2Threshold ? 2 : 1;
}

export function stageRiskCap(stage, strategy) {
  return stage === 1 ? strategy.risk.stage1RiskCap : strategy.risk.stage2RiskCap;
}

export function stageProfitCeiling(stage, strategy) {
  return stage === 1
    ? strategy.risk.stage1ProfitCeiling
    : strategy.risk.stage2ProfitCeiling;
}

export function calculateConsistency(days, maxScore = 0.2) {
  if (maxScore <= 0 || maxScore > 1) throw new Error("maxScore must be in (0, 1]");
  const total = days.reduce((sum, day) => sum + day.realizedPnl, 0);
  const bestWin = Math.max(0, ...days.map((day) => day.realizedPnl));
  if (total <= 0 || bestWin <= 0) {
    return {
      totalRealizedProfit: total,
      bestWinningDay: bestWin,
      score: null,
      compliant: false,
      profitRequiredForCompliance: bestWin > 0 ? bestWin / maxScore : null
    };
  }
  const score = bestWin / total;
  return {
    totalRealizedProfit: total,
    bestWinningDay: bestWin,
    score,
    compliant: score <= maxScore,
    profitRequiredForCompliance: score <= maxScore ? total : bestWin / maxScore
  };
}

export function evaluateDailyControl(input, strategy) {
  const pnl = input.realizedPnl + input.unrealizedPnl;
  const ceiling = stageProfitCeiling(input.stage, strategy);
  if (pnl <= strategy.risk.dailyHardStop) {
    return { action: "FLATTEN_AND_LOCK", effectiveRiskMultiplier: 0, reason: "Daily hard stop reached" };
  }
  if (pnl >= ceiling) {
    return { action: "PROFIT_LOCK", effectiveRiskMultiplier: 0, reason: "Daily profit ceiling reached" };
  }
  if (pnl <= strategy.risk.dailySoftStop) {
    return { action: "NO_NEW_ENTRIES", effectiveRiskMultiplier: 0, reason: "Daily soft stop reached" };
  }
  if (input.lossesToday >= 2) {
    return { action: "HALVE_RISK", effectiveRiskMultiplier: 0.5, reason: "Two losses today" };
  }
  return { action: "ALLOW", effectiveRiskMultiplier: 1, reason: "Within daily limits" };
}

function roundDownToIncrement(value, increment) {
  if (increment <= 0) throw new Error("lot increment must be positive");
  const steps = Math.floor((value + Number.EPSILON) / increment);
  const decimals = Math.max(0, (increment.toString().split(".")[1] ?? "").length);
  return Number((steps * increment).toFixed(decimals));
}

export function computeSize(context) {
  const stopDistance = context.atr15m * context.stopAtrMultiple;
  if (!Number.isFinite(stopDistance) || stopDistance <= 0) return null;
  if (context.dailyStopRemaining <= 0) return null;
  const floorDistance = context.liveEquity - context.activeFloor;
  if (floorDistance <= 0) return null;
  const risk = Math.min(
    context.dailyStopRemaining / 3,
    floorDistance / 12,
    context.stageRiskCap
  );
  if (!Number.isFinite(risk) || risk <= 0) return null;
  const qty = roundDownToIncrement(risk / stopDistance, context.rules.lotIncrement);
  if (qty < context.rules.minLot) return null;
  const notional = qty * context.price;
  if (notional > context.maxNotional) return null;
  return { qty, stopDistance, risk: qty * stopDistance, notional };
}

export function currentDailyPnl(context) {
  return context.dailyRealizedPnl + context.dailyUnrealizedPnl;
}

export function riskGate(context, strategy) {
  const pnl = currentDailyPnl(context);
  const ceiling = stageProfitCeiling(context.stage, strategy);
  const floorDistance = context.liveEquity - context.activeFloor;
  if (context.lockedOut) return { ok: false, reason: "Account is locked out" };
  if (!context.indicatorsWarm) return { ok: false, reason: "Indicators are cold" };
  if (context.feedStale) return { ok: false, reason: "Market data feed is stale" };
  if (!context.regimeAllowed) return { ok: false, reason: "Regime filter blocks entries" };
  if (context.newsBlackout) return { ok: false, reason: "News blackout is active" };
  if (context.hasOpenPosition) return { ok: false, reason: "Only one open position is allowed" };
  if (pnl <= strategy.risk.dailyHardStop) return { ok: false, reason: "Daily hard stop reached" };
  if (pnl <= strategy.risk.dailySoftStop) return { ok: false, reason: "Daily soft stop reached" };
  if (pnl >= ceiling) return { ok: false, reason: "Daily profit ceiling reached" };
  if (floorDistance <= strategy.risk.floorSafetyMargin) {
    return { ok: false, reason: "Equity is inside the active-floor safety margin" };
  }
  return { ok: true, reason: "Risk gate passed" };
}
