import {
  applyConfirmedGridFill,
  createInitialGridState,
  evaluateGridIntent,
  resetGridAfterProtectiveFlatten
} from "../strategies/grid.js";
import { evaluateGridRisk } from "../risk/accountRules.js";

function requireFunction(name, value) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  return value;
}

function requireMinimumHoldSeconds(value) {
  if (!Number.isInteger(value) || value < 25 || value > 300) {
    throw new TypeError("minimumHoldSeconds must be an integer from 25 to 300");
  }
  return value;
}

function canonicalUtc(name, value) {
  if (typeof value !== "string") throw new TypeError(`${name} must be a canonical UTC timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new TypeError(`${name} must be a canonical UTC timestamp`);
  }
  return value;
}

function normalizeTrade(trade) {
  if (!trade || typeof trade !== "object" || Array.isArray(trade)) {
    throw new TypeError("market trade must be an object");
  }
  if (trade.source !== "binance" || trade.symbol !== "BTCUSDT") {
    throw new TypeError("grid runtime accepts only Binance BTCUSDT trades");
  }
  if (typeof trade.price !== "number" || !Number.isFinite(trade.price) || trade.price <= 0) {
    throw new TypeError("market trade price must be a positive finite number");
  }
  return Object.freeze({
    source: trade.source,
    symbol: trade.symbol,
    price: trade.price,
    tradeTime: canonicalUtc("market trade time", trade.tradeTime)
  });
}

function requireStore(store) {
  for (const method of ["init", "load", "initializeIfMissing", "save"]) {
    if (typeof store?.[method] !== "function") throw new TypeError(`stateStore.${method} must be a function`);
  }
  return store;
}

function requireExecution(execution) {
  if (typeof execution?.executeGridIntent !== "function" ||
      typeof execution?.executeProtectiveFlatten !== "function") {
    throw new TypeError("execution must provide executeGridIntent and executeProtectiveFlatten");
  }
  return execution;
}

function entryHoldStatus(state, tradeTime, minimumHoldSeconds) {
  if ((state.lastFillSide !== "BUY" && state.lastFillSide !== "SELL") || !state.lastFillAt) {
    return Object.freeze({ allowed: true, remainingMs: 0 });
  }
  const elapsedMs = Date.parse(tradeTime) - Date.parse(state.lastFillAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return Object.freeze({ allowed: false, remainingMs: minimumHoldSeconds * 1000 });
  }
  const requiredMs = minimumHoldSeconds * 1000;
  return Object.freeze({ allowed: elapsedMs >= requiredMs, remainingMs: Math.max(0, requiredMs - elapsedMs) });
}

export function createGridRuntime({
  stateStore,
  getRiskSnapshot,
  execution,
  minimumHoldSeconds = 25,
  addEvent = async () => {}
}) {
  const store = requireStore(stateStore);
  const riskSnapshot = requireFunction("getRiskSnapshot", getRiskSnapshot);
  const executor = requireExecution(execution);
  const holdSeconds = requireMinimumHoldSeconds(minimumHoldSeconds);
  const audit = requireFunction("addEvent", addEvent);
  let lastRepeatedAuditKey = null;

  async function auditRepeatedOnce(key, level, kind, payload) {
    if (lastRepeatedAuditKey === key) return;
    lastRepeatedAuditKey = key;
    await audit(level, kind, payload);
  }

  async function initialize(referencePrice) {
    if (typeof referencePrice !== "number" || !Number.isFinite(referencePrice) || referencePrice <= 0) {
      throw new TypeError("initial grid reference price must be a positive finite number");
    }
    await store.init();
    const existing = await store.load();
    if (existing) return existing;
    const created = createInitialGridState(referencePrice);
    const stored = await store.initializeIfMissing(created);
    await audit("INFO", "GRID_STATE_INITIALIZED", {
      referencePrice: stored.referencePrice,
      version: stored.version
    });
    return stored;
  }

  async function processTrade(inputTrade) {
    const trade = normalizeTrade(inputTrade);
    const state = await store.load();
    if (!state) throw new Error("grid state is not initialized");

    const intent = evaluateGridIntent(state, trade.price);
    const snapshot = await riskSnapshot(Object.freeze({ state, trade, intent }));
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new Error("risk snapshot provider returned an invalid snapshot");
    }

    const risk = evaluateGridRisk({
      ...snapshot,
      proposedAdditionalNotional: intent?.usd ?? 0
    });

    if (risk.protectiveAction === "FLATTEN_AND_LOCK") {
      const result = await executor.executeProtectiveFlatten({ reason: risk.reason });
      if (result.status !== "FILLED") {
        await auditRepeatedOnce(
          `protective:${state.version}:${risk.reason}:${result.status}`,
          "ERROR",
          "GRID_PROTECTIVE_ACTION_UNCONFIRMED",
          { reason: risk.reason, result: result.status }
        );
        return Object.freeze({ status: "PROTECTIVE_PENDING", risk, state, intent: null });
      }

      lastRepeatedAuditKey = null;
      const nextState = resetGridAfterProtectiveFlatten(state, {
        fillPrice: result.fillPrice,
        filledAt: result.filledAt
      });
      const saved = await store.save(state.version, nextState);
      await audit("WARN", "GRID_PROTECTIVE_ACTION_APPLIED", {
        reason: risk.reason,
        fillPrice: result.fillPrice,
        stateVersion: saved.version
      });
      return Object.freeze({ status: "PROTECTIVE_FILLED", risk, state: saved, intent: null });
    }

    if (!intent) {
      lastRepeatedAuditKey = null;
      return Object.freeze({ status: "NO_INTENT", risk, state, intent: null });
    }

    if (!risk.allowNewGridAction) {
      await auditRepeatedOnce(
        `blocked:${state.version}:${intent.tag}:${risk.reason}`,
        "INFO",
        "GRID_INTENT_BLOCKED",
        { tag: intent.tag, side: intent.side, reason: risk.reason, stateVersion: state.version }
      );
      return Object.freeze({ status: "BLOCKED", risk, state, intent });
    }

    const hold = entryHoldStatus(state, trade.tradeTime, holdSeconds);
    if (!hold.allowed) {
      const reason = `Minimum ${holdSeconds}-second grid-entry hold is still active`;
      await auditRepeatedOnce(
        `hold:${state.version}:${intent.tag}`,
        "INFO",
        "GRID_INTENT_BLOCKED_MIN_HOLD",
        { tag: intent.tag, side: intent.side, stateVersion: state.version, remainingMs: hold.remainingMs }
      );
      return Object.freeze({ status: "BLOCKED", risk, state, intent, reason });
    }

    if (typeof executor.isEnabled === "function" && !executor.isEnabled()) {
      await auditRepeatedOnce(
        `shadow:${state.version}:${intent.tag}`,
        "INFO",
        "GRID_SHADOW_INTENT",
        {
          tag: intent.tag,
          side: intent.side,
          cashQuantity: intent.usd,
          observedPrice: intent.observedPrice,
          referencePrice: intent.referencePrice,
          stateVersion: state.version
        }
      );
      return Object.freeze({ status: "SHADOW_INTENT", risk, state, intent });
    }

    lastRepeatedAuditKey = null;
    const result = await executor.executeGridIntent({ intent });
    if (result.status !== "FILLED") {
      await audit("WARN", "GRID_INTENT_NOT_FILLED", {
        tag: intent.tag,
        side: intent.side,
        result: result.status,
        stateVersion: state.version
      });
      return Object.freeze({ status: result.status, risk, state, intent });
    }

    const nextState = applyConfirmedGridFill(state, intent, {
      fillPrice: result.fillPrice,
      filledAt: result.filledAt
    });
    const saved = await store.save(state.version, nextState);
    await audit("INFO", "GRID_FILL_APPLIED", {
      tag: intent.tag,
      side: intent.side,
      orderCode: result.orderCode ?? null,
      fillPrice: result.fillPrice,
      stateVersion: saved.version
    });
    return Object.freeze({ status: "FILLED", risk, state: saved, intent, execution: result });
  }

  return Object.freeze({ initialize, processTrade });
}
