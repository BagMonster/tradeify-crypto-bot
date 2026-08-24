import { evaluateGridRisk } from "../risk/accountRules.js";
import {
  GRID_DEFINITION,
  applyConfirmedEntry,
  applyConfirmedExit,
  applySkippedExit,
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

export function createSolanaRuntime({
  stateStore,
  maProvider,
  getRiskSnapshot,
  execution,
  minimumHoldSeconds = 25,
  addEvent = async () => {},
  notifications = null
}) {
  for (const method of ["init","load","initializeIfMissing","save"]) {
    if (typeof stateStore?.[method] !== "function") throw new TypeError(`stateStore.${method} is required`);
  }
  if (typeof maProvider?.getCurrent !== "function") throw new TypeError("maProvider.getCurrent is required");
  if (typeof getRiskSnapshot !== "function") throw new TypeError("getRiskSnapshot is required");
  if (typeof execution?.isEnabled !== "function" || typeof execution?.executeIntent !== "function" || typeof execution?.executeProtectiveFlatten !== "function") {
    throw new TypeError("SOL execution interface is invalid");
  }
  if (!Number.isInteger(minimumHoldSeconds) || minimumHoldSeconds < 25 || minimumHoldSeconds > 300) throw new TypeError("minimumHoldSeconds is invalid");
  if (typeof addEvent !== "function") throw new TypeError("addEvent must be a function");
  if (notifications !== null && typeof notifications?.enqueue !== "function") throw new TypeError("notifications.enqueue must be a function");

  let previousPrice = null;
  let lastShadowKey = null;

  function enqueueNotification(event) {
    if (notifications !== null) notifications.enqueue(event);
  }

  async function init() {
    await stateStore.init();
    let state = await stateStore.load();
    if (!state) state = await stateStore.initializeIfMissing(createInitialSolanaState());
    return state;
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

  async function persistIfChanged(before, after) {
    if (after.version === before.version) return before;
    return stateStore.save(before.version, after);
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
      return Object.freeze({ status: "PROTECTIVE_PENDING", state, ma });
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
        return Object.freeze({ status: "EXIT_PENDING", state, ma, action, result });
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
        return Object.freeze({ status: "ENTRY_PENDING", state, ma, intent, result });
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

    previousPrice = trade.price;
    return Object.freeze({ status: execution.isEnabled() ? "PROCESSED" : "SHADOW", state, ma, maCompletedThrough: maState.completedThrough });
  }

  return Object.freeze({ init, processTrade, definition: GRID_DEFINITION });
}
