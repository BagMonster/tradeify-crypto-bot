import { isTrancheExitsPaused } from "../risk/sessionHarvest.js";
import { computeShift, initialAnchorShiftState, normalizeAnchorShiftState, trackExcursion } from "../strategies/anchorShift.js";

function positive(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`${name} must be positive`);
  return n;
}

function realizedPnlUsd({ virtualSide, entryPrice, fillPrice, quantity }) {
  const entry = positive("dust entry price", entryPrice);
  const fill = positive("dust fill price", fillPrice);
  const units = positive("dust quantity", quantity);
  const pnl = virtualSide === "BUY" ? (fill - entry) * units : (entry - fill) * units;
  return Number(pnl.toFixed(8));
}

function canonicalTrade(trade, marketSymbol) {
  if (!trade || trade.source !== "binance" || trade.symbol !== marketSymbol) throw new TypeError(`ring instance accepts only Binance ${marketSymbol} trades`);
  const tradeTime = typeof trade.tradeTime === "string" ? trade.tradeTime : "";
  if (!Number.isFinite(Date.parse(tradeTime)) || new Date(tradeTime).toISOString() !== tradeTime) throw new TypeError("trade time must be canonical UTC");
  return Object.freeze({ source: "binance", symbol: marketSymbol, price: positive("trade price", trade.price), tradeTime });
}

function requiredStore(store) {
  for (const method of ["init", "load", "initializeIfMissing", "save"]) if (typeof store?.[method] !== "function") throw new TypeError(`stateStore.${method} is required`);
  return store;
}

function eventPrefix(orderPrefix, instrument) {
  const raw = typeof orderPrefix === "string" && orderPrefix.trim() !== "" ? orderPrefix.trim() : String(instrument ?? "GRID").replace(/[^A-Za-z0-9]/g, "");
  return raw.toUpperCase();
}

export function createRingGridInstance({
  grid,
  stateStore,
  maProvider,
  execution,
  minimumHoldSeconds = 25,
  addEvent = async () => {},
  notifications = null,
  anchorStore = null
}) {
  if (!grid || typeof grid.createInitialState !== "function" || typeof grid.entryCandidates !== "function") throw new TypeError("grid must be a ring-grid instance");
  const store = requiredStore(stateStore);
  if (typeof maProvider?.getCurrent !== "function") throw new TypeError("maProvider.getCurrent is required");
  if (typeof execution?.executeIntent !== "function" || typeof execution?.executeProtectiveCut !== "function" || typeof execution?.executeProtectiveFlatten !== "function") throw new TypeError("execution interface is invalid");
  if (!Number.isInteger(minimumHoldSeconds) || minimumHoldSeconds < 25) throw new TypeError("minimumHoldSeconds is invalid");
  if (typeof addEvent !== "function") throw new TypeError("addEvent must be a function");
  if (notifications !== null && typeof notifications?.enqueue !== "function") throw new TypeError("notifications.enqueue must be a function");
  if (anchorStore !== null && (typeof anchorStore?.load !== "function" || typeof anchorStore?.save !== "function" || typeof anchorStore?.commitShift !== "function")) throw new TypeError("anchorStore is invalid");
  const { instrument, marketSymbol, lotStep, grossExposureCeilingUsd, orderPrefix } = grid.definition;
  const prefix = eventPrefix(orderPrefix, instrument);
  let previousPrice = null;
  let entryBrake = false;
  let trancheExitsPaused = false;
  let currentState = null;
  let anchorState = initialAnchorShiftState();
  let pendingAnchorWrite = null;
  let anchorWriteRunning = false;
  let anchorWriteDrain = Promise.resolve();
  let anchorShiftHold = false;
  let lastPrice = null;
  let anchorOperation = Promise.resolve();

  function serializeAnchor(task) {
    const result = anchorOperation.then(task, task);
    anchorOperation = result.catch(() => undefined);
    return result;
  }

  function enqueueNotification(event) {
    if (notifications !== null) notifications.enqueue(event);
  }

  function queueAnchorSave(next) {
    if (anchorStore === null) return;
    // Trade processing never awaits an excursion write. A busy PostgreSQL must
    // not create one queued write per Binance tick; retain only the newest full
    // state and drain it in order once the current write finishes.
    pendingAnchorWrite = next;
    if (anchorWriteRunning) return;
    anchorWriteRunning = true;
    anchorWriteDrain = (async () => {
      try {
        while (pendingAnchorWrite !== null) {
          const wanted = pendingAnchorWrite;
          pendingAnchorWrite = null;
          await anchorStore.save(wanted);
        }
      } catch (error) {
        void Promise.resolve().then(() => addEvent("ERROR", "ANCHOR_SHIFT_PERSIST_FAILED", { instrument, message: "anchor state save failed" })).catch(() => undefined);
      } finally {
        anchorWriteRunning = false;
        if (pendingAnchorWrite !== null) queueAnchorSave(pendingAnchorWrite);
      }
    })();
  }

  async function flushAnchorWrites() {
    // A confirmed shift must not be overwritten by an older, coalesced
    // excursion snapshot that was already queued by a price tick.
    while (anchorWriteRunning) {
      const drain = anchorWriteDrain;
      await drain;
      if (drain === anchorWriteDrain) break;
    }
  }

  async function init() {
    await store.init();
    const prior = await store.load();
    currentState = prior ?? await store.initializeIfMissing(grid.createInitialState());
    if (anchorStore !== null) {
      const persisted = await anchorStore.load();
      anchorState = normalizeAnchorShiftState(persisted ?? initialAnchorShiftState());
      if (persisted === null) await anchorStore.save(anchorState);
    }
    return currentState;
  }
  async function load() {
    currentState = (await store.load()) ?? await store.initializeIfMissing(grid.createInitialState());
    if (anchorStore !== null && anchorState === null) anchorState = normalizeAnchorShiftState((await anchorStore.load()) ?? initialAnchorShiftState());
    return currentState;
  }
  async function setEntryBrake(value) { entryBrake = value === true; }
  async function setTrancheExitsPaused(value) { trancheExitsPaused = value === true; }
  async function setAnchorShiftHold(value) { anchorShiftHold = value === true; }

  async function cut({ fraction, reason, dayKey }) {
    const state = await load();
    const plan = grid.buildProtectiveCutPlan(state, fraction);
    if (plan.quantity < lotStep - 1e-12) return Object.freeze({ status: "BELOW_LOT_STEP" });
    const result = await execution.executeProtectiveCut({ stateVersion: state.version, dayKey, quantity: plan.quantity, side: plan.side, reason, bypassSlippageCap: true });
    if (result.status !== "FILLED") return result;
    const next = grid.applyConfirmedProtectiveCut(state, plan, result);
    await store.save(state.version, next);
    return result;
  }

  async function flatten({ reason, dayKey }) {
    const state = await load();
    const result = await execution.executeProtectiveFlatten({ stateVersion: state.version, dayKey, reason, bypassSlippageCap: true });
    if (result.status === "ALREADY_FLAT") return result;
    if (result.status !== "FILLED") return result;
    const next = grid.resetAfterProtectiveFlatten(state, { fillPrice: result.fillPrice, filledAt: result.filledAt });
    await store.save(state.version, next);
    // The anchor-shift coordinator reads this in-memory state while confirming
    // a broker-flat account. Keep it synchronized with the durable reset so a
    // confirmed account-wide harvest is immediately eligible for its two
    // fresh-snapshot / nine-second confirmation flow.
    currentState = next;
    return result;
  }

  async function cleanupDust({ dayKey, openedBeforeMs, maxRemainingFraction, remainingLossBudgetUsd, markPrice, onConfirmedClose = async () => {} }) {
    if (typeof execution.executeDustCleanup !== "function") throw new Error("execution does not support dust cleanup");
    if (typeof onConfirmedClose !== "function") throw new TypeError("onConfirmedClose must be a function");
    const markBudget = Number(remainingLossBudgetUsd);
    if (!Number.isFinite(markBudget) || markBudget < 0) throw new TypeError("remainingLossBudgetUsd is invalid");
    let state = await load();
    const scan = grid.dustCleanupScan
      ? grid.dustCleanupScan(state, { openedBeforeMs, maxRemainingFraction })
      : Object.freeze({
          candidates: grid.dustCleanupCandidates(state, { openedBeforeMs, maxRemainingFraction }),
          excluded: Object.freeze({ currentAccountDay: 0, missingPositionCode: 0, noIntendedUnits: 0, aboveMaximumFraction: 0 })
        });
    const candidates = scan.candidates;
    const closed = [];
    const deferred = [];
    const failed = [];
    let availableLossUsd = markBudget;
    for (const candidate of candidates) {
      // The current live Binance mark is only a preflight estimate. The daily
      // budget is decremented from the confirmed DXtrade close fill below.
      // cleanupDust is called by the runtime wrapper with the current market
      // price, but retaining this guard keeps a stale process from guessing.
      if (!Number.isFinite(Number(markPrice)) || Number(markPrice) <= 0) {
        failed.push({ ...candidate, status: "MARK_UNAVAILABLE" });
        continue;
      }
      const estimatedPnlUsd = realizedPnlUsd({ virtualSide: candidate.virtualSide, entryPrice: candidate.entryPrice, fillPrice: Number(markPrice), quantity: candidate.remainingUnits });
      if (estimatedPnlUsd < 0 && -estimatedPnlUsd > availableLossUsd + 1e-8) {
        deferred.push({ ...candidate, estimatedPnlUsd, reason: "LOSS_BUDGET" });
        continue;
      }
      let positionCode = candidate.positionCode;
      if (positionCode === null) {
        if (typeof execution.resolveLegacyDustTicket !== "function") {
          failed.push({ ...candidate, status: "LEGACY_TICKET_LINK_UNAVAILABLE" });
          continue;
        }
        const linked = await execution.resolveLegacyDustTicket({
          lotId: candidate.lotId,
          virtualSide: candidate.virtualSide,
          quantity: candidate.remainingUnits
        });
        if (linked.status !== "LINKED") {
          failed.push({ ...candidate, status: linked.status, reason: linked.reason ?? null });
          continue;
        }
        positionCode = linked.positionCode;
      }
      const result = await execution.executeDustCleanup({
        stateVersion: state.version,
        dayKey,
        positionCode,
        quantity: candidate.remainingUnits,
        virtualSide: candidate.virtualSide,
        reason: "daily dust cleanup"
      });
      if (result.status !== "FILLED") {
        failed.push({ ...candidate, status: result.status, reason: result.reason ?? null });
        continue;
      }
      const filledQuantity = Number(result.filledQuantity);
      const realized = realizedPnlUsd({ virtualSide: candidate.virtualSide, entryPrice: candidate.entryPrice, fillPrice: result.fillPrice, quantity: filledQuantity });
      const close = { ...candidate, positionCode, orderCode: result.orderCode, fillPrice: result.fillPrice, filledQuantity, filledAt: result.filledAt, realizedPnlUsd: realized };
      // The loss allowance is durable before this confirmed broker close can
      // permit another losing dust ticket. A state-save failure after this point
      // is conservative: it may require reconciliation, but cannot over-spend
      // the day's automatic-loss allowance after a restart.
      await onConfirmedClose(close);
      const next = candidate.needsLegacyTicketLink === true
        ? grid.reduceLegacyLotById(state, candidate.lotId, filledQuantity)
        : grid.reduceLotByPositionCode(state, positionCode, filledQuantity);
      state = await store.save(state.version, next);
      if (realized < 0) availableLossUsd = Math.max(0, Number((availableLossUsd + realized).toFixed(8)));
      closed.push(close);
    }
    currentState = state;
    return Object.freeze({
      candidates: Object.freeze(candidates),
      excluded: scan.excluded,
      closed: Object.freeze(closed),
      deferred: Object.freeze(deferred),
      failed: Object.freeze(failed)
    });
  }

  async function getRolloverHarvestCandidates({ markPrice }) {
    if (typeof execution.listRolloverHarvestPositions !== "function") throw new Error("execution does not support account-wide rollover candidates");
    return (await execution.listRolloverHarvestPositions({ markPrice }))
      .map((candidate) => Object.freeze({ instrument, ...candidate }));
  }

  async function executeRolloverHarvest({ dayKey, allocations, onConfirmedClose = async () => {} }) {
    if (typeof execution.executeRolloverHarvestClose !== "function") throw new Error("execution does not support rollover harvest");
    if (!Array.isArray(allocations)) throw new TypeError("rollover harvest allocations are required");
    if (typeof onConfirmedClose !== "function") throw new TypeError("onConfirmedClose must be a function");
    let state = await load();
    const closed = [];
    const pending = [];
    for (const allocation of allocations) {
      if (allocation?.instrument !== instrument) throw new TypeError("rollover harvest allocation instrument is invalid");
      const positionCode = String(allocation.positionCode ?? "").trim();
      const lotId = String(allocation.lotId ?? "").trim();
      const quantity = Number(allocation.quantity);
      const plannedRemainingUnits = Number(allocation.remainingUnits);
      const entryPrice = Number(allocation.entryPrice);
      if (!positionCode || !lotId || !Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(quantity) || quantity < lotStep - 1e-12 || !Number.isFinite(plannedRemainingUnits) || plannedRemainingUnits < quantity) throw new TypeError("rollover harvest allocation is invalid");
      const found = grid.findLotByPositionCode(state, positionCode);
      // The broker fill and ring-state write can be separated by a process
      // crash. If the state already shows precisely this planned reduction,
      // mark the durable account plan complete without submitting anything.
      if (found && found.lot.side === allocation.virtualSide && found.lot.remainingUnits <= plannedRemainingUnits - quantity + 1e-8) {
        const recovered = { instrument, lotId, recovered: true };
        await onConfirmedClose(recovered);
        closed.push(recovered);
        continue;
      }
      if (found && (found.lot.side !== allocation.virtualSide || Math.abs(found.lot.remainingUnits - plannedRemainingUnits) > 1e-8)) {
        pending.push({ ...allocation, status: "POSITION_CHANGED" });
        break;
      }
      const result = await execution.executeRolloverHarvestClose({
        stateVersion: state.version,
        dayKey,
        positionCode,
        quantity,
        virtualSide: allocation.virtualSide,
        reason: "D-068 proportional rollover profit harvest"
      });
      if (result.status !== "FILLED") {
        pending.push({ ...allocation, status: result.status, reason: result.reason ?? null });
        break;
      }
      const filledQuantity = Number(result.filledQuantity);
      const realized = realizedPnlUsd({
        virtualSide: allocation.virtualSide,
        entryPrice,
        fillPrice: result.fillPrice,
        quantity: filledQuantity
      });
      const close = {
        instrument,
        lotId,
        ringTag: found?.ringTag ?? null,
        positionCode,
        virtualSide: allocation.virtualSide,
        filledQuantity,
        fillPrice: result.fillPrice,
        filledAt: result.filledAt,
        orderCode: result.orderCode,
        realizedPnlUsd: realized
      };
      if (found) state = await store.save(state.version, grid.reduceLotByPositionCode(state, positionCode, filledQuantity));
      // When this ticket also belongs to virtual state, reduce it before the
      // account-level plan is marked complete. Broker-only tickets are still
      // valid D-068 candidates and have no virtual inventory to mutate.
      await onConfirmedClose(close);
      closed.push(close);
    }
    currentState = state;
    return Object.freeze({ closed: Object.freeze(closed), pending: Object.freeze(pending) });
  }

  function exitsPaused() {
    return trancheExitsPaused === true || isTrancheExitsPaused(instrument);
  }

  async function processSnapshot(input) {
    const trade = canonicalTrade(input, marketSymbol);
    const maState = await maProvider.getCurrent();
    const rawMa = positive(`${instrument} MA`, maState?.ma);
    const anchor = rawMa * anchorState.multiplier;
    let state = await load();
    const observed = trackExcursion(anchorState, { price: trade.price, anchor, geometry: grid.definition, occurredAt: trade.tradeTime });
    const changedAnchor = JSON.stringify(observed.state) !== JSON.stringify(anchorState);
    anchorState = observed.state;
    if (changedAnchor) queueAnchorSave(anchorState);
    if (observed.startedSide !== null) {
      enqueueNotification({
        kind: "ANCHOR_EXCURSION_STARTED",
        eventKey: `ANCHOR-EXCURSION:${prefix}:${observed.startedSide}:${trade.tradeTime}`,
        instrument,
        side: observed.startedSide,
        price: trade.price,
        boundary: observed.startedSide === "UPPER" ? observed.boundaries.upper : observed.boundaries.lower,
        outerDistance: observed.boundaries.distance
      });
    }
    const rearmed = grid.observeRearm(state, { price: trade.price, ma: anchor });
    if (rearmed.version !== state.version) state = await store.save(state.version, rearmed);
    let exitFilledThisUpdate = false;
    while (!exitsPaused()) {
      const action = grid.nextMovingAverageExitAction?.(state, { price: trade.price, ma: anchor }) ?? grid.nextExitAction(state, { price: trade.price, ma: anchor });
      if (!action) break;
      if (action.type === "SKIP_EXIT") { state = await store.save(state.version, grid.applySkippedExit(state, action)); continue; }
      const lot = action.adopted === true
        ? state.adopted.find((candidate) => candidate.id === action.lotId)
        : state.rings.flatMap((ring) => ring.lots).find((candidate) => candidate.id === action.lotId);
      if (!lot || (action.forcedAtMovingAverage !== true && Date.parse(trade.tradeTime) - Date.parse(lot.openedAt) < minimumHoldSeconds * 1000)) break;
      if (execution.isEnabled?.() !== true) break;
      const lotBeforeExit = Object.freeze({ ...lot });
      const result = await execution.executeIntent(action);
      if (result.status !== "FILLED") return Object.freeze({ status: "EXIT_PENDING", state, action, result });
      state = await store.save(state.version, grid.applyConfirmedExit(state, action, result));
      exitFilledThisUpdate = true;
      const lotAfterExit = action.adopted === true
        ? state.adopted.find((candidate) => candidate.id === action.lotId)
        : state.rings.flatMap((ring) => ring.lots).find((candidate) => candidate.id === action.lotId);
      enqueueNotification({
        kind: "TRANCHE_EXIT_CONFIRMED",
        eventKey: `${prefix}-TRANCHE:${result.orderCode}`,
        instrument,
        ringTag: action.ringTag,
        virtualSide: action.virtualSide,
        lotId: action.lotId,
        tranche: action.tranche,
        fillPrice: result.fillPrice,
        filledQuantity: result.filledQuantity,
        remainingQuantity: lotAfterExit?.remainingUnits ?? 0,
        ma: anchor,
        rawMa,
        anchor,
        target: action.target,
        filledAt: result.filledAt
      });
      if (!lotAfterExit) {
        enqueueNotification({
          kind: "LOT_CLOSED",
          eventKey: `${prefix}-LOT-CLOSED:${result.orderCode}`,
          instrument,
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
    }
    // A confirmed exit consumes this update. A later fresh crossing is required
    // before the bot may add inventory again.
    if (!entryBrake && !anchorShiftHold && !exitFilledThisUpdate) {
      for (const candidate of grid.entryCandidates(state, { previousPrice, price: trade.price, ma: anchor })) {
        const ring = state.rings.find((item) => item.tag === candidate.ringTag);
        if (!ring || !ring.armed || ring.lots.length >= ring.capacity) continue;
        const proposed = candidate.quantity * trade.price;
        if (grid.grossVirtualExposureUsd(state, trade.price) + proposed > grossExposureCeilingUsd + 1e-8) continue;
        if (execution.isEnabled?.() !== true) continue;
        const intent = Object.freeze({ ...candidate, stateVersion: state.version, lotId: `${candidate.tag}-V${state.version}`, rawMa, anchor });
        const result = await execution.executeIntent(intent);
        if (result.status !== "FILLED") return Object.freeze({ status: "ENTRY_PENDING", state, intent, result });
        state = await store.save(state.version, grid.applyConfirmedEntry(state, intent, result));
        enqueueNotification({
          kind: "ENTRY_CONFIRMED",
          eventKey: `${prefix}-ENTRY:${result.orderCode}`,
          instrument,
          ringTag: intent.ringTag,
          side: intent.side,
          fillPrice: result.fillPrice,
          filledQuantity: result.filledQuantity,
          lotId: intent.lotId,
          ma: anchor,
          rawMa,
          anchor,
          filledAt: result.filledAt
        });
      }
    }
    previousPrice = trade.price;
    lastPrice = trade.price;
    currentState = state;
    await addEvent("INFO", "D060_RING_INSTANCE_PROCESSED", { instrument, stateVersion: state.version, entryBrake, anchorShiftHold, trancheExitsPaused: exitsPaused(), rawMa, anchor });
    return Object.freeze({ status: entryBrake ? "BRAKED" : anchorShiftHold ? "ANCHOR_HOLD" : "PROCESSED", state, ma: anchor, rawMa, anchor });
  }

  function hasVirtualLots() {
    return (currentState?.rings ?? []).some((ring) => Array.isArray(ring.lots) && ring.lots.length > 0) ||
      (currentState?.adopted ?? []).length > 0;
  }

  function hasPendingAnchorExcursion() {
    return anchorState.upperExtreme !== null || anchorState.lowerExtreme !== null;
  }

  async function applyAnchorShiftSnapshot({ shiftedAt = new Date().toISOString(), validateFlat = () => true } = {}) {
    if (hasVirtualLots()) return Object.freeze({ shifted: false, reason: "VIRTUAL_LOTS_PRESENT" });
    await flushAnchorWrites();
    const maState = await maProvider.getCurrent();
    const rawMa = positive(`${instrument} MA`, maState?.ma);
    const shift = computeShift(anchorState, { maNow: rawMa, geometry: grid.definition, shiftedAt });
    if (shift === null) return Object.freeze({ shifted: false, reason: "NO_EXCURSION" });
    if (hasVirtualLots() || validateFlat() !== true) throw new Error("anchor flat confirmation expired");
    // A shift is durable before this instance changes its live anchor. This is
    // intentionally awaited: losing it after a shift would duplicate a live move.
    if (anchorStore !== null) {
      await anchorStore.commitShift({ ...shift, newMultiplier: shift.multiplier, shiftedAt, validateFlat });
    }
    anchorState = shift.state;
    previousPrice = lastPrice;
    enqueueNotification({
      kind: "ANCHOR_SHIFT_CONFIRMED",
      eventKey: `ANCHOR-SHIFT:${prefix}:${shiftedAt}`,
      instrument,
      side: shift.side,
      extreme: shift.extreme,
      firstOuterLevel: grid.definition.innerLevels + 1,
      anchor: shift.anchor,
      rawMa,
      oldMultiplier: shift.oldMultiplier,
      multiplier: shift.multiplier,
      shiftedAt
    });
    // The transaction already committed. Diagnostic storage must not delay
    // completion or turn an audit failure into another anchor application.
    void Promise.resolve().then(() => addEvent("WARN", "ANCHOR_SHIFT_CONFIRMED", { instrument, ...shift, shiftedAt })).catch(() => undefined);
    return Object.freeze({ shifted: true, instrument, ...shift });
  }

  const process = (input) => serializeAnchor(() => processSnapshot(input));
  const applyAnchorShift = (input) => serializeAnchor(() => applyAnchorShiftSnapshot(input));

  return Object.freeze({
    instrument,
    init,
    process,
    setEntryBrake,
    setTrancheExitsPaused,
    setAnchorShiftHold,
    cut,
    flatten,
    cleanupDust,
    getRolloverHarvestCandidates,
    executeRolloverHarvest,
    getEntryBrake: () => entryBrake,
    getTrancheExitsPaused: () => exitsPaused(),
    getAnchorShiftHold: () => anchorShiftHold,
    hasVirtualLots,
    hasPendingAnchorExcursion,
    applyAnchorShift,
    getAnchorState: () => anchorState,
    getLastPrice: () => lastPrice,
    getState: () => currentState
  });
}
