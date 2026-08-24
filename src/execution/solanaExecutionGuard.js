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

export function createSolanaExecutionGuard({
  autoExecute,
  strategyAutoExecute,
  adapter,
  client,
  persistence,
  addEvent = async () => {}
}) {
  if (typeof autoExecute !== "boolean" || typeof strategyAutoExecute !== "boolean") throw new TypeError("execution locks must be boolean");
  if (typeof adapter?.place !== "function") throw new TypeError("SOL quantity adapter is invalid");
  if (typeof client?.getOpenPositions !== "function" || typeof client?.placePositionClose !== "function" || typeof client?.reconcileQuantityOrder !== "function") {
    throw new TypeError("SOL quantity client lacks protective-close methods");
  }
  if (typeof persistence?.claimOrder !== "function") throw new TypeError("SOL persistence is invalid");
  if (typeof addEvent !== "function") throw new TypeError("addEvent must be a function");

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

  async function executeProtectiveFlatten({ stateVersion, reason }) {
    text("reason", reason, 300);
    if (!isEnabled()) return Object.freeze({ status: "BLOCKED", reason: "Automatic execution locks are off" });
    const payload = await client.getOpenPositions();
    const rows = positionRows(payload).filter((row) => positionSymbol(row) === "SOL/USD" && Math.abs(positionQuantity(row)) > 1e-12);
    if (rows.length === 0) return Object.freeze({ status: "ALREADY_FLAT" });
    if (rows.length !== 1) throw new Error("Protective flatten requires exactly one net SOL/USD broker position");

    const position = rows[0];
    const signedQty = positionQuantity(position);
    const qty = positive("protective quantity", Math.abs(signedQty));
    const direction = positionSide(position, signedQty);
    const closeSide = direction === "SHORT" ? "BUY" : "SELL";
    const pCode = positionCode(position);
    const code = `SOLFLAT-${stateVersion}`;

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
    if (row.status === "FILLED") return Object.freeze({
      status: "FILLED",
      fillPrice: row.fillPrice,
      filledQuantity: row.filledQuantity,
      filledAt: row.filledAt
    });

    if (row.status === "CLAIMED") {
      const response = await client.placePositionClose({
        orderCode: code,
        orderSide: closeSide,
        quantity: qty,
        positionCode: pCode
      });
      await persistence.markSubmitted(code, response?.orderId ?? null);
    }

    const deadline = Date.now() + 12_000;
    while (Date.now() <= deadline) {
      const result = await client.reconcileQuantityOrder({ orderCode: code, requestedQuantity: qty });
      if (result.status === "FILLED") {
        await persistence.markStatus(code, "FILLED", {
          fillPrice: result.fillPrice,
          filledQuantity: result.filledQuantity,
          filledAt: result.filledAt
        });
        await addEvent("WARN", "SOL_PROTECTIVE_FLATTEN_CONFIRMED", { reason, quantity: qty, fillPrice: result.fillPrice });
        return Object.freeze({ status: "FILLED", ...result });
      }
      if (["REJECTED","CANCELED","EXPIRED","PARTIAL"].includes(result.status)) {
        await persistence.markStatus(code, result.status, { lastError: `Protective flatten ended ${result.status}` });
        return Object.freeze({ status: result.status });
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    await persistence.markStatus(code, "PENDING", { lastError: "Protective flatten confirmation timed out" });
    return Object.freeze({ status: "PENDING" });
  }

  return Object.freeze({ isEnabled, executeIntent, executeProtectiveFlatten });
}
