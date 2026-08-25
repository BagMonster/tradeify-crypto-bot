function text(name, value, max = 128) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be non-empty`);
  const out = value.trim();
  if (out.length > max) throw new TypeError(`${name} is too long`);
  return out;
}

function positive(name, value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`${name} must be positive`);
  return n;
}

function orderCode(intent) {
  const suffix = intent.type === "ENTRY" ? "E" : `X${intent.tranche}`;
  return `SOLGRID-${intent.stateVersion}-${intent.tag}-${suffix}`;
}

function positionRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && Array.isArray(payload.positions)) return payload.positions;
  throw new Error("DXtrade open-positions response does not contain a positions array");
}

function positionSymbol(position) {
  return String(position?.symbol ?? position?.instrument ?? "").trim();
}

function positionQuantity(position) {
  const n = Number(position?.quantity ?? position?.qty);
  if (!Number.isFinite(n)) throw new Error("DXtrade SOL position quantity is invalid");
  return n;
}

function positionSide(position, quantity) {
  const raw = String(position?.side ?? position?.direction ?? "").toUpperCase();
  if (["SELL", "SHORT"].includes(raw)) return "SHORT";
  if (["BUY", "LONG"].includes(raw)) return "LONG";
  return quantity < 0 ? "SHORT" : "LONG";
}

function positionCode(position) {
  const code = position?.positionCode ?? position?.code ?? position?.id;
  return text("DXtrade position code", code == null ? "" : String(code), 128);
}

function compactDayKey(dayKey) {
  const key = text("dayKey", dayKey, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new TypeError("dayKey is invalid");
  return key.replaceAll("-", "");
}

function sameProtectiveOrder(row, { stateVersion, actionType, side, quantity }) {
  return row &&
    row.strategyId === "sol-outer-heavy-v1" &&
    row.instrument === "SOL/USD" &&
    row.stateVersion === stateVersion &&
    row.actionType === actionType &&
    row.side === side &&
    Math.abs(row.requestedQuantity - quantity) <= 1e-10;
}

export function createSolanaExecutionGuard({
  autoExecute,
  strategyAutoExecute,
  adapter,
  client,
  persistence,
  protectiveOrdersBypassSlippageCap = true,
  addEvent = async () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  confirmationTimeoutMs = 12_000,
  pollIntervalMs = 750
}) {
  if (typeof autoExecute !== "boolean" || typeof strategyAutoExecute !== "boolean") throw new TypeError("execution locks must be boolean");
  if (typeof adapter?.place !== "function") throw new TypeError("SOL quantity adapter is invalid");
  if (typeof client?.getOpenPositions !== "function" || typeof client?.placePositionClose !== "function" || typeof client?.reconcileQuantityOrder !== "function") {
    throw new TypeError("SOL quantity client lacks protective-close methods");
  }
  if (typeof persistence?.claimOrder !== "function") throw new TypeError("SOL persistence is invalid");
  if (typeof protectiveOrdersBypassSlippageCap !== "boolean") throw new TypeError("protectiveOrdersBypassSlippageCap must be boolean");
  if (typeof addEvent !== "function") throw new TypeError("addEvent must be a function");
  if (typeof sleep !== "function") throw new TypeError("sleep must be a function");
  if (!Number.isFinite(confirmationTimeoutMs) || confirmationTimeoutMs < 0) throw new TypeError("confirmationTimeoutMs is invalid");
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) throw new TypeError("pollIntervalMs is invalid");

  const inFlight = new Set();

  function isEnabled() {
    return autoExecute && strategyAutoExecute;
  }

  async function executeIntent(intent) {
    if (!intent || (intent.type !== "ENTRY" && intent.type !== "EXIT")) throw new TypeError("SOL intent must be ENTRY or EXIT");
    const code = orderCode(intent);
    if (!isEnabled()) return Object.freeze({ status: "BLOCKED", orderCode: code, reason: "Automatic execution locks are off" });
    if (inFlight.has(code)) return Object.freeze({ status: "DUPLICATE_BLOCKED", orderCode: code });
    inFlight.add(code);
    try {
      await addEvent("INFO", "SOL_ORDER_SUBMITTING", {
        orderCode: code,
        actionType: intent.type,
        tag: intent.tag,
        tranche: intent.tranche ?? null,
        side: intent.side,
        quantity: intent.quantity,
        stateVersion: intent.stateVersion
      });
      const result = await adapter.place({
        orderCode: code,
        strategyId: intent.strategyId,
        instrument: "SOL/USD",
        stateVersion: intent.stateVersion,
        actionType: intent.type,
        ringTag: intent.ringTag,
        lotId: intent.lotId ?? null,
        tranche: intent.tranche ?? null,
        side: intent.side,
        quantity: intent.quantity
      });
      if (result.confirmed !== true || result.status !== "FILLED") {
        await addEvent("WARN", "SOL_ORDER_NOT_CONFIRMED", { orderCode: code, status: result.status ?? "UNKNOWN" });
        return Object.freeze({ status: result.status ?? "NOT_CONFIRMED", orderCode: code });
      }
      await addEvent("INFO", "SOL_ORDER_FILL_CONFIRMED", {
        orderCode: code,
        fillPrice: result.fillPrice,
        filledQuantity: result.filledQuantity,
        filledAt: result.filledAt
      });
      return Object.freeze({ status: "FILLED", orderCode: code, ...result });
    } finally {
      inFlight.delete(code);
    }
  }

  async function resolveSingleSolPosition() {
    const payload = await client.getOpenPositions();
    const rows = positionRows(payload).filter((row) => positionSymbol(row) === "SOL/USD" && Math.abs(positionQuantity(row)) > 1e-12);
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new Error("Protective close requires exactly one net SOL/USD broker position");
    const position = rows[0];
    const signedQty = positionQuantity(position);
    const direction = positionSide(position, signedQty);
    return Object.freeze({
      position,
      signedQty,
      quantity: positive("protective broker quantity", Math.abs(signedQty)),
      closeSide: direction === "SHORT" ? "BUY" : "SELL",
      positionCode: positionCode(position)
    });
  }

  async function reconcileProtectiveClose({ code, quantity, reason, actionType }) {
    const deadline = Date.now() + confirmationTimeoutMs;
    while (true) {
      const result = await client.reconcileQuantityOrder({ orderCode: code, requestedQuantity: quantity });
      if (result.status === "FILLED") {
        await persistence.markStatus(code, "FILLED", {
          fillPrice: result.fillPrice,
          filledQuantity: result.filledQuantity,
          filledAt: result.filledAt
        });
        await addEvent("WARN", actionType === "PROTECTIVE_CUT" ? "SOL_D049_PARTIAL_CUT_CONFIRMED" : "SOL_PROTECTIVE_FLATTEN_CONFIRMED", {
          reason,
          quantity,
          fillPrice: result.fillPrice,
          slippagePolicy: protectiveOrdersBypassSlippageCap ? "BYPASS" : "NOT_CONFIGURED"
        });
        return Object.freeze({ status: "FILLED", orderCode: code, ...result });
      }
      if (["REJECTED", "CANCELED", "EXPIRED", "PARTIAL", "FAILED"].includes(result.status)) {
        await persistence.markStatus(code, result.status, { lastError: `Protective ${actionType} ended ${result.status}` });
        return Object.freeze({ status: result.status, orderCode: code });
      }
      if (Date.now() >= deadline) {
        await persistence.markStatus(code, "PENDING", { lastError: `Protective ${actionType} confirmation timed out` });
        return Object.freeze({ status: "PENDING", orderCode: code });
      }
      await sleep(pollIntervalMs);
    }
  }

  async function executeProtectiveCut({ stateVersion, dayKey, quantity, side, reason, bypassSlippageCap = true }) {
    text("reason", reason, 300);
    if (!Number.isSafeInteger(stateVersion) || stateVersion < 0) throw new TypeError("stateVersion is invalid");
    const qty = positive("protective cut quantity", quantity);
    const requestedSide = text("protective cut side", side, 4).toUpperCase();
    if (requestedSide !== "BUY" && requestedSide !== "SELL") throw new TypeError("protective cut side must be BUY or SELL");
    if (bypassSlippageCap !== true || protectiveOrdersBypassSlippageCap !== true) {
      throw new Error("D-049 protective cut requires the approved slippage-cap bypass");
    }
    if (!isEnabled()) return Object.freeze({ status: "BLOCKED", reason: "Automatic execution locks are off" });

    const broker = await resolveSingleSolPosition();
    if (!broker) return Object.freeze({ status: "ALREADY_FLAT" });
    if (broker.closeSide !== requestedSide) throw new Error("Protective cut side does not match the broker net position");
    if (qty > broker.quantity + 0.0050001) throw new Error("Protective cut quantity exceeds the broker net SOL position");

    const code = `SOLCUT-${compactDayKey(dayKey)}-${stateVersion}`;
    let row = await persistence.getOrder(code);
    if (!row) row = await persistence.claimOrder({
      orderCode: code,
      strategyId: "sol-outer-heavy-v1",
      instrument: "SOL/USD",
      stateVersion,
      actionType: "PROTECTIVE_CUT",
      side: requestedSide,
      requestedQuantity: qty
    });
    if (!sameProtectiveOrder(row, { stateVersion, actionType: "PROTECTIVE_CUT", side: requestedSide, quantity: qty })) {
      throw new Error("Persistent D-049 protective-cut order does not match the current request");
    }
    if (row.status === "FILLED") return Object.freeze({
      status: "FILLED",
      orderCode: row.orderCode,
      fillPrice: row.fillPrice,
      filledQuantity: row.filledQuantity,
      filledAt: row.filledAt
    });
    if (["REJECTED", "CANCELED", "EXPIRED", "PARTIAL", "FAILED"].includes(row.status)) {
      return Object.freeze({ status: row.status, orderCode: code });
    }

    if (row.status === "CLAIMED") {
      await addEvent("WARN", "SOL_D049_PARTIAL_CUT_SUBMITTING", {
        orderCode: code,
        reason,
        quantity: qty,
        side: requestedSide,
        slippagePolicy: "BYPASS"
      });
      try {
        const response = await client.placePositionClose({
          orderCode: code,
          orderSide: requestedSide,
          quantity: qty,
          positionCode: broker.positionCode
        });
        await persistence.markSubmitted(code, response?.orderId ?? null);
      } catch {
        await persistence.markStatus(code, "PENDING", { lastError: "D-049 protective cut submission outcome is uncertain" });
      }
    }

    return reconcileProtectiveClose({ code, quantity: qty, reason, actionType: "PROTECTIVE_CUT" });
  }

  async function executeProtectiveFlatten({ stateVersion, reason, dayKey = null, bypassSlippageCap = null }) {
    text("reason", reason, 300);
    if (!Number.isSafeInteger(stateVersion) || stateVersion < 0) throw new TypeError("stateVersion is invalid");
    const d049 = dayKey !== null;
    if (d049 && (bypassSlippageCap !== true || protectiveOrdersBypassSlippageCap !== true)) {
      throw new Error("D-049 protective flatten requires the approved slippage-cap bypass");
    }
    if (!isEnabled()) return Object.freeze({ status: "BLOCKED", reason: "Automatic execution locks are off" });

    const broker = await resolveSingleSolPosition();
    if (!broker) return Object.freeze({ status: "ALREADY_FLAT" });
    const qty = broker.quantity;
    const closeSide = broker.closeSide;
    const code = d049 ? `SOLFLAT-${compactDayKey(dayKey)}-${stateVersion}` : `SOLFLAT-${stateVersion}`;

    let row = await persistence.getOrder(code);
    if (!row) row = await persistence.claimOrder({
      orderCode: code,
      strategyId: "sol-outer-heavy-v1",
      instrument: "SOL/USD",
      stateVersion,
      actionType: "PROTECTIVE_FLAT",
      side: closeSide,
      requestedQuantity: qty
    });
    if (!sameProtectiveOrder(row, { stateVersion, actionType: "PROTECTIVE_FLAT", side: closeSide, quantity: qty })) {
      throw new Error("Persistent protective-flatten order does not match the current request");
    }
    if (row.status === "FILLED") return Object.freeze({
      status: "FILLED",
      orderCode: row.orderCode,
      fillPrice: row.fillPrice,
      filledQuantity: row.filledQuantity,
      filledAt: row.filledAt
    });
    if (["REJECTED", "CANCELED", "EXPIRED", "PARTIAL", "FAILED"].includes(row.status)) {
      return Object.freeze({ status: row.status, orderCode: code });
    }

    if (row.status === "CLAIMED") {
      await addEvent("WARN", "SOL_PROTECTIVE_FLATTEN_SUBMITTING", {
        orderCode: code,
        reason,
        quantity: qty,
        side: closeSide,
        slippagePolicy: d049 ? "BYPASS" : "DIRECT_PROTECTIVE_CLOSE"
      });
      try {
        const response = await client.placePositionClose({
          orderCode: code,
          orderSide: closeSide,
          quantity: qty,
          positionCode: broker.positionCode
        });
        await persistence.markSubmitted(code, response?.orderId ?? null);
      } catch {
        await persistence.markStatus(code, "PENDING", { lastError: "Protective flatten submission outcome is uncertain" });
      }
    }

    return reconcileProtectiveClose({ code, quantity: qty, reason, actionType: "PROTECTIVE_FLAT" });
  }

  return Object.freeze({ isEnabled, executeIntent, executeProtectiveCut, executeProtectiveFlatten });
}
