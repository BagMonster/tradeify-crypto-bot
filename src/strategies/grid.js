export const GRID_STRATEGY_ID = "btc-progressive-reference-reset-grid-v1";
export const GRID_SOURCE_SYMBOL = Object.freeze({ source: "binance", symbol: "BTCUSDT" });

export const FROZEN_GRID = Object.freeze({
  buyLevels: Object.freeze([
    Object.freeze({ movePct: 0.04, usd: 250 }),
    Object.freeze({ movePct: 0.09, usd: 550 }),
    Object.freeze({ movePct: 0.10, usd: 1250 })
  ]),
  sellLevels: Object.freeze([
    Object.freeze({ movePct: 0.0375, usd: 250 }),
    Object.freeze({ movePct: 0.075, usd: 550 }),
    Object.freeze({ movePct: 0.10, usd: 1250 })
  ]),
  maxConsecutive: 3
});

function requirePositiveFinite(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return value;
}

function requireCounter(name, value) {
  if (!Number.isInteger(value) || value < 0 || value > FROZEN_GRID.maxConsecutive) {
    throw new TypeError(`${name} must be an integer from 0 to ${FROZEN_GRID.maxConsecutive}`);
  }
  return value;
}

function requireVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("grid state version must be a non-negative safe integer");
  }
  return value;
}

function canonicalTime(name, value) {
  if (typeof value !== "string") throw new TypeError(`${name} must be an ISO timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new TypeError(`${name} must be a canonical UTC timestamp`);
  }
  return value;
}

function triggerTolerance(referencePrice) {
  return Math.max(1, Math.abs(referencePrice)) * 1e-12;
}

export function normalizeGridState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("grid state must be an object");
  }

  const state = {
    version: requireVersion(input.version),
    referencePrice: requirePositiveFinite("grid referencePrice", input.referencePrice),
    buyCount: requireCounter("grid buyCount", input.buyCount),
    buyPtr: requireCounter("grid buyPtr", input.buyPtr),
    sellCount: requireCounter("grid sellCount", input.sellCount),
    sellPtr: requireCounter("grid sellPtr", input.sellPtr),
    lastFillAt: input.lastFillAt ?? null,
    lastFillSide: input.lastFillSide ?? null,
    lastFillPrice: input.lastFillPrice ?? null
  };

  if (state.buyCount !== state.buyPtr || state.sellCount !== state.sellPtr) {
    throw new TypeError("grid counters and level pointers must stay aligned");
  }

  const hasLastFill = state.lastFillAt !== null || state.lastFillSide !== null || state.lastFillPrice !== null;
  if (hasLastFill) {
    state.lastFillAt = canonicalTime("grid lastFillAt", state.lastFillAt);
    if (state.lastFillSide !== "BUY" && state.lastFillSide !== "SELL" && state.lastFillSide !== "PROTECTIVE_FLAT") {
      throw new TypeError("grid lastFillSide is invalid");
    }
    state.lastFillPrice = requirePositiveFinite("grid lastFillPrice", state.lastFillPrice);
  }

  return Object.freeze(state);
}

export function createInitialGridState(referencePrice) {
  return normalizeGridState({
    version: 0,
    referencePrice,
    buyCount: 0,
    buyPtr: 0,
    sellCount: 0,
    sellPtr: 0,
    lastFillAt: null,
    lastFillSide: null,
    lastFillPrice: null
  });
}

export function evaluateGridIntent(inputState, observedPrice) {
  const state = normalizeGridState(inputState);
  const price = requirePositiveFinite("observedPrice", observedPrice);
  const tolerance = triggerTolerance(state.referencePrice);

  if (price < state.referencePrice && state.buyCount < FROZEN_GRID.maxConsecutive) {
    const level = FROZEN_GRID.buyLevels[state.buyPtr];
    if (level) {
      const triggerPrice = state.referencePrice * (1 - level.movePct);
      if (price <= triggerPrice + tolerance) {
        return Object.freeze({
          strategyId: GRID_STRATEGY_ID,
          source: GRID_SOURCE_SYMBOL.source,
          symbol: GRID_SOURCE_SYMBOL.symbol,
          side: "BUY",
          tag: `BUY${state.buyPtr + 1}`,
          levelIndex: state.buyPtr,
          movePct: level.movePct,
          usd: level.usd,
          observedPrice: price,
          referencePrice: state.referencePrice,
          stateVersion: state.version
        });
      }
    }
  }

  if (price > state.referencePrice && state.sellCount < FROZEN_GRID.maxConsecutive) {
    const level = FROZEN_GRID.sellLevels[state.sellPtr];
    if (level) {
      const triggerPrice = state.referencePrice * (1 + level.movePct);
      if (price >= triggerPrice - tolerance) {
        return Object.freeze({
          strategyId: GRID_STRATEGY_ID,
          source: GRID_SOURCE_SYMBOL.source,
          symbol: GRID_SOURCE_SYMBOL.symbol,
          side: "SELL",
          tag: `SELL${state.sellPtr + 1}`,
          levelIndex: state.sellPtr,
          movePct: level.movePct,
          usd: level.usd,
          observedPrice: price,
          referencePrice: state.referencePrice,
          stateVersion: state.version
        });
      }
    }
  }

  return null;
}

function validateIntentAgainstState(state, intent) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) {
    throw new TypeError("grid intent must be an object");
  }
  if (intent.strategyId !== GRID_STRATEGY_ID || intent.source !== GRID_SOURCE_SYMBOL.source ||
      intent.symbol !== GRID_SOURCE_SYMBOL.symbol) {
    throw new TypeError("grid intent identity does not match the frozen BTC grid");
  }
  if (intent.stateVersion !== state.version || intent.referencePrice !== state.referencePrice) {
    throw new Error("grid intent is stale and cannot advance state");
  }
  if (intent.side === "BUY") {
    if (intent.levelIndex !== state.buyPtr || intent.tag !== `BUY${state.buyPtr + 1}`) {
      throw new Error("grid BUY intent no longer matches the current level");
    }
  } else if (intent.side === "SELL") {
    if (intent.levelIndex !== state.sellPtr || intent.tag !== `SELL${state.sellPtr + 1}`) {
      throw new Error("grid SELL intent no longer matches the current level");
    }
  } else {
    throw new TypeError("grid intent side must be BUY or SELL");
  }
}

export function applyConfirmedGridFill(inputState, intent, { fillPrice, filledAt }) {
  const state = normalizeGridState(inputState);
  validateIntentAgainstState(state, intent);
  const price = requirePositiveFinite("fillPrice", fillPrice);
  const time = canonicalTime("filledAt", filledAt);

  if (intent.side === "BUY") {
    return normalizeGridState({
      ...state,
      version: state.version + 1,
      referencePrice: price,
      buyCount: state.buyCount + 1,
      buyPtr: state.buyPtr + 1,
      sellCount: 0,
      sellPtr: 0,
      lastFillAt: time,
      lastFillSide: "BUY",
      lastFillPrice: price
    });
  }

  return normalizeGridState({
    ...state,
    version: state.version + 1,
    referencePrice: price,
    sellCount: state.sellCount + 1,
    sellPtr: state.sellPtr + 1,
    buyCount: 0,
    buyPtr: 0,
    lastFillAt: time,
    lastFillSide: "SELL",
    lastFillPrice: price
  });
}

export function resetGridAfterProtectiveFlatten(inputState, { fillPrice, filledAt }) {
  const state = normalizeGridState(inputState);
  const price = requirePositiveFinite("fillPrice", fillPrice);
  const time = canonicalTime("filledAt", filledAt);
  return normalizeGridState({
    version: state.version + 1,
    referencePrice: price,
    buyCount: 0,
    buyPtr: 0,
    sellCount: 0,
    sellPtr: 0,
    lastFillAt: time,
    lastFillSide: "PROTECTIVE_FLAT",
    lastFillPrice: price
  });
}
