import test from "node:test";
import assert from "node:assert/strict";
import { DxtradeExecutionClient } from "../src/execution/dxtradeExecutionClient.js";
import { normalizeDxtradeAccountMetrics } from "../src/account/dxtradeAccountMonitor.js";

const CONFIG = Object.freeze({
  restBaseUrl: "https://dx.tradeifycrypto.co/dxsca-web",
  username: "private-user",
  domain: "private-domain",
  password: "private-password",
  accountCode: "default:sol-account",
  instrument: "SOL/USD",
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

test("DXtrade client injects SOL/USD into order bodies and instrument metadata lookup", async () => {
  const calls = [];
  const client = new DxtradeExecutionClient({
    ...CONFIG,
    fetchImpl: queuedFetch([
      response({ sessionToken: "secret-session-123" }),
      response({ validationResult: "NOT_RESTRICTED" }),
      response({ symbol: "SOL/USD" })
    ], calls)
  });

  await client.login();
  await client.validateMarketCashOrder({
    clientOrderId: "SOLGRID-0-BUY1",
    orderSide: "BUY",
    cashQuantity: 250
  });
  await client.getAccountInstrumentSettings();

  assert.equal(client.getInstrument(), "SOL/USD");
  assert.equal(JSON.parse(calls[1].options.body).instrument, "SOL/USD");
  assert.equal(calls[2].url, "https://dx.tradeifycrypto.co/dxsca-web/accounts/default%3Asol-account/instruments/SOL%2FUSD");
});

test("account metrics treats SOL/USD as the only allowed active position", () => {
  const snapshot = normalizeDxtradeAccountMetrics({
    metrics: [{
      account: "default:sol-account",
      version: 1,
      balance: 50000,
      equity: 50025,
      dayClosedPl: 0,
      openPl: 25,
      openPositionsCount: 1,
      positions: [{
        symbol: "SOL/USD",
        quantity: 2,
        markPrice: 150,
        openPl: 25,
        dayClosedPl: 0,
        avgOpenPrice: 137.5
      }]
    }]
  }, {
    startingBalance: 50000,
    persistedPeakClosedBalance: 50000,
    instrument: "SOL/USD",
    fetchedAtMs: 1_800_000_000_000
  });

  assert.equal(snapshot.instrument, "SOL/USD");
  assert.equal(snapshot.instrumentPosition.symbol, "SOL/USD");
  assert.equal(snapshot.currentNotional, 300);
  assert.equal(snapshot.btcPosition, null);
  assert.equal(snapshot.invariantError, null);
});

test("account metrics locks if a foreign position exists during SOL operation", () => {
  const snapshot = normalizeDxtradeAccountMetrics({
    metrics: [{
      balance: 50000,
      equity: 50000,
      dayClosedPl: 0,
      openPl: 0,
      openPositionsCount: 1,
      positions: [{
        symbol: "BTC/USD",
        quantity: 0.01,
        markPrice: 70000,
        openPl: 0,
        dayClosedPl: 0,
        avgOpenPrice: 70000
      }]
    }]
  }, {
    startingBalance: 50000,
    persistedPeakClosedBalance: 50000,
    instrument: "SOL/USD",
    fetchedAtMs: 1_800_000_000_000
  });

  assert.equal(snapshot.accountLocked, true);
  assert.match(snapshot.invariantError, /non-SOL\/USD position/i);
});
