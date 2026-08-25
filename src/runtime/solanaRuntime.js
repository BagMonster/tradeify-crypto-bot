import { evaluateGridRisk } from "../risk/accountRules.js";
import {
  LADDER_ACTIONS,
  accountDayKey,
  createInitialLadderState,
  evaluateRiskLadder,
  markFlattenDone,
  markPartialCutDone,
  normalizeLadderState,
  rollAccountDay,
  withLadderObservation
} from "../risk/dailyRiskLadder.js";
import {
  GRID_DEFINITION,
  applyConfirmedEntry,
  applyConfirmedExit,
  applyConfirmedProtectiveCut,
  applySkippedExit,
  buildProtectiveCutPlan,
  createInitialSolanaState,
  entryCandidates,
  expectedNetUnits,
  grossVirtualExposureUsd,
  nextExitAction,
  normalizeSolanaState,
  observeRearm,
  resetAfterProtectiveFlatten
} from "../strategies/solanaGrid.js";

function positive(name, value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`${name} must be positive`);
  return n;
}

function finite(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function canonicalUtc(name, value) {
  if (typeof value !== "string") throw new TypeError(`${name} must be a canonical UTC timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) throw new TypeError(`${name} must be a canonical UTC timestamp`);
  return value;
}

function normalizeTrade(trade) {
  if (!trade || typeof trade !== "object" || Array.isArray(trade)) throw new TypeError("SOL live trade must be an object");
  if (trade.source !== "binance" || trade.symbol !== "SOLUSDT") throw new TypeError("SOL runtime accepts only Binance SOLUSDT trades");
  return Object.freeze({
    source: "binance",
    symbol: "SOLUSDT",
    price: positive("trade.price", trade.price),
    tradeTime: canonicalUtc("trade.tradeTime", trade.tradeTime)
  });
}

function findLot(state, lotId) {
  for (const ring of state.rings) {
    const lot = ring.lots.find((candidate) => candidate.id === lotId);
    if (lot) return lot;
  }
  return null;
}

function ladderStateChanged(left, right) {
  return left.dayKey !== right.dayKey ||
    left.baselineClosedBalanceUsd !== right.baselineClosedBalanceUsd ||
    left.brakeEngaged !== right.brakeEngaged ||
    left.partialCutDone !== right.partialCutDone ||
    left.flattenDone !== right.flattenDone ||
    left.haltedForDay !== right.haltedForDay ||
    Math.abs(left.worstDrawdownUsd - right.worstDrawdownUsd) >= 1;
}

export function createSolanaRuntime({
  stateStore,
  riskLadderStore,
  riskLadderConfig,
  maProvider,
  getRiskSnapshot,
  execution,
  minimumHoldSeconds = 25,
  addEvent = async () => {},
  notifications = null
}) {
  for (const method of ["init", "load", "initializeIfMissing", "save"]) {
    if (typeof stateStore?.[method] !== "function") throw new TypeError(`stateStore.${method} is required`);
  }
  for (const method of ["getLatestRiskLadderState", "saveRiskLadderState"]) {
    if (typeof riskLadderStore?.[method] !== "function") throw new TypeError(`riskLadderStore.${method} is required`);
  }
  if (!riskLadderConfig || riskLadderConfig.enabled !== true) throw new TypeError("D-049 risk ladder config must be enabled");
  if (typeof maProvider?.getCurrent !== "function") throw new TypeError("maProvider.getCurrent is required");
  if (typeof getRiskSnapshot !== "function") throw new TypeError("getRiskSnapshot is required");
  if (typeof execution?.isEnabled !== "function" || typeof execution?.executeIntent !== "function" ||
      typeof execution?.executeProtectiveCut !== "function" || typeof execution?.executeProtectiveFlatten !== "function") {
    throw new TypeError("SOL execution interface is invalid");
  }
  if (!Number.isInteger(minimumHoldSeconds) || minimumHoldSeconds < 25 || minimumHoldSeconds > 300) throw new TypeError("minimumHoldSeconds is invalid");
  if (typeof addEvent !== "function") throw new TypeError("addEvent must be a function");
  if (notifications !== null && typeof notifications?.enqueue !== "function") throw new TypeError("notifications.enqueue must be a function");

  let previousPrice = null;
  let lastShadowKey = null;
  let ladderState = createInitialLadderState();

  function enqueueNotification(event) {
    if (notifications !== null) notifications.enqueue(event);
  }

  async function init() {
    await stateStore.init();
    let state = await stateStore.load();
    if (!state) state = await stateStore.initializeIfMissing(createInitialSolanaState());
    const storedLadder = await riskLadderStore.getLatestRiskLadderState();
    ladderState = storedLadder ? normalizeLadderState(storedLadder) : createInitialLadderState();
    return state;
  }

  function getRiskLadderState() {
    return ladderState;
  }

  async function auditShadowOnce(key, kind, payload) {
    if (lastShadowKey === key) return;
    lastShadowKey = key;
    await addEvent("INFO", kind, payload);
  }

  async function riskFor(state, trade, proposedAdditionalNotional = 0) {
    const snapshot = await getRiskSnapshot({ state, trade });
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("SOL risk snapshot is invalid");
    const risk = evaluateGridRisk({ ...snapshot, proposedAdditionalNotional });
    return { snapshot, risk };
  }

  function reconciliationStatus(state, snapshot, tradeTime) {
    const expected = expectedNetUnits(state);
    const actual = Number(snapshot.brokerNetUnits ?? 0);
    if (!Number.isFinite(actual)) return { ok: false, expected, actual: null };
    if (Math.abs(expected - actual) <= 0.0050001) return { ok: true, expected, actual };
    const lastFillMs = state.lastFillAt ? Date.parse(state.lastFillAt) : NaN;
    const ageMs = Number.isFinite(lastFillMs) ? Date.parse(tradeTime) - lastFillMs : Infinity;
    return { ok: ageMs >= 0 && ageMs < 5_000, expected, actual, grace: ageMs >= 0 && ageMs < 5_000 };
  }

  async function saveLadder(next, force = false) {
    const normalized = normalizeLadderState(next);
    if (normalized.dayKey === null || normalized.baselineClosedBalanceUsd === null) {
      ladderState = normalized;
      return ladderState;
    }
    if (!force && !ladderStateChanged(ladderState, normalized)) {
      ladderState = normalized;
      return ladderState;
    }
    ladderState = normalizeLadderState(await riskLadderStore.saveRiskLadderState(normalized));
    return ladderState;
  }

  async function ladderVerdict(snapshot, trade) {
    const nowMs = Date.parse(trade.tradeTime);
    const currentDay = accountDayKey(nowMs);

    if (ladderState.dayKey === currentDay && ladderState.haltedForDay) {
      const equity = finite(snapshot.liveEquity);
      const drawdownUsd = equity === null || ladderState.baselineClosedBalanceUsd === null
        ? 0
        : equity - ladderState.baselineClosedBalanceUsd;
      return Object.freeze({
        verdict: Object.freeze({ action: LADDER_ACTIONS.HALTED_FOR_DAY, drawdownUsd, reason: "flattened-this-day" }),
        issue: null
      });
    }

    const baseline = finite(snapshot.previousDayClosingBalance);
    const equity = finite(snapshot.liveEquity);
    if (snapshot.accountDataFresh !== true || baseline === null || baseline <= 0 || equity === null) {
      return Object.freeze({
        verdict: Object.freeze({ action: LADDER_ACTIONS.BRAKE, drawdownUsd: 0, reason: "unknown-equity-or-baseline" }),
        issue: "D049_ACCOUNT_INPUT_UNAVAILABLE"
      });
    }

    if (ladderState.dayKey !== currentDay) {
      const rolled = rollAccountDay(ladderState, nowMs, baseline);
      ladderState = await saveLadder(rolled.state, true);
      await addEvent("INFO", "SOL_D049_ACCOUNT_DAY_ROLLED", {
        dayKey: ladderState.dayKey,
        baselineClosedBalanceUsd: ladderState.baselineClosedBalanceUsd
      });
    }

    if (Math.abs(ladderState.baselineClosedBalanceUsd - baseline) > 0.01) {
      const drawdownUsd = equity - ladderState.baselineClosedBalanceUsd;
      return Object.freeze({
        verdict: Object.freeze({ action: LADDER_ACTIONS.BRAKE, drawdownUsd, reason: "baseline-mismatch" }),
        issue: "D049_BASELINE_MISMATCH"
      });
    }

    return Object.freeze({
      verdict: evaluateRiskLadder(ladderState, riskLadderConfig, equity),
      issue: null
    });
  }

  async function processTrade(input) {
    const trade = normalizeTrade(input);
    const maState = await maProvider.getCurrent();
    const ma = positive("current SOL 200-day MA", maState.ma);
    let state = normalizeSolanaState(await stateStore.load() ?? await stateStore.initializeIfMissing(createInitialSolanaState()));

    const firstRisk = await riskFor(state, trade, 0);
    const recon = reconciliationStatus(state, firstRisk.snapshot, trade.tradeTime);
    if (!recon.ok) {
      await addEvent("ERROR", "SOL_NET_RECONCILIATION_MISMATCH", {
        expectedVirtualNetUnits: recon.expected,
        brokerNetUnits: recon.actual
      });
      previousPrice = trade.price;
      return Object.freeze({ status: "RECONCILIATION_BLOCKED", state, ma, reconciliation: Object.freeze({ ...recon }) });
    }

    // Existing funded-account floor protections remain highest-priority emergency actions.
    if (firstRisk.risk.protectiveAction === "FLATTEN_AND_LOCK") {
      const result = await execution.executeProtectiveFlatten({ stateVersion: state.version, reason: firstRisk.risk.reason });
      if (result.status === "FILLED" || result.status === "ALREADY_FLAT") {
        const reset = resetAfterProtectiveFlatten(state, {
          fillPrice: result.fillPrice ?? trade.price,
          filledAt: result.filledAt ?? trade.tradeTime
        });
        state = await stateStore.save(state.version, reset);
        await addEvent("WARN", "SOL_PROTECTIVE_STATE_RESET", { reason: firstRisk.risk.reason, stateVersion: state.version });
        if (result.status === "FILLED") {
          enqueueNotification({
            kind: "PROTECTIVE_FLATTEN_CONFIRMED",
            eventKey: `SOL-PROTECTIVE-${state.version}`,
            reason: firstRisk.risk.reason,
            quantity: result.filledQuantity,
            fillPrice: result.fillPrice,
            filledAt: result.filledAt
          });
        }
        previousPrice = trade.price;
        return Object.freeze({ status: "PROTECTIVE_FILLED", state, ma });
      }
      previousPrice = trade.price;
      return Object.freeze({ status: "PROTECTIVE_PENDING", state, ma, result });
    }

    // D-049 is evaluated before normal re-arm, tranche exits, entries, or heartbeat work.
    const ladder = await ladderVerdict(firstRisk.snapshot, trade);
    let verdict = ladder.verdict;
    let blockEntries = verdict.action !== LADDER_ACTIONS.NORMAL;

    if (ladder.issue) {
      await addEvent("ERROR", ladder.issue, {
        dayKey: ladderState.dayKey,
        reason: verdict.reason,
        storedBaseline: ladderState.baselineClosedBalanceUsd,
        brokerBaseline: firstRisk.snapshot.previousDayClosingBalance ?? null
      });
    }

    if (verdict.action === LADDER_ACTIONS.HALTED_FOR_DAY) {
      previousPrice = trade.price;
      return Object.freeze({ status: "D049_HALTED_FOR_DAY", state, ma, ladderState, ladderVerdict: verdict });
    }

    if (verdict.action === LADDER_ACTIONS.FULL_FLATTEN) {
      const result = await execution.executeProtectiveFlatten({
        stateVersion: state.version,
        reason: "D-049 full flatten",
        dayKey: ladderState.dayKey,
        bypassSlippageCap: true
      });
      if (result.status !== "FILLED" && result.status !== "ALREADY_FLAT") {
        await addEvent("ERROR", "SOL_D049_FULL_FLATTEN_UNCONFIRMED", {
          dayKey: ladderState.dayKey,
          drawdownUsd: verdict.drawdownUsd,
          brokerStatus: result.status ?? "UNKNOWN"
        });
        previousPrice = trade.price;
        return Object.freeze({ status: "D049_FULL_FLATTEN_UNCONFIRMED", state, ma, ladderState, ladderVerdict: verdict, result });
      }

      const reset = resetAfterProtectiveFlatten(state, {
        fillPrice: result.fillPrice ?? trade.price,
        filledAt: result.filledAt ?? trade.tradeTime
      });
      state = await stateStore.save(state.version, reset);
      ladderState = await saveLadder(markFlattenDone(ladderState, verdict.drawdownUsd), true);
      await addEvent("WARN", "SOL_D049_FULL_FLATTEN_CONFIRMED", {
        dayKey: ladderState.dayKey,
        drawdownUsd: verdict.drawdownUsd,
        brokerStatus: result.status,
        stateVersion: state.version
      });
      enqueueNotification({
        kind: "D049_FULL_FLATTEN",
        eventKey: `SOL-D049-FLAT:${ladderState.dayKey}`,
        drawdownUsd: verdict.drawdownUsd,
        fillPrice: result.fillPrice ?? null,
        filledQuantity: result.filledQuantity ?? 0,
        confirmedFlat: true,
        filledAt: result.filledAt ?? trade.tradeTime
      });
      previousPrice = trade.price;
      return Object.freeze({ status: "D049_FULL_FLATTENED", state, ma, ladderState, ladderVerdict: verdict });
    }

    if (verdict.action === LADDER_ACTIONS.PARTIAL_CUT) {
      let plan;
      try {
        plan = buildProtectiveCutPlan(state, riskLadderConfig.partialCutFraction);
      } catch (error) {
        await addEvent("ERROR", "SOL_D049_PARTIAL_CUT_PLAN_FAILED", { reason: error.message });
        previousPrice = trade.price;
        return Object.freeze({ status: "D049_PARTIAL_CUT_UNCONFIRMED", state, ma, ladderState, ladderVerdict: verdict, result: Object.freeze({ status: "PLAN_FAILED" }) });
      }

      if (plan.quantity >= GRID_DEFINITION.lotStep - 1e-12) {
        const result = await execution.executeProtectiveCut({
          stateVersion: state.version,
          dayKey: ladderState.dayKey,
          quantity: plan.quantity,
          side: plan.side,
          reason: "D-049 partial cut",
          bypassSlippageCap: true
        });
        if (result.status !== "FILLED") {
          await addEvent("ERROR", "SOL_D049_PARTIAL_CUT_UNCONFIRMED", {
            dayKey: ladderState.dayKey,
            drawdownUsd: verdict.drawdownUsd,
            brokerStatus: result.status ?? "UNKNOWN"
          });
          previousPrice = trade.price;
          return Object.freeze({ status: "D049_PARTIAL_CUT_UNCONFIRMED", state, ma, ladderState, ladderVerdict: verdict, result });
        }
        state = await stateStore.save(state.version, applyConfirmedProtectiveCut(state, plan, result));
        ladderState = await saveLadder(markPartialCutDone(ladderState, verdict.drawdownUsd), true);
        enqueueNotification({
          kind: "D049_PARTIAL_CUT",
          eventKey: `SOL-D049-CUT:${ladderState.dayKey}`,
          drawdownUsd: verdict.drawdownUsd,
          fraction: riskLadderConfig.partialCutFraction,
          filledQuantity: result.filledQuantity,
          fillPrice: result.fillPrice,
          lotsAffected: plan.legs.length,
          filledAt: result.filledAt
        });
      } else {
        ladderState = await saveLadder(markPartialCutDone(ladderState, verdict.drawdownUsd), true);
        await addEvent("WARN", "SOL_D049_PARTIAL_CUT_NO_EXECUTABLE_LOTS", {
          dayKey: ladderState.dayKey,
          drawdownUsd: verdict.drawdownUsd
        });
      }
      blockEntries = true;
    } else if (verdict.action === LADDER_ACTIONS.BRAKE || ladder.issue) {
      const observed = withLadderObservation(ladderState, { drawdownUsd: verdict.drawdownUsd, brakeEngaged: true });
      ladderState = await saveLadder(observed, ladderState.brakeEngaged !== true);
      blockEntries = true;
    } else {
      const observed = withLadderObservation(ladderState, { drawdownUsd: verdict.drawdownUsd, brakeEngaged: false });
      ladderState = await saveLadder(observed, ladderState.brakeEngaged === true);
      blockEntries = false;
    }

    const observed = observeRearm(state, { price: trade.price, ma });
    if (observed.version !== state.version) {
      state = await stateStore.save(state.version, observed);
      await addEvent("INFO", "SOL_RING_REARMED", { stateVersion: state.version, price: trade.price, ma });
    }

    // Live production rule: all eligible exits before any entries.
    while (true) {
      const action = nextExitAction(state, { price: trade.price, ma });
      if (!action) break;
      if (action.type === "SKIP_EXIT") {
        state = await stateStore.save(state.version, applySkippedExit(state, action));
        await addEvent("INFO", "SOL_EXIT_TRANCHE_SKIPPED_BELOW_LOT", {
          ringTag: action.ringTag,
          lotId: action.lotId,
          tranche: action.tranche,
          stateVersion: state.version
        });
        continue;
      }

      const lot = findLot(state, action.lotId);
      if (!lot) throw new Error("SOL exit intent lot disappeared");
      const heldMs = Date.parse(trade.tradeTime) - Date.parse(lot.openedAt);
      if (!Number.isFinite(heldMs) || heldMs < minimumHoldSeconds * 1000) break;

      if (!execution.isEnabled()) {
        await auditShadowOnce(`EXIT:${state.version}:${action.lotId}:${action.tranche}`, "SOL_SHADOW_EXIT", {
          ringTag: action.ringTag,
          tranche: action.tranche,
          quantity: action.quantity,
          target: action.target,
          observedPrice: trade.price,
          ma
        });
        break;
      }

      const lotBeforeExit = Object.freeze({ ...lot });
      const result = await execution.executeIntent(action);
      if (result.status !== "FILLED") {
        previousPrice = trade.price;
        return Object.freeze({ status: "EXIT_PENDING", state, ma, action, result, ladderState });
      }
      state = await stateStore.save(state.version, applyConfirmedExit(state, action, result));
      const lotAfterExit = findLot(state, action.lotId);
      enqueueNotification({
        kind: "TRANCHE_EXIT_CONFIRMED",
        eventKey: `SOL-TRANCHE:${result.orderCode}`,
        ringTag: action.ringTag,
        virtualSide: action.virtualSide,
        lotId: action.lotId,
        tranche: action.tranche,
        fillPrice: result.fillPrice,
        filledQuantity: result.filledQuantity,
        remainingQuantity: lotAfterExit?.remainingUnits ?? 0,
        ma,
        target: action.target,
        filledAt: result.filledAt
      });
      if (!lotAfterExit) {
        enqueueNotification({
          kind: "LOT_CLOSED",
          eventKey: `SOL-LOT-CLOSED:${result.orderCode}`,
          ringTag: action.ringTag,
          virtualSide: action.virtualSide,
          lotId: action.lotId,
          entryPrice: lotBeforeExit.entryPrice,
          originalQuantity: lotBeforeExit.originalUnits,
          finalFillPrice: result.fillPrice,
          openedAt: lotBeforeExit.openedAt,
          closedAt: result.filledAt
        });
      }
      lastShadowKey = null;
    }

    if (!blockEntries) {
      const candidates = entryCandidates(state, { previousPrice, price: trade.price, ma });
      for (const original of candidates) {
        const ring = state.rings.find((candidate) => candidate.tag === original.ringTag);
        if (!ring || !ring.armed || ring.lots.length >= GRID_DEFINITION.perRing) continue;
        const quantity = original.quantity;
        const proposed = quantity * trade.price;
        const gross = grossVirtualExposureUsd(state, trade.price);
        if (gross + proposed > GRID_DEFINITION.grossExposureCeilingUsd + 1e-8) {
          await auditShadowOnce(`CEILING:${state.version}:${original.tag}`, "SOL_ENTRY_BLOCKED_GROSS_EXPOSURE", {
            tag: original.tag,
            grossExposureUsd: gross,
            proposedNotional: proposed,
            ceilingUsd: GRID_DEFINITION.grossExposureCeilingUsd
          });
          continue;
        }

        const { risk } = await riskFor(state, trade, proposed);
        if (!risk.allowNewGridAction) {
          await auditShadowOnce(`RISK:${state.version}:${original.tag}:${risk.reason}`, "SOL_ENTRY_BLOCKED", {
            tag: original.tag,
            reason: risk.reason
          });
          continue;
        }

        const intent = Object.freeze({
          ...original,
          stateVersion: state.version,
          lotId: `${original.tag}-V${state.version}`
        });
        if (!execution.isEnabled()) {
          await auditShadowOnce(`ENTRY:${state.version}:${intent.tag}`, "SOL_SHADOW_ENTRY", {
            tag: intent.tag,
            side: intent.side,
            quantity: intent.quantity,
            usd: intent.usd,
            ringLevel: intent.ringLevel,
            observedPrice: trade.price,
            ma
          });
          continue;
        }

        const result = await execution.executeIntent(intent);
        if (result.status !== "FILLED") {
          previousPrice = trade.price;
          return Object.freeze({ status: "ENTRY_PENDING", state, ma, intent, result, ladderState });
        }
        state = await stateStore.save(state.version, applyConfirmedEntry(state, intent, result));
        enqueueNotification({
          kind: "ENTRY_CONFIRMED",
          eventKey: `SOL-ENTRY:${result.orderCode}`,
          ringTag: intent.ringTag,
          side: intent.side,
          fillPrice: result.fillPrice,
          filledQuantity: result.filledQuantity,
          lotId: intent.lotId,
          ma,
          filledAt: result.filledAt
        });
        lastShadowKey = null;
      }
    }

    previousPrice = trade.price;
    const status = ladder.issue ?? (execution.isEnabled() ? "PROCESSED" : "SHADOW");
    return Object.freeze({ status, state, ma, maCompletedThrough: maState.completedThrough, ladderState, ladderVerdict: verdict });
  }

  return Object.freeze({ init, processTrade, getRiskLadderState, definition: GRID_DEFINITION });
}
