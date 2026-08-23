import test from "node:test";
import assert from "node:assert/strict";
import {
  DXTRADE_EXECUTION_IDENTITY,
  DxtradeExecutionClient,
  reconcileCashOrderHistory
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
  return new Response(payload == null ? "" : JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function queuedFetch(responses, calls) {
  return async (url, options) => {
    calls.push({ url: url.toString(), options });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected fetch call");
    return next;
  };
}

test("execution client hard-pins the Tradeify production HTTPS origin", () => {
  for (const badUrl of [
    "http://dx.tradeifycrypto.co/dxsca-web",
    "https://evil.example/dxsca-web",
    "https://dx.tradeifycrypto.co:444/dxsca-web",
    "https://user:pass@dx.tradeifycrypto.co/dxsca-web",
    "https://dx.tradeifycrypto.co/other"
  ]) {
    assert.throws(() => new DxtradeExecutionClient({ ...CONFIG, restBaseUrl: badUrl }), /DXtrade REST base URL/i);
  }
  assert.equal(DXTRADE_EXECUTION_IDENTITY.hostname, "dx.tradeifycrypto.co");
  assert.equal(DXTRADE_EXECUTION_IDENTITY.instrument, "BTC/USD");
});

test("login keeps session private and cash-order validation cannot escape BTC/USD", async () => {
  const calls = [];
  const client = new DxtradeExecutionClient({
    ...CONFIG,
    fetchImpl: queuedFetch([
      response({ sessionToken: "secret-session-123" }),
      response({ valid: true })
    ], calls)
  });
  assert.deepEqual(await client.login(), { authenticated: true });
  const validation = await client.validateMarketCashOrder({
    clientOrderId: "GRID-0-BUY1",
    orderSide: "BUY",
    cashQuantity: 250
  });
  assert.deepEqual(validation, { valid: true });
  assert.equal(calls[1].url, "https://dx.tradeifycrypto.co/dxsca-web/accounts/default%3Abtc-account/orders/validate");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    orderCode: "GRID-0-BUY1",
    type: "MARKET",
    instrument: "BTC/USD",
    cashQuantity: 250,
    side: "BUY"
  });
  assert.equal(calls[1].options.headers.authorization, "DXAPI secret-session-123");
  assert.equal(JSON.stringify(client.getSessionInfo()).includes("secret-session-123"), false);
});

test("place order returns broker ids but does not claim a fill", async () => {
  const calls = [];
  const client = new DxtradeExecutionClient({
    ...CONFIG,
    fetchImpl: queuedFetch([
      response({ sessionToken: "secret-session-123" }),
      response({ orderId: 1001, updateOrderId: 1002 })
    ], calls)
  });
  await client.login();
  const result = await client.placeMarketCashOrder({
    clientOrderId: "GRID-0-BUY1",
    orderSide: "BUY",
    cashQuantity: 250
  });
  assert.deepEqual(result, { orderId: 1001, updateOrderId: 1002 });
  assert.equal(Object.hasOwn(result, "confirmed"), false);
  assert.equal(calls[1].options.method, "POST");
});

test("history lookup uses the official with-client-id filter", async () => {
  const calls = [];
  const client = new DxtradeExecutionClient({
    ...CONFIG,
    fetchImpl: queuedFetch([
      response({ sessionToken: "secret-session-123" }),
      response({ orders: [] })
    ], calls)
  });
  await client.login();
  await client.getOrderHistory("GRID-0-BUY1");
  const url = new URL(calls[1].url);
  assert.equal(url.pathname, "/dxsca-web/accounts/default%3Abtc-account/orders/history");
  assert.equal(url.searchParams.get("with-client-id"), "GRID-0-BUY1");
  assert.equal(url.searchParams.get("limit"), "10");
});

test("completed full cash fill reconciles using broker average price and fill time", () => {
  const result = reconcileCashOrderHistory({
    orders: [{
      orderId: 1001,
      clientOrderId: "GRID-0-BUY1",
      status: "COMPLETED",
      finalStatus: true,
      transactionTime: "2026-08-23T09:10:01.000Z",
      legs: [{
        filledCashQuantity: 250,
        remainingCashQuantity: 0,
        filledQuantity: 0.0037,
        remainingQuantity: 0,
        averagePrice: 67_200
      }],
      executions: [{
        clientOrderId: "GRID-0-BUY1",
        status: "COMPLETED",
        finalStatus: true,
        lastQuantity: 0.0037,
        lastPrice: 67_200,
        averagePrice: 67_200,
        transactionTime: "2026-08-23T09:10:00.500Z"
      }]
    }]
  }, { clientOrderId: "GRID-0-BUY1", requestedCashQuantity: 250 });

  assert.equal(result.status, "FILLED");
  assert.equal(result.fillPrice, 67_200);
  assert.equal(result.filledAt, "2026-08-23T09:10:00.500Z");
});

test("partial final fill never becomes a successful grid fill", () => {
  const result = reconcileCashOrderHistory({
    orders: [{
      clientOrderId: "GRID-0-BUY1",
      status: "COMPLETED",
      finalStatus: true,
      transactionTime: "2026-08-23T09:10:01.000Z",
      legs: [{
        filledCashQuantity: 125,
        remainingCashQuantity: 125,
        filledQuantity: 0.0018,
        remainingQuantity: 0.0018,
        averagePrice: 67_200
      }],
      executions: [{
        lastQuantity: 0.0018,
        lastPrice: 67_200,
        transactionTime: "2026-08-23T09:10:00.500Z"
      }]
    }]
  }, { clientOrderId: "GRID-0-BUY1", requestedCashQuantity: 250 });
  assert.equal(result.status, "PARTIAL");
});

test("working/missing orders stay pending and final rejection stays rejected", () => {
  assert.equal(reconcileCashOrderHistory({ orders: [] }, {
    clientOrderId: "GRID-0-BUY1",
    requestedCashQuantity: 250
  }).status, "PENDING");

  assert.equal(reconcileCashOrderHistory({ orders: [{
    orderId: 1001,
    clientOrderId: "GRID-0-BUY1",
    status: "WORKING",
    finalStatus: false,
    legs: [{ filledCashQuantity: 0, remainingCashQuantity: 250, filledQuantity: 0, remainingQuantity: 0.0037, averagePrice: 0 }],
    executions: []
  }] }, { clientOrderId: "GRID-0-BUY1", requestedCashQuantity: 250 }).status, "PENDING");

  assert.equal(reconcileCashOrderHistory({ orders: [{
    clientOrderId: "GRID-0-BUY1",
    status: "REJECTED",
    finalStatus: true,
    legs: [{ filledCashQuantity: 0, remainingCashQuantity: 250, filledQuantity: 0, remainingQuantity: 0, averagePrice: 0 }],
    executions: [{ rejectCode: 33, rejectReason: "rejected" }]
  }] }, { clientOrderId: "GRID-0-BUY1", requestedCashQuantity: 250 }).status, "REJECTED");
});

test("API errors redact credentials and clear session on 401", async () => {
  const client = new DxtradeExecutionClient({
    ...CONFIG,
    fetchImpl: queuedFetch([
      response({ sessionToken: "secret-session-123" }),
      response({
        errorCode: 3,
        description: "private-user private-domain private-password secret-session-123"
      }, 401)
    ], [])
  });
  await client.login();
  await assert.rejects(
    client.getAccountMetrics(),
    (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.message.includes("private-user"), false);
      assert.equal(error.message.includes("private-domain"), false);
      assert.equal(error.message.includes("private-password"), false);
      assert.equal(error.message.includes("secret-session-123"), false);
      return true;
    }
  );
  assert.deepEqual(client.getSessionInfo(), { authenticated: false });
});
