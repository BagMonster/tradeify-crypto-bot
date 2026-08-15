import {
  applyAccountDayBoundary,
  checkAccountFailure,
  computeSize,
  createResearchAccountState,
  crossedAccountDayBoundary,
  evaluateResearchRiskGate,
  markUnrealized,
  openPosition,
  recordTradeClose
} from "./accountModel.js";
import { activeFloor } from "../riskEngine.js";

/**
 * [ASSUMPTION — D-010 conservative]: no field in config/strategy.json or
 * config/account.json carries a commission rate. Section 8 of the freeze
 * contract labels 0.04% entry / 0.04% exit as an unverified conservative
 * assumption with no named config source (unlike slippage, which the
 * contract explicitly ties to strategy.execution.slippageCapPct). These are
 * Chapter 26 research-only constants, not read from the live config.
 */
export const DEFAULT_ENTRY_COMMISSION_PCT = 0.0004;
export const DEFAULT_EXIT_COMMISSION_PCT = 0.0004;

/** Section 9.1: DXtrade lot minimum/increment are [UNRESOLVED]; modelled continuous at 0.001 BTC. */
export const DEFAULT_LOT_RULES = Object.freeze({ minLot: 0.001, lotIncrement: 0.001 });

/** Section 9.1: every Chapter 26 research run fixes the stage risk cap at $100, never the configured $200/$300 stage caps. */
export const RESEARCH_STAGE_RISK_CAP = 100;

function requireFiniteNumber(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function parseUtcClockMinutes(clock) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(clock ?? "");
  if (!match) throw new Error('hardFlatUtc must be an "HH:MM" 24-hour UTC time');
  return (Number(match[1]) * 60) + Number(match[2]);
}

function utcMinutesOfDay(timeMs) {
  const date = new Date(timeMs);
  return (date.getUTCHours() * 60) + date.getUTCMinutes();
}

/** Section 7: "No entry fills at or after 21:45 UTC." */
export function isAtOrAfterHardFlat(timeMs, hardFlatUtc) {
  return utcMinutesOfDay(timeMs) >= parseUtcClockMinutes(hardFlatUtc);
}

/**
 * Section 8: slippage is 0.05% adverse "on every fill, entry and exit" —
 * applied uniformly here regardless of why the fill happened. direction is
 * the position's LONG/SHORT side; side is "ENTRY" or "EXIT". Buying moves
 * adverse-up, selling moves adverse-down.
 */
function applySlippage(price, direction, side, slippagePct) {
  const buying = (direction === "LONG" && side === "ENTRY") ||
    (direction === "SHORT" && side === "EXIT");
  return buying ? price * (1 + slippagePct) : price * (1 - slippagePct);
}

function updateExcursion(position, bar) {
  const { direction, entryPrice } = position;
  const favorable = direction === "LONG" ? bar.high - entryPrice : entryPrice - bar.low;
  const adverse = direction === "LONG" ? entryPrice - bar.low : bar.high - entryPrice;
  return {
    maxFavorableExcursion: Math.max(position.maxFavorableExcursion, favorable, 0),
    maxAdverseExcursion: Math.max(position.maxAdverseExcursion, adverse, 0)
  };
}

/**
 * Section 7's exit precedence, generalized for a static bracket (fixed stop
 * + target + time-stop set at entry) — the shape Slot 3's evaluateSignal
 * output provides. Slots 1/2/4 (Step 26.4) use dynamic channel/EMA exits
 * that must be recomputed every bar; that is out of this step's scope and
 * is not modelled here.
 *
 * Order: hard-flat -> protective stop -> target hit -> time stop -> hold.
 * "Gap through stop: filled at the bar open, not the stop price" (Section
 * 7) is implemented for the protective stop. No equivalent rule is stated
 * for a favorable gap through the target, so — matching the contract's
 * stated preference for not silently forgiving adverse gaps while also not
 * overstating edge — a target hit is always filled at the exact target
 * price, never at a more favorable open. [INTERPRETATION, flagged to the
 * owner]. Time-stop exits at that bar's open, by direct analogy to how the
 * contract states hard-flat resolves ("force-exited at the 21:45 UTC bar
 * open") — the only exit condition in Section 7 that is schedule- rather
 * than price-triggered, same as time-stop. [INTERPRETATION, flagged to the
 * owner].
 */
function resolveOpenPosition({ position, bar, barIndex, strategy, costMultiplier, exitCommissionPct, slippagePct }) {
  const excursion = updateExcursion(position, bar);
  const carried = { ...position, ...excursion };
  const openTimeMs = Date.parse(bar.openTime);
  const scaledSlippage = slippagePct * costMultiplier;

  let requestedExitPrice = null;
  let exitReason = null;

  if (isAtOrAfterHardFlat(openTimeMs, strategy.execution.hardFlatUtc)) {
    requestedExitPrice = bar.open;
    exitReason = "HARD_FLAT";
  } else if (position.direction === "LONG") {
    if (bar.open <= position.stopReference) {
      requestedExitPrice = bar.open;
      exitReason = "PROTECTIVE_STOP_GAP";
    } else if (bar.low <= position.stopReference) {
      requestedExitPrice = position.stopReference;
      exitReason = "PROTECTIVE_STOP";
    } else if (Number.isFinite(position.targetReference) && bar.high >= position.targetReference) {
      requestedExitPrice = position.targetReference;
      exitReason = "TARGET";
    } else if (barIndex >= position.timeStopBarIndex) {
      requestedExitPrice = bar.open;
      exitReason = "TIME_STOP";
    }
  } else {
    if (bar.open >= position.stopReference) {
      requestedExitPrice = bar.open;
      exitReason = "PROTECTIVE_STOP_GAP";
    } else if (bar.high >= position.stopReference) {
      requestedExitPrice = position.stopReference;
      exitReason = "PROTECTIVE_STOP";
    } else if (Number.isFinite(position.targetReference) && bar.low <= position.targetReference) {
      requestedExitPrice = position.targetReference;
      exitReason = "TARGET";
    } else if (barIndex >= position.timeStopBarIndex) {
      requestedExitPrice = bar.open;
      exitReason = "TIME_STOP";
    }
  }

  if (requestedExitPrice === null) {
    const markPrice = bar.close;
    const unrealizedPnl = position.direction === "LONG"
      ? (markPrice - position.entryPrice) * position.quantity
      : (position.entryPrice - markPrice) * position.quantity;
    return { exited: false, position: carried, unrealizedPnl };
  }

  const modelledExitPrice = applySlippage(requestedExitPrice, position.direction, "EXIT", scaledSlippage);
  const exitNotional = modelledExitPrice * position.quantity;
  const exitCommission = exitNotional * exitCommissionPct * costMultiplier;
  const grossPnl = position.direction === "LONG"
    ? (modelledExitPrice - position.entryPrice) * position.quantity
    : (position.entryPrice - modelledExitPrice) * position.quantity;
  const netPnl = grossPnl - position.entryCommission - exitCommission;
  const holdTimeUnprovable = position.holdTimeUnprovable || barIndex === position.entryBarIndex;

  const trade = Object.freeze({
    routeLabel: position.routeLabel,
    strategyId: position.strategyId,
    direction: position.direction,
    regimeLabel: position.regimeLabel,
    entryBarIndex: position.entryBarIndex,
    entryTime: position.entryTime,
    exitBarIndex: barIndex,
    exitTime: bar.closeTime,
    requestedEntryPrice: position.requestedEntryPrice,
    entryPrice: position.entryPrice,
    requestedExitPrice,
    exitPrice: modelledExitPrice,
    stopReference: position.stopReference,
    targetReference: position.targetReference,
    quantity: position.quantity,
    riskAmount: position.riskAmount,
    grossPnl,
    entryCommission: position.entryCommission,
    exitCommission,
    netPnl,
    rMultiple: position.riskAmount > 0 ? netPnl / position.riskAmount : null,
    maxFavorableExcursion: carried.maxFavorableExcursion,
    maxAdverseExcursion: carried.maxAdverseExcursion,
    holdBars: barIndex - position.entryBarIndex + 1,
    holdTimeUnprovable,
    exitReason
  });

  return { exited: true, trade };
}

function tryEnter({
  candidate,
  fillBar,
  fillBarIndex,
  strategy,
  account,
  state,
  costMultiplier,
  lotRules,
  entryCommissionPct,
  slippagePct,
  routeLabel
}) {
  const fillOpenTimeMs = Date.parse(fillBar.openTime);
  if (isAtOrAfterHardFlat(fillOpenTimeMs, strategy.execution.hardFlatUtc)) {
    return { entered: false, reason: "HARD_FLAT_WINDOW" };
  }

  const context = {
    liveEquity: state.closedBalance + state.dailyUnrealizedPnl,
    lockedOut: false,
    indicatorsWarm: true,
    feedStale: false,
    regimeAllowed: true,
    newsBlackout: false
  };
  const gate = evaluateResearchRiskGate(state, account, strategy, context);
  if (!gate.ok) return { entered: false, reason: gate.reason };

  const atr15m = candidate.stopDistance / strategy.signal.stopAtrMultiple;
  const dailyStopRemaining = (state.dailyRealizedPnl + state.dailyUnrealizedPnl) -
    strategy.risk.dailyHardStop;
  const sizing = computeSize({
    price: fillBar.open,
    atr15m,
    stopAtrMultiple: strategy.signal.stopAtrMultiple,
    dailyStopRemaining,
    liveEquity: context.liveEquity,
    activeFloor: activeFloor(state, account),
    stageRiskCap: RESEARCH_STAGE_RISK_CAP,
    maxNotional: strategy.risk.maxNotional,
    rules: lotRules
  });
  if (!sizing) return { entered: false, reason: "SIZING_REJECTED" };

  const scaledSlippage = slippagePct * costMultiplier;
  const entryPrice = applySlippage(fillBar.open, candidate.direction, "ENTRY", scaledSlippage);
  const entryNotional = entryPrice * sizing.qty;
  const entryCommission = entryNotional * entryCommissionPct * costMultiplier;

  return {
    entered: true,
    position: {
      routeLabel,
      strategyId: candidate.strategyId,
      direction: candidate.direction,
      regimeLabel: candidate.regime?.classification ?? null,
      entryBarIndex: fillBarIndex,
      entryTime: fillBar.openTime,
      requestedEntryPrice: fillBar.open,
      entryPrice,
      entryCommission,
      stopReference: candidate.stopReference,
      targetReference: candidate.targetReference,
      quantity: sizing.qty,
      riskAmount: sizing.risk,
      timeStopBarIndex: fillBarIndex + candidate.timeStopBars,
      maxFavorableExcursion: 0,
      maxAdverseExcursion: 0,
      holdTimeUnprovable: false
    }
  };
}

function forceCloseAtClose({ position, bar, barIndex, costMultiplier, exitCommissionPct, slippagePct, exitReason }) {
  const scaledSlippage = slippagePct * costMultiplier;
  const requestedExitPrice = bar.close;
  const modelledExitPrice = applySlippage(requestedExitPrice, position.direction, "EXIT", scaledSlippage);
  const exitNotional = modelledExitPrice * position.quantity;
  const exitCommission = exitNotional * exitCommissionPct * costMultiplier;
  const grossPnl = position.direction === "LONG"
    ? (modelledExitPrice - position.entryPrice) * position.quantity
    : (position.entryPrice - modelledExitPrice) * position.quantity;
  const netPnl = grossPnl - position.entryCommission - exitCommission;
  const excursion = updateExcursion(position, bar);

  return Object.freeze({
    routeLabel: position.routeLabel,
    strategyId: position.strategyId,
    direction: position.direction,
    regimeLabel: position.regimeLabel,
    entryBarIndex: position.entryBarIndex,
    entryTime: position.entryTime,
    exitBarIndex: barIndex,
    exitTime: bar.closeTime,
    requestedEntryPrice: position.requestedEntryPrice,
    entryPrice: position.entryPrice,
    requestedExitPrice,
    exitPrice: modelledExitPrice,
    stopReference: position.stopReference,
    targetReference: position.targetReference,
    quantity: position.quantity,
    riskAmount: position.riskAmount,
    grossPnl,
    entryCommission: position.entryCommission,
    exitCommission,
    netPnl,
    rMultiple: position.riskAmount > 0 ? netPnl / position.riskAmount : null,
    maxFavorableExcursion: excursion.maxFavorableExcursion,
    maxAdverseExcursion: excursion.maxAdverseExcursion,
    holdBars: barIndex - position.entryBarIndex + 1,
    holdTimeUnprovable: position.holdTimeUnprovable || barIndex === position.entryBarIndex,
    exitReason
  });
}

/**
 * Section 7's bar loop for a single static-bracket strategy (Slot 3 in Step
 * 26.3). signalFn must match strategies/meanReversion.js's
 * evaluateMeanReversion shape: ({bars15m, bars4h, bars1d, decisionIndex,
 * strategy}) => an evaluateSignal-shaped result. One open position across
 * the whole call (Section 7's router-wide one-position rule); this function
 * does not itself route between multiple strategies — that is router.js
 * (Step 26.5).
 *
 * On a detected account failure (Section 9.2), any open position is forced
 * flat at that bar's close and the run halts immediately rather than
 * continuing to trade a failed account — the run's `accountFailure` field
 * records where.
 */
export function runBacktest({
  bars15m,
  bars4h,
  bars1d,
  signalFn,
  strategy,
  account,
  startIndex = 1,
  endIndex = bars15m.length - 2,
  costMultiplier = 1,
  lotRules = DEFAULT_LOT_RULES,
  entryCommissionPct = DEFAULT_ENTRY_COMMISSION_PCT,
  exitCommissionPct = DEFAULT_EXIT_COMMISSION_PCT,
  slippagePct = strategy.execution.slippageCapPct,
  routeLabel = "meanReversion"
}) {
  if (!Array.isArray(bars15m) || bars15m.length < 2) {
    throw new Error("bars15m must contain at least 2 bars");
  }
  if (typeof signalFn !== "function") throw new Error("signalFn must be a function");
  if (!Number.isInteger(startIndex) || startIndex < 1) {
    throw new Error("startIndex must be an integer of at least 1");
  }
  if (!Number.isInteger(endIndex) || endIndex < startIndex || endIndex > bars15m.length - 2) {
    throw new Error("endIndex must be an integer >= startIndex that leaves room for a fill bar");
  }
  requireFiniteNumber("costMultiplier", costMultiplier);
  if (costMultiplier <= 0) throw new Error("costMultiplier must be positive");

  let state = createResearchAccountState(account, { stage: 1 });
  let position = null;
  const trades = [];
  let accountFailure = null;
  let previousCloseTimeMs = Date.parse(bars15m[startIndex - 1].closeTime);
  let haltedAtIndex = null;

  for (let decisionIndex = startIndex; decisionIndex <= endIndex; decisionIndex += 1) {
    const decisionBar = bars15m[decisionIndex];
    const decisionCloseTimeMs = Date.parse(decisionBar.closeTime);

    if (crossedAccountDayBoundary(previousCloseTimeMs, decisionCloseTimeMs, account.dailySnapshotUtc)) {
      state = applyAccountDayBoundary(state);
    }
    previousCloseTimeMs = decisionCloseTimeMs;

    if (position) {
      const outcome = resolveOpenPosition({
        position,
        bar: decisionBar,
        barIndex: decisionIndex,
        strategy,
        costMultiplier,
        exitCommissionPct,
        slippagePct
      });
      if (outcome.exited) {
        state = recordTradeClose(state, account, { realizedPnl: outcome.trade.netPnl });
        state = markUnrealized(state, 0);
        trades.push(outcome.trade);
        position = null;
      } else {
        state = markUnrealized(state, outcome.unrealizedPnl);
        position = outcome.position;
      }
    }

    const liveEquity = state.closedBalance + state.dailyUnrealizedPnl;
    const failureCheck = checkAccountFailure(liveEquity, state, account);
    if (failureCheck.failed) {
      if (position) {
        const forced = forceCloseAtClose({
          position,
          bar: decisionBar,
          barIndex: decisionIndex,
          costMultiplier,
          exitCommissionPct,
          slippagePct,
          exitReason: "ACCOUNT_FAILURE"
        });
        state = recordTradeClose(state, account, { realizedPnl: forced.netPnl });
        state = markUnrealized(state, 0);
        trades.push(forced);
        position = null;
      }
      accountFailure = Object.freeze({
        atBarIndex: decisionIndex,
        atCloseTime: decisionBar.closeTime,
        liveEquity: failureCheck.liveEquity,
        activeFloor: failureCheck.activeFloor
      });
      haltedAtIndex = decisionIndex;
      break;
    }

    if (!position && decisionIndex + 1 < bars15m.length) {
      const candidate = signalFn({ bars15m, bars4h, bars1d, decisionIndex, strategy });
      if (candidate.status === "CANDIDATE") {
        const fillBarIndex = decisionIndex + 1;
        const fillBar = bars15m[fillBarIndex];
        const entryAttempt = tryEnter({
          candidate,
          fillBar,
          fillBarIndex,
          strategy,
          account,
          state,
          costMultiplier,
          lotRules,
          entryCommissionPct,
          slippagePct,
          routeLabel
        });
        if (entryAttempt.entered) {
          position = entryAttempt.position;
          state = openPosition(state);
        }
      }
    }
  }

  if (position && !accountFailure) {
    // A candidate can fire on decisionIndex === endIndex, opening a position
    // whose fill bar (entryBarIndex = endIndex + 1) sits one past the loop's
    // last iteration — the position never gets a resolveOpenPosition() pass.
    // Clamping only to endIndex would force-close using a bar strictly
    // before entryBarIndex (exitBarIndex < entryBarIndex, a negative-hold
    // trade). Flooring at position.entryBarIndex guarantees the exit bar is
    // never earlier than the entry bar; the fill bar's own close is then
    // used, and holdTimeUnprovable is correctly set via barIndex ===
    // entryBarIndex below.
    const lastIndex = Math.min(Math.max(endIndex, position.entryBarIndex), bars15m.length - 1);
    const forced = forceCloseAtClose({
      position,
      bar: bars15m[lastIndex],
      barIndex: lastIndex,
      costMultiplier,
      exitCommissionPct,
      slippagePct,
      exitReason: "END_OF_DATA"
    });
    state = recordTradeClose(state, account, { realizedPnl: forced.netPnl });
    state = markUnrealized(state, 0);
    trades.push(forced);
    position = null;
  }

  return Object.freeze({
    trades: Object.freeze(trades),
    finalState: state,
    accountFailure,
    haltedAtIndex,
    startIndex,
    endIndex
  });
}
