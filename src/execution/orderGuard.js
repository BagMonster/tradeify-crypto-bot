const DEFAULT_EXECUTION_INSTRUMENT = "BTC/USD";
const DEFAULT_MARKET_SYMBOL = "BTCUSDT";
const DEFAULT_ORDER_CODE_PREFIX = "GRID";

function requireBoolean(name, value) {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
  return value;
}

function requireFunction(name, value) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  return value;
}

function requireText(name, value, pattern = null) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  const text = value.trim();
  if (pattern && !pattern.test(text)) throw new TypeError(`${name} is invalid`);
  return text;
}

function requirePositiveFinite(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
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

function normalizeIntent(intent, marketSymbol) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) {
    throw new TypeError("grid intent must be an object");
  }
  if (intent.source !== "binance" || intent.symbol !== marketSymbol) {
    throw new TypeError(`execution accepts only Binance ${marketSymbol} grid intents`);
  }
  if (intent.side !== "BUY" && intent.side !== "SELL") {
    throw new TypeError("grid intent side must be BUY or SELL");
  }
  if (!Number.isSafeInteger(intent.stateVersion) || intent.stateVersion < 0) {
    throw new TypeError("grid intent stateVersion must be a non-negative safe integer");
  }
  if (!/^BUY[1-9][0-9]*$|^SELL[1-9][0-9]*$/.test(intent.tag ?? "")) {
    throw new TypeError("grid intent tag must identify a grid level");
  }
  requirePositiveFinite("grid intent usd", intent.usd);
  requirePositiveFinite("grid intent observedPrice", intent.observedPrice);
  return intent;
}

export function gridOrderCode(intent, {
  marketSymbol = DEFAULT_MARKET_SYMBOL,
  orderCodePrefix = DEFAULT_ORDER_CODE_PREFIX
} = {}) {
  const symbol = requireText("marketSymbol", marketSymbol, /^[A-Z0-9]{5,20}$/);
  const prefix = requireText("orderCodePrefix", orderCodePrefix, /^[A-Z0-9_-]{1,16}$/);
  const normalized = normalizeIntent(intent, symbol);
  return `${prefix}-${normalized.stateVersion}-${normalized.tag}`;
}

function normalizeConfirmedFill(fill, expectedOrderCode) {
  if (!fill || typeof fill !== "object" || Array.isArray(fill)) {
    throw new Error("execution adapter returned an invalid fill result");
  }
  if (fill.confirmed !== true) return null;
  if (fill.orderCode !== expectedOrderCode) {
    throw new Error("confirmed fill orderCode does not match the submitted order");
  }
  return Object.freeze({
    confirmed: true,
    orderCode: expectedOrderCode,
    fillPrice: requirePositiveFinite("confirmed fill price", fill.fillPrice),
    filledAt: canonicalUtc("confirmed fill time", fill.filledAt),
    brokerOrderId: fill.brokerOrderId == null ? null : String(fill.brokerOrderId)
  });
}

export function createGuardedExecution({
  autoExecute,
  strategyAutoExecute,
  instrument = DEFAULT_EXECUTION_INSTRUMENT,
  marketSymbol = DEFAULT_MARKET_SYMBOL,
  orderCodePrefix = DEFAULT_ORDER_CODE_PREFIX,
  placeMarketOrder,
  flattenPosition,
  addEvent = async () => {}
}) {
  const envLock = requireBoolean("autoExecute", autoExecute);
  const strategyLock = requireBoolean("strategyAutoExecute", strategyAutoExecute);
  const executionInstrument = requireText("instrument", instrument, /^[A-Z0-9]+\/[A-Z0-9]+$/);
  const executionMarketSymbol = requireText("marketSymbol", marketSymbol, /^[A-Z0-9]{5,20}$/);
  const executionOrderPrefix = requireText("orderCodePrefix", orderCodePrefix, /^[A-Z0-9_-]{1,16}$/);
  const place = requireFunction("placeMarketOrder", placeMarketOrder);
  const flatten = requireFunction("flattenPosition", flattenPosition);
  const audit = requireFunction("addEvent", addEvent);
  const inFlight = new Set();

  function isEnabled() {
    return envLock && strategyLock;
  }

  async function executeGridIntent({ intent }) {
    const normalized = normalizeIntent(intent, executionMarketSymbol);
    const orderCode = gridOrderCode(normalized, {
      marketSymbol: executionMarketSymbol,
      orderCodePrefix: executionOrderPrefix
    });

    if (!isEnabled()) {
      await audit("INFO", "GRID_ORDER_BLOCKED_EXECUTION_LOCK", {
        orderCode,
        tag: normalized.tag,
        side: normalized.side,
        stateVersion: normalized.stateVersion
      });
      return Object.freeze({ status: "BLOCKED", orderCode, reason: "Automatic execution locks are off" });
    }

    if (inFlight.has(orderCode)) {
      await audit("WARN", "GRID_ORDER_DUPLICATE_IN_FLIGHT", { orderCode });
      return Object.freeze({ status: "DUPLICATE_BLOCKED", orderCode, reason: "Order is already in flight" });
    }

    inFlight.add(orderCode);
    try {
      await audit("INFO", "GRID_ORDER_SUBMITTING", {
        orderCode,
        instrument: executionInstrument,
        side: normalized.side,
        cashQuantity: normalized.usd,
        tag: normalized.tag,
        stateVersion: normalized.stateVersion
      });

      const result = await place(Object.freeze({
        orderCode,
        instrument: executionInstrument,
        type: "MARKET",
        side: normalized.side,
        cashQuantity: normalized.usd,
        intent: normalized
      }));
      const confirmed = normalizeConfirmedFill(result, orderCode);

      if (!confirmed) {
        await audit("WARN", "GRID_ORDER_NOT_CONFIRMED", { orderCode, brokerStatus: result?.status ?? null });
        return Object.freeze({
          status: result?.status === "PARTIAL" ? "PARTIAL" : "NOT_CONFIRMED",
          orderCode,
          reason: result?.reason ?? "Broker fill was not confirmed"
        });
      }

      await audit("INFO", "GRID_ORDER_FILL_CONFIRMED", {
        orderCode,
        fillPrice: confirmed.fillPrice,
        filledAt: confirmed.filledAt,
        brokerOrderId: confirmed.brokerOrderId
      });
      return Object.freeze({ status: "FILLED", ...confirmed });
    } finally {
      inFlight.delete(orderCode);
    }
  }

  async function executeProtectiveFlatten({ reason }) {
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new TypeError("protective flatten reason must be a non-empty string");
    }
    if (!isEnabled()) {
      await audit("WARN", "PROTECTIVE_FLATTEN_BLOCKED_EXECUTION_LOCK", { reason: reason.trim() });
      return Object.freeze({ status: "BLOCKED", reason: "Automatic execution locks are off" });
    }

    const result = await flatten(Object.freeze({ instrument: executionInstrument, reason: reason.trim() }));
    if (!result || result.confirmed !== true) {
      await audit("ERROR", "PROTECTIVE_FLATTEN_NOT_CONFIRMED", { reason: reason.trim() });
      return Object.freeze({ status: "NOT_CONFIRMED", reason: "Protective flatten was not confirmed" });
    }

    const fillPrice = requirePositiveFinite("protective flatten fill price", result.fillPrice);
    const filledAt = canonicalUtc("protective flatten fill time", result.filledAt);
    await audit("WARN", "PROTECTIVE_FLATTEN_CONFIRMED", { reason: reason.trim(), fillPrice, filledAt });
    return Object.freeze({ status: "FILLED", fillPrice, filledAt });
  }

  return Object.freeze({ isEnabled, executeGridIntent, executeProtectiveFlatten });
}
