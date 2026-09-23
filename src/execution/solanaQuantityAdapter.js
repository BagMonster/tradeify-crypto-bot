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
      // "Not found in DXtrade history" is not the same as "working at the broker".
      // An order the broker has never heard of after the full confirmation window
      // was never accepted, so it is resolved to a terminal FAILED rather than
      // left PENDING forever. A row that stays non-terminal blocks its order code
      // permanently, because the throw below prevents the state version from
      // advancing and the frozen version keeps regenerating the same code.
      // The client says so explicitly now. The prose match is kept for any caller
      // or stub that still reports it the old way.
      const brokerHasNoRecord = result.brokerHasNoRecord === true ||
        (typeof result.reason === "string" && result.reason.toLowerCase().includes("not found in dxtrade history"));
      await persistence.markStatus(request.orderCode, "PENDING");
      if (Date.now() >= deadline) {
        if (brokerHasNoRecord) {
          await persistence.markStatus(request.orderCode, "FAILED", {
            lastError: "DXtrade never accepted this order code; resolved to FAILED so it cannot block the code forever"
          });
          return Object.freeze({ confirmed: false, status: "FAILED", orderCode: request.orderCode, brokerHasNoRecord: true });
        }
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
    // The order code does not encode quantity: makeOrderCode() keys on
    // (prefix, stateVersion, tag, tranche) only. Entry size is
    // floorLot(ring.usd / price) and therefore moves whenever price moves, and a
    // forced moving-average exit reuses an ordinary tranche exit's tag and
    // tranche with a different size. So a retry can legitimately arrive with a
    // quantity the stored row does not carry.
    //
    // Throwing on that left the row non-terminal for good: the throw stopped the
    // state version from advancing, the frozen version regenerated the same
    // colliding code on the next tick, and the book halted every tick thereafter.
    //
    // Resolve the stored order instead of rejecting the caller. A terminal row is
    // a settled fact and is reported as-is. A live row is reconciled against the
    // broker using the size that was actually submitted, never the new one. A new
    // order is never placed under a code whose row is still live, so this cannot
    // double-fill.
    if (!sameRequest(row, request)) {
      if (row.status === "FILLED") {
        // The broker filled a different size under this code. Do not hand it back
        // as this intent's fill; the caller would apply the wrong quantity to the
        // virtual book. Report it and let the hybrid reconciliation pass absorb
        // the difference from broker truth.
        return Object.freeze({
          confirmed: false,
          status: "STALE_CODE_ALREADY_FILLED",
          orderCode: row.orderCode,
          storedQuantity: row.requestedQuantity,
          requestedQuantity: request.quantity,
          reason: "This order code already filled under a different quantity"
        });
      }
      if (FINAL_NONFILL.has(row.status)) {
        return Object.freeze({ confirmed: false, status: row.status, orderCode: row.orderCode, staleCode: true });
      }
      return reconcile(Object.freeze({ ...request, quantity: row.requestedQuantity }));
    }

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
      } catch (error) {
        // 2026-09-22. This was a bare `catch {}`: the broker's own words for why a
        // submission failed were discarded, and the reconcile pass below then wrote
        // last_error = NULL on its next poll, erasing even the generic note. Orders
        // that never reached DXtrade were indistinguishable from orders working at
        // the broker, for hours. The message goes to the log first, because that is
        // the one place nothing later overwrites.
        const status = Number.isFinite(error?.status) ? error.status : null;
        const message = typeof error?.message === "string" && error.message !== "" ? error.message : "unknown error";
        console.error(
          `DXtrade ${request.instrument} order submission FAILED for ${request.orderCode}` +
          `${status === null ? "" : ` (HTTP ${status})`}: ${message}`
        );
        // A 4xx other than 429 is the broker refusing the request outright: the order
        // was never created, so it is FAILED, not "uncertain". Leaving it PENDING made
        // the ring poll an order that does not exist and can never resolve, which is
        // what kept every book stuck this evening. A timeout, a 5xx or a 429 really is
        // uncertain, so those stay PENDING and are reconciled against the broker.
        const refused = status !== null && status >= 400 && status < 500 && status !== 429;
        await persistence.markStatus(request.orderCode, refused ? "FAILED" : "PENDING", {
          lastError: `${refused ? "DXtrade refused the order" : "DXtrade submission outcome is uncertain"}` +
            `${status === null ? "" : ` (HTTP ${status})`}: ${message}`
        });
        if (refused) {
          return Object.freeze({ confirmed: false, status: "FAILED", orderCode: request.orderCode, reason: message });
        }
      }
    }
    return reconcile(request);
  }

  return Object.freeze({ place });
}
