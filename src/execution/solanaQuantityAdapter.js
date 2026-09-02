const FINAL_NONFILL = new Set(["REJECTED", "CANCELED", "EXPIRED", "PARTIAL", "FAILED"]);

function positive(name, value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`${name} must be positive`);
  return n;
}

function text(name, value, max = 128) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be non-empty`);
  const out = value.trim();
  if (out.length > max) throw new TypeError(`${name} is too long`);
  return out;
}

function sameRequest(row, request) {
  return row.strategyId === request.strategyId &&
    row.instrument === request.instrument &&
    row.stateVersion === request.stateVersion &&
    row.actionType === request.actionType &&
    row.ringTag === (request.ringTag ?? null) &&
    row.lotId === (request.lotId ?? null) &&
    row.tranche === (request.tranche ?? null) &&
    row.side === request.side &&
    Math.abs(row.requestedQuantity - request.quantity) <= 1e-10;
}

export function createSolanaQuantityAdapter({
  client,
  persistence,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollIntervalMs = 750,
  confirmationTimeoutMs = 12_000
}) {
  if (!client || typeof client.placeMarketQuantityOrder !== "function" || typeof client.reconcileQuantityOrder !== "function") {
    throw new TypeError("SOL quantity client is invalid");
  }
  if (!persistence || typeof persistence.claimOrder !== "function" || typeof persistence.getOrder !== "function") {
    throw new TypeError("SOL persistence is invalid");
  }
  if (typeof sleep !== "function") throw new TypeError("sleep must be a function");

  async function reconcile(request) {
    const deadline = Date.now() + confirmationTimeoutMs;
    while (true) {
      const result = await client.reconcileQuantityOrder({ orderCode: request.orderCode, requestedQuantity: request.quantity });
      if (result.status === "FILLED") {
        await persistence.markStatus(request.orderCode, "FILLED", {
          fillPrice: result.fillPrice,
          filledQuantity: result.filledQuantity,
          filledAt: result.filledAt
        });
        return Object.freeze({ confirmed: true, ...result });
      }
      if (FINAL_NONFILL.has(result.status)) {
        await persistence.markStatus(request.orderCode, result.status, { lastError: `DXtrade SOL order ended ${result.status}` });
        return Object.freeze({ confirmed: false, status: result.status, orderCode: request.orderCode });
      }
      await persistence.markStatus(request.orderCode, "PENDING");
      if (Date.now() >= deadline) {
        return Object.freeze({ confirmed: false, status: "PENDING", orderCode: request.orderCode });
      }
      await sleep(pollIntervalMs);
    }
  }

  async function place(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new TypeError("SOL order request must be an object");
    request = Object.freeze({
      ...request,
      orderCode: text("orderCode", request.orderCode, 64),
      strategyId: text("strategyId", request.strategyId, 128),
      instrument: text("instrument", request.instrument, 64),
      side: text("side", request.side, 8).toUpperCase(),
      quantity: positive("quantity", request.quantity)
    });
    if (request.side !== "BUY" && request.side !== "SELL") throw new TypeError("side must be BUY or SELL");

    let row = await persistence.getOrder(request.orderCode);
    if (!row) row = await persistence.claimOrder({
      orderCode: request.orderCode,
      strategyId: request.strategyId,
      instrument: request.instrument,
      stateVersion: request.stateVersion,
      actionType: request.actionType,
      ringTag: request.ringTag ?? null,
      lotId: request.lotId ?? null,
      tranche: request.tranche ?? null,
      side: request.side,
      requestedQuantity: request.quantity
    });
    if (!sameRequest(row, request)) throw new Error("Persistent SOL order does not match current request");

    if (row.status === "FILLED") {
      return Object.freeze({
        confirmed: true,
        status: "FILLED",
        orderCode: row.orderCode,
        brokerOrderId: row.brokerOrderId,
        fillPrice: row.fillPrice,
        filledQuantity: row.filledQuantity,
        filledAt: row.filledAt
      });
    }
    if (FINAL_NONFILL.has(row.status)) return Object.freeze({ confirmed: false, status: row.status, orderCode: row.orderCode });

    if (row.status === "CLAIMED") {
      try {
        const response = await client.placeMarketQuantityOrder({
          orderCode: request.orderCode,
          orderSide: request.side,
          quantity: request.quantity
        });
        row = await persistence.markSubmitted(request.orderCode, response?.orderId ?? null);
      } catch {
        await persistence.markStatus(request.orderCode, "PENDING", { lastError: "DXtrade SOL submission outcome is uncertain" });
      }
    }
    return reconcile(request);
  }

  return Object.freeze({ place });
}
