import test from "node:test";
import assert from "node:assert/strict";
import {
  DxtradeExecutionClient,
  reconcileQuantityOrderHistory
} from "../src/execution/dxtradeExecutionClient.js";

const CONFIG = Object.freeze({
  restBaseUrl: "https://dx.tradeifycrypto.co/dxsca-web",
  username: "private-user",
  domain: "private-domain",
  password: "private-password",
  accountCode: "default:btc-account",
  timeoutMs: 2_000
});

function response(payload, status = 200) {
  return new Response(payload == null ? "" : JSON.stringify(payload), { status });
}

function queuedFetch(responses, calls) {
  return async (url, options) => {
    calls.push({ url: url.toString(), options });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected fetch call");
    return next;
  };
}

test("protective close validates exact position code, opposite side, and quantity", async () => {
  const calls = [];
  const client = new DxtradeExecutionClient({
    ...CONFIG,
    fetchImpl: queuedFetch([
      response({ sessionToken: "secret-session-123" }),
      response({ valid: true })
    ], calls)
  });
  await client.login();
  await client.validateMarketPositionClose({
    clientOrderId: "FLAT-7",
    positionCode: "position-abc",
    orderSide: "SELL",
    quantity: 0.0125
  });

  assert.equal(calls[1].url, "https://dx.tradeifycrypto.co/dxsca-web/accounts/default%3Abtc-account/orders/validate");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    orderCode: "FLAT-7",
    type: "MARKET",
    instrument: "BTC/USD",
    quantity: 0.0125,
    positionEffect: "CLOSE",
    positionCode: "position-abc",
    side: "SELL",
    tif: "GTC"
  });
});

test("full quantity close reconciles only after final completed history", () => {
  const result = reconcileQuantityOrderHistory({
    orders: [{
      orderId: 2001,
      clientOrderId: "FLAT-7",
      status: "COMPLETED",
      finalStatus: true,
      transactionTime: "2026-08-23T10:00:01.000Z",
      legs: [{
        filledQuantity: 0.0125,
        remainingQuantity: 0,
        averagePrice: 66_500
      }],
      executions: [{
        lastQuantity: 0.0125,
        lastPrice: 66_500,
        transactionTime: "2026-08-23T10:00:00.500Z"
      }]
    }]
  }, { clientOrderId: "FLAT-7", requestedQuantity: 0.0125 });

  assert.equal(result.status, "FILLED");
  assert.equal(result.fillPrice, 66_500);
  assert.equal(result.filledQuantity, 0.0125);
  assert.equal(result.filledAt, "2026-08-23T10:00:00.500Z");
});

test("partial quantity close is never treated as protective success", () => {
  const result = reconcileQuantityOrderHistory({
    orders: [{
      clientOrderId: "FLAT-7",
      status: "COMPLETED",
      finalStatus: true,
      legs: [{ filledQuantity: 0.005, remainingQuantity: 0.0075, averagePrice: 66_500 }],
      executions: [{ lastQuantity: 0.005, lastPrice: 66_500, transactionTime: "2026-08-23T10:00:00.500Z" }]
    }]
  }, { clientOrderId: "FLAT-7", requestedQuantity: 0.0125 });
  assert.equal(result.status, "PARTIAL");
});
