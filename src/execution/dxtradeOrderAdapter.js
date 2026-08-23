import { DxtradeExecutionError } from "./dxtradeExecutionClient.js";

const FINAL_NONFILL = new Set(["REJECTED", "CANCELED", "EXPIRED", "PARTIAL", "FAILED"]);

function requireFunction(name, value) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  return value;
}

function requireInteger(name, value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function positive(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return value;
}

function requireClient(client) {
  for (const method of ["login", "validateMarketCashOrder", "placeMarketCashOrder", "reconcileMarketCashOrder"]) {
    if (typeof client?.[method] !== "function") throw new TypeError(`client.${method} must be a function`);
  }
  return client;
}

function requireLedger(ledger) {
  for (const method of ["init", "get", "claim", "markSubmitted", "markStatus"]) {
    if (typeof ledger?.[method] !== "function") throw new TypeError(`ledger.${method} must be a function`);
  }
  return ledger;
}

function safeFailureText(error) {
  if (error instanceof DxtradeExecutionError) {
    return `DXtrade request failed${error.status ? ` (HTTP ${error.status})` : ""}`;
  }
  return "DXtrade execution request failed";
}

function assertRequestMatchesLedger(request, row) {
  if (row.clientOrderId !== request.orderCode ||
      row.stateVersion !== request.intent.stateVersion ||
      row.gridTag !== request.intent.tag ||
      row.side !== request.side ||
      Math.abs(row.requestedCashQuantity - request.cashQuantity) > 1e-9) {
    throw new Error("Persistent order record does not match the current grid intent");
  }
}

export function createDxtradeOrderAdapter({
  client,
  ledger,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollIntervalMs = 250,
  confirmationTimeoutMs = 10_000
}) {
  const dx = requireClient(client);
  const orders = requireLedger(ledger);
  const wait = requireFunction("sleep", sleep);
  requireInteger("pollIntervalMs", pollIntervalMs, 50, 5_000);
  requireInteger("confirmationTimeoutMs", confirmationTimeoutMs, 1_000, 60_000);

  async function initialize() {
    await orders.init();
    await dx.login();
  }

  async function validateGridOrder(request) {
    if (request?.instrument !== "BTC/USD" || request?.type !== "MARKET") {
      throw new TypeError("DXtrade grid adapter accepts only BTC/USD MARKET orders");
    }
    if (request.side !== "BUY" && request.side !== "SELL") throw new TypeError("order side must be BUY or SELL");
    const cashQuantity = positive("cashQuantity", request.cashQuantity);
    return dx.validateMarketCashOrder({
      clientOrderId: request.orderCode,
      orderSide: request.side,
      cashQuantity
    });
  }

  async function reconcileUntilTerminal(request) {
    const deadline = Date.now() + confirmationTimeoutMs;
    while (true) {
      const result = await dx.reconcileMarketCashOrder({
        clientOrderId: request.orderCode,
        requestedCashQuantity: request.cashQuantity
      });

      if (result.status === "FILLED") {
        await orders.markStatus(request.orderCode, "FILLED", {
          fillPrice: result.fillPrice,
          filledAt: result.filledAt
        });
        return Object.freeze({
          confirmed: true,
          orderCode: request.orderCode,
          fillPrice: result.fillPrice,
          filledAt: result.filledAt,
          brokerOrderId: result.brokerOrderId ?? null
        });
      }

      if (FINAL_NONFILL.has(result.status)) {
        await orders.markStatus(request.orderCode, result.status, {
          lastError: result.reason ?? `DXtrade order ended ${result.status}`
        });
        return Object.freeze({
          confirmed: false,
          orderCode: request.orderCode,
          status: result.status,
          reason: result.reason ?? `DXtrade order ended ${result.status}`
        });
      }

      await orders.markStatus(request.orderCode, "PENDING");
      if (Date.now() >= deadline) {
        return Object.freeze({
          confirmed: false,
          orderCode: request.orderCode,
          status: "PENDING",
          reason: "DXtrade fill confirmation timed out; the same client order id must be reconciled before any retry"
        });
      }
      await wait(pollIntervalMs);
    }
  }

  async function placeMarketOrder(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new TypeError("DXtrade market order request must be an object");
    }
    if (request.instrument !== "BTC/USD" || request.type !== "MARKET") {
      throw new TypeError("DXtrade grid adapter accepts only BTC/USD MARKET orders");
    }
    if (request.side !== "BUY" && request.side !== "SELL") throw new TypeError("order side must be BUY or SELL");
    positive("cashQuantity", request.cashQuantity);
    if (!request.intent || request.intent.usd !== request.cashQuantity) {
      throw new Error("DXtrade cash quantity must equal the frozen grid intent dollar size");
    }

    await orders.init();
    await dx.login();

    let row = await orders.get(request.orderCode);
    if (!row) {
      row = await orders.claim({
        clientOrderId: request.orderCode,
        strategyId: request.intent.strategyId,
        stateVersion: request.intent.stateVersion,
        gridTag: request.intent.tag,
        side: request.side,
        requestedCashQuantity: request.cashQuantity
      });
    }
    assertRequestMatchesLedger(request, row);

    if (row.status === "FILLED") {
      return Object.freeze({
        confirmed: true,
        orderCode: row.clientOrderId,
        fillPrice: row.fillPrice,
        filledAt: row.filledAt,
        brokerOrderId: row.brokerOrderId
      });
    }
    if (FINAL_NONFILL.has(row.status)) {
      return Object.freeze({
        confirmed: false,
        orderCode: row.clientOrderId,
        status: row.status,
        reason: row.lastError ?? `Persistent order is already ${row.status}`
      });
    }

    if (row.status === "CLAIMED") {
      try {
        const response = await dx.placeMarketCashOrder({
          clientOrderId: request.orderCode,
          orderSide: request.side,
          cashQuantity: request.cashQuantity
        });
        row = await orders.markSubmitted(request.orderCode, {
          brokerOrderId: response?.orderId ?? null,
          brokerUpdateOrderId: response?.updateOrderId ?? null
        });
      } catch (error) {
        // POST is not idempotent. A timeout/network failure can occur after the
        // server accepted the order, and a 409 can mean the same client id already
        // exists. Never generate a replacement order here; reconcile the same id.
        if (error instanceof DxtradeExecutionError && error.status !== null &&
            error.status >= 400 && error.status < 500 && error.status !== 409) {
          await orders.markStatus(request.orderCode, "FAILED", { lastError: safeFailureText(error) });
          return Object.freeze({
            confirmed: false,
            orderCode: request.orderCode,
            status: "FAILED",
            reason: safeFailureText(error)
          });
        }
        await orders.markStatus(request.orderCode, "PENDING", { lastError: safeFailureText(error) });
      }
    }

    return reconcileUntilTerminal(request);
  }

  return Object.freeze({ initialize, validateGridOrder, placeMarketOrder });
}
