import test from "node:test";
import assert from "node:assert/strict";
import { DxtradeExecutionError } from "../src/execution/dxtradeExecutionClient.js";
import { createDxtradeOrderAdapter } from "../src/execution/dxtradeOrderAdapter.js";

const REQUEST = Object.freeze({
  orderCode: "GRID-0-BUY1",
  instrument: "BTC/USD",
  type: "MARKET",
  side: "BUY",
  cashQuantity: 250,
  intent: Object.freeze({
    strategyId: "btc-progressive-reference-reset-grid-v1",
    source: "binance",
    symbol: "BTCUSDT",
    side: "BUY",
    tag: "BUY1",
    usd: 250,
    stateVersion: 0
  })
});

function createMemoryLedger(initial = null) {
  let row = initial ? { ...initial } : null;
  const calls = [];
  return {
    calls,
    async init() { calls.push("init"); },
    async get(id) { calls.push(["get", id]); return row ? Object.freeze({ ...row }) : null; },
    async claim(input) {
      calls.push(["claim", input.clientOrderId]);
      if (row) throw new Error("duplicate claim");
      row = {
        clientOrderId: input.clientOrderId,
        strategyId: input.strategyId,
        stateVersion: input.stateVersion,
        gridTag: input.gridTag,
        side: input.side,
        requestedCashQuantity: input.requestedCashQuantity,
        status: "CLAIMED",
        brokerOrderId: null,
        brokerUpdateOrderId: null,
        fillPrice: null,
        filledAt: null,
        lastError: null
      };
      return Object.freeze({ ...row });
    },
    async markSubmitted(id, details) {
      calls.push(["submitted", id]);
      row = { ...row, status: "SUBMITTED", brokerOrderId: details.brokerOrderId == null ? null : String(details.brokerOrderId), brokerUpdateOrderId: details.brokerUpdateOrderId == null ? null : String(details.brokerUpdateOrderId) };
      return Object.freeze({ ...row });
    },
    async markStatus(id, status, details = {}) {
      calls.push(["status", id, status]);
      row = {
        ...row,
        status,
        fillPrice: details.fillPrice ?? row?.fillPrice ?? null,
        filledAt: details.filledAt ?? row?.filledAt ?? null,
        lastError: details.lastError ?? null
      };
      return Object.freeze({ ...row });
    },
    snapshot() { return row ? { ...row } : null; }
  };
}

function clientWith({ place, reconciliations = [], validate = { ok: true } } = {}) {
  let placeCalls = 0;
  let reconcileCalls = 0;
  return {
    get placeCalls() { return placeCalls; },
    get reconcileCalls() { return reconcileCalls; },
    async login() {},
    async validateMarketCashOrder() { return validate; },
    async placeMarketCashOrder(input) {
      placeCalls += 1;
      return place ? place(input) : { orderId: 1001, updateOrderId: 1001 };
    },
    async reconcileMarketCashOrder() {
      reconcileCalls += 1;
      return reconciliations.shift() ?? { status: "PENDING" };
    }
  };
}

test("new order is claimed, submitted exactly once, then advanced only after reconciliation says FILLED", async () => {
  const ledger = createMemoryLedger();
  const client = clientWith({
    reconciliations: [
      { status: "PENDING" },
      { status: "FILLED", fillPrice: 67_195.25, filledAt: "2026-08-23T09:20:00.000Z", brokerOrderId: "1001" }
    ]
  });
  const adapter = createDxtradeOrderAdapter({
    client,
    ledger,
    sleep: async () => {},
    pollIntervalMs: 50,
    confirmationTimeoutMs: 1_000
  });

  const result = await adapter.placeMarketOrder(REQUEST);
  assert.equal(client.placeCalls, 1);
  assert.equal(client.reconcileCalls, 2);
  assert.equal(result.confirmed, true);
  assert.equal(result.fillPrice, 67_195.25);
  assert.equal(ledger.snapshot().status, "FILLED");
});

test("restart with SUBMITTED record reconciles same client id without submitting again", async () => {
  const ledger = createMemoryLedger({
    clientOrderId: "GRID-0-BUY1",
    strategyId: REQUEST.intent.strategyId,
    stateVersion: 0,
    gridTag: "BUY1",
    side: "BUY",
    requestedCashQuantity: 250,
    status: "SUBMITTED",
    brokerOrderId: "1001",
    brokerUpdateOrderId: "1001",
    fillPrice: null,
    filledAt: null,
    lastError: null
  });
  const client = clientWith({
    reconciliations: [{ status: "FILLED", fillPrice: 67_200, filledAt: "2026-08-23T09:21:00.000Z", brokerOrderId: "1001" }]
  });
  const adapter = createDxtradeOrderAdapter({ client, ledger, sleep: async () => {}, pollIntervalMs: 50, confirmationTimeoutMs: 1_000 });
  const result = await adapter.placeMarketOrder(REQUEST);
  assert.equal(client.placeCalls, 0);
  assert.equal(client.reconcileCalls, 1);
  assert.equal(result.confirmed, true);
});

test("ambiguous POST timeout never creates a replacement order and reconciles the same client id", async () => {
  const ledger = createMemoryLedger();
  const client = clientWith({
    place: async () => { throw new DxtradeExecutionError("DXtrade request timed out"); },
    reconciliations: [{ status: "FILLED", fillPrice: 67_201, filledAt: "2026-08-23T09:22:00.000Z", brokerOrderId: "1002" }]
  });
  const adapter = createDxtradeOrderAdapter({ client, ledger, sleep: async () => {}, pollIntervalMs: 50, confirmationTimeoutMs: 1_000 });
  const result = await adapter.placeMarketOrder(REQUEST);
  assert.equal(client.placeCalls, 1);
  assert.equal(client.reconcileCalls, 1);
  assert.equal(result.confirmed, true);
  assert.equal(ledger.snapshot().status, "FILLED");
});

test("HTTP 409 duplicate client id is treated as reconcile-only, not a retry with a new id", async () => {
  const ledger = createMemoryLedger();
  const client = clientWith({
    place: async () => { throw new DxtradeExecutionError("duplicate", { status: 409 }); },
    reconciliations: [{ status: "FILLED", fillPrice: 67_202, filledAt: "2026-08-23T09:23:00.000Z", brokerOrderId: "1003" }]
  });
  const adapter = createDxtradeOrderAdapter({ client, ledger, sleep: async () => {}, pollIntervalMs: 50, confirmationTimeoutMs: 1_000 });
  const result = await adapter.placeMarketOrder(REQUEST);
  assert.equal(client.placeCalls, 1);
  assert.equal(result.confirmed, true);
});

test("definite client error before submission fails closed", async () => {
  const ledger = createMemoryLedger();
  const client = clientWith({
    place: async () => { throw new DxtradeExecutionError("bad request", { status: 400 }); }
  });
  const adapter = createDxtradeOrderAdapter({ client, ledger, sleep: async () => {}, pollIntervalMs: 50, confirmationTimeoutMs: 1_000 });
  const result = await adapter.placeMarketOrder(REQUEST);
  assert.equal(result.confirmed, false);
  assert.equal(result.status, "FAILED");
  assert.equal(client.reconcileCalls, 0);
  assert.equal(ledger.snapshot().status, "FAILED");
});

test("partial final fill is persisted as PARTIAL and never reported confirmed", async () => {
  const ledger = createMemoryLedger();
  const client = clientWith({
    reconciliations: [{ status: "PARTIAL", reason: "Incomplete broker fill" }]
  });
  const adapter = createDxtradeOrderAdapter({ client, ledger, sleep: async () => {}, pollIntervalMs: 50, confirmationTimeoutMs: 1_000 });
  const result = await adapter.placeMarketOrder(REQUEST);
  assert.equal(result.confirmed, false);
  assert.equal(result.status, "PARTIAL");
  assert.equal(ledger.snapshot().status, "PARTIAL");
});

test("already-filled persistent record is returned without any DXtrade submission", async () => {
  const ledger = createMemoryLedger({
    clientOrderId: "GRID-0-BUY1",
    strategyId: REQUEST.intent.strategyId,
    stateVersion: 0,
    gridTag: "BUY1",
    side: "BUY",
    requestedCashQuantity: 250,
    status: "FILLED",
    brokerOrderId: "1001",
    brokerUpdateOrderId: "1001",
    fillPrice: 67_200,
    filledAt: "2026-08-23T09:24:00.000Z",
    lastError: null
  });
  const client = clientWith();
  const adapter = createDxtradeOrderAdapter({ client, ledger, sleep: async () => {}, pollIntervalMs: 50, confirmationTimeoutMs: 1_000 });
  const result = await adapter.placeMarketOrder(REQUEST);
  assert.equal(result.confirmed, true);
  assert.equal(client.placeCalls, 0);
  assert.equal(client.reconcileCalls, 0);
});

test("canary validation uses exact BTC cash order before live activation", async () => {
  let validated;
  const ledger = createMemoryLedger();
  const client = {
    async login() {},
    async validateMarketCashOrder(input) { validated = input; return { valid: true }; },
    async placeMarketCashOrder() { throw new Error("not used"); },
    async reconcileMarketCashOrder() { throw new Error("not used"); }
  };
  const adapter = createDxtradeOrderAdapter({ client, ledger, sleep: async () => {}, pollIntervalMs: 50, confirmationTimeoutMs: 1_000 });
  const result = await adapter.validateGridOrder(REQUEST);
  assert.deepEqual(result, { valid: true });
  assert.deepEqual(validated, { clientOrderId: "GRID-0-BUY1", orderSide: "BUY", cashQuantity: 250 });
});
