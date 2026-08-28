import test from "node:test";
import assert from "node:assert/strict";
import { createBinanceDailyMaProvider } from "../src/market/binanceDailyMa.js";
import { SolanaQuantityClient, reconcileSolQuantityOrder } from "../src/execution/solanaQuantityClient.js";
import { createSolanaExecutionGuard } from "../src/execution/solanaExecutionGuard.js";
import { createSolanaRuntime } from "../src/runtime/solanaRuntime.js";
import { applyConfirmedEntry, createInitialSolanaState, expectedNetUnits } from "../src/strategies/solanaGrid.js";

function response(payload, status = 200, headers = {}) {
  return new Response(payload == null ? "" : JSON.stringify(payload), { status, headers });
}

function baseRisk(brokerNetUnits = 0, liveEquity = 50_000) {
  return {
    startingBalance: 50_000,
    maxLossOffset: 3_000,
    peakClosedBalance: 50_000,
    payoutTaken: false,
    previousDayClosingBalance: 50_000,
    dailyLossLimit: 1_500,
    liveEquity,
    currentNotional: 0,
    maxNotional: 100_000,
    operatorPaused: false,
    safetyHalt: false,
    accountLocked: false,
    feedHealthy: true,
    accountDataFresh: true,
    nettingConfirmed: true,
    brokerNetUnits
  };
}

function createRiskLadderStore() {
  let row = null;
  return {
    async getLatestRiskLadderState() { return row; },
    async saveRiskLadderState(input) { row = Object.freeze({ ...input }); return row; }
  };
}

const riskLadderConfig = Object.freeze({
  enabled: true,
  entryBrakeUsd: 300,
  partialCutUsd: 1000,
  partialCutFraction: 0.5,
  fullFlattenUsd: 1250,
  protectiveOrdersBypassSlippageCap: true,
  resumeAfterFlatten: "nextDailyRollover"
});

test("200-day SOL MA uses exactly completed UTC daily closes", async () => {
  const day = 86_400_000;
  const currentDayStart = Date.UTC(2026, 7, 24);
  const serverTime = currentDayStart + 5_000;
  const rows = Array.from({ length: 200 }, (_, i) => {
    const openTime = currentDayStart - ((200 - i) * day);
    const close = 100 + i;
    return [openTime, "1", "1", "1", String(close), "1", openTime + day - 1, "1", 1, "1", "1", "0"];
  });
  const calls = [];
  const provider = createBinanceDailyMaProvider({
    fetchImpl: async (url) => {
      calls.push(url.toString());
      return calls.length === 1 ? response({ serverTime }) : response(rows);
    }
  });
  const result = await provider.refresh();
  assert.equal(result.symbol, "SOLUSDT");
  assert.equal(result.days, 200);
  assert.equal(result.ma, 199.5);
  assert.equal(result.completedThrough, new Date(currentDayStart).toISOString());
  assert.match(calls[1], /symbol=SOLUSDT/);
  assert.match(calls[1], /interval=1d/);
  assert.match(calls[1], /limit=200/);
});

test("SOL quantity client sends explicit OPEN position effect and reconciles confirmed fill", async () => {
  const calls = [];
  const replies = [
    response({ sessionToken: "session-token-123" }),
    response({ orderId: 42 }),
    response({
      orders: [{
        orderId: 42,
        clientOrderId: "SOLGRID-1-BUY1-E",
        status: "COMPLETED",
        finalStatus: true,
        transactionTime: "2026-08-24T01:00:00.500Z",
        legs: [{ filledQuantity: 0.06, remainingQuantity: 0, averagePrice: 99.5 }],
        executions: [{ lastQuantity: 0.06, lastPrice: 99.5, transactionTime: "2026-08-24T01:00:00.500Z" }]
      }]
    })
  ];
  const client = new SolanaQuantityClient({
    restBaseUrl: "https://dx.tradeifycrypto.co/dxsca-web",
    username: "private-user",
    domain: "private-domain",
    password: "private-password",
    accountCode: "account-code",
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), options });
      return replies.shift();
    }
  });
  await client.placeMarketQuantityOrder({ orderCode: "SOLGRID-1-BUY1-E", orderSide: "BUY", quantity: 0.06 });
  const body = JSON.parse(calls[1].options.body);
  assert.deepEqual(body, {
    orderCode: "SOLGRID-1-BUY1-E",
    type: "MARKET",
    instrument: "SOL/USD",
    quantity: 0.06,
    positionEffect: "OPEN",
    side: "BUY",
    tif: "GTC"
  });
  assert.equal("cashQuantity" in body, false);
  const fill = await client.reconcileQuantityOrder({ orderCode: "SOLGRID-1-BUY1-E", requestedQuantity: 0.06 });
  assert.equal(fill.status, "FILLED");
  assert.equal(fill.filledQuantity, 0.06);
  assert.equal(fill.fillPrice, 99.5);
});

test("SOL position close uses CLOSE effect and position code without an explicit quantity", async () => {
  const calls = [];
  const replies = [response({ sessionToken: "session-token-123" }), response({ orderId: 77 })];
  const client = new SolanaQuantityClient({
    restBaseUrl: "https://dx.tradeifycrypto.co/dxsca-web",
    username: "private-user",
    domain: "private-domain",
    password: "private-password",
    accountCode: "account-code",
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), options });
      return replies.shift();
    }
  });
  await client.placePositionClose({
    orderCode: "SOLCANARY-V2-CLOSE",
    orderSide: "SELL",
    quantity: 0.01,
    positionCode: "position-sol-1"
  });
  const body = JSON.parse(calls[1].options.body);
  assert.deepEqual(body, {
    orderCode: "SOLCANARY-V2-CLOSE",
    type: "MARKET",
    instrument: "SOL/USD",
    positionEffect: "CLOSE",
    positionCode: "position-sol-1",
    side: "SELL",
    tif: "GTC"
  });
  assert.equal("quantity" in body, false);
});

test("quantity reconciliation never treats a partial final order as filled", () => {
  const result = reconcileSolQuantityOrder({
    orders: [{
      clientOrderId: "SOLGRID-2-BUY2-E",
      status: "COMPLETED",
      finalStatus: true,
      legs: [{ filledQuantity: 0.03, remainingQuantity: 0.03, averagePrice: 100 }],
      executions: [{ lastQuantity: 0.03, lastPrice: 100, transactionTime: "2026-08-24T01:00:00.000Z" }]
    }]
  }, { orderCode: "SOLGRID-2-BUY2-E", requestedQuantity: 0.06 });
  assert.equal(result.status, "PARTIAL");
});

test("SOL execution guard cannot submit while either execution lock is false", async () => {
  let placed = 0;
  const guard = createSolanaExecutionGuard({
    autoExecute: false,
    strategyAutoExecute: false,
    adapter: { place: async () => { placed += 1; } },
    client: {
      getOpenPositions: async () => ({ positions: [] }),
      placePositionPartialClose: async () => {},
      placePositionClose: async () => {},
      reconcileQuantityOrder: async () => ({ status: "PENDING" })
    },
    persistence: { claimOrder: async () => {}, getOrder: async () => null }
  });
  const result = await guard.executeIntent({
    type: "ENTRY", strategyId: "sol-outer-heavy-v1", stateVersion: 1,
    tag: "BUY1", ringTag: "BUY1", lotId: "BUY1-V1", side: "BUY", quantity: 0.06
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(placed, 0);
});

test("protective flatten closes exactly the one signed net SOL broker position", async () => {
  const orders = new Map();
  const persistence = {
    async getOrder(code) { return orders.get(code) ?? null; },
    async claimOrder(input) {
      const row = {
        orderCode: input.orderCode,
        strategyId: input.strategyId,
        instrument: input.instrument,
        stateVersion: input.stateVersion,
        actionType: input.actionType,
        status: "CLAIMED",
        requestedQuantity: input.requestedQuantity,
        side: input.side
      };
      orders.set(input.orderCode, row);
      return row;
    },
    async markSubmitted(code, brokerOrderId) {
      const row = { ...orders.get(code), status: "SUBMITTED", brokerOrderId };
      orders.set(code, row);
      return row;
    },
    async markStatus(code, status, details) {
      const row = { ...orders.get(code), status, ...details };
      orders.set(code, row);
      return row;
    }
  };
  let closeRequest = null;
  const guard = createSolanaExecutionGuard({
    autoExecute: true,
    strategyAutoExecute: true,
    adapter: { place: async () => { throw new Error("grid adapter should not be used for protective close"); } },
    client: {
      getOpenPositions: async () => ({
        positions: [{ symbol: "SOL/USD", quantity: -0.12, positionCode: "position-sol-1" }]
      }),
      placePositionPartialClose: async () => {},
      placePositionClose: async (request) => {
        closeRequest = request;
        return { orderId: "broker-flat-1" };
      },
      reconcileQuantityOrder: async () => ({
        status: "FILLED",
        fillPrice: 101,
        filledQuantity: 0.12,
        filledAt: "2026-08-24T01:00:00.000Z"
      })
    },
    persistence
  });

  const result = await guard.executeProtectiveFlatten({ stateVersion: 7, reason: "daily floor" });
  assert.equal(result.status, "FILLED");
  assert.deepEqual(closeRequest, {
    orderCode: "SOLFLAT-7",
    orderSide: "BUY",
    quantity: 0.12,
    positionCode: "position-sol-1"
  });
  assert.equal(orders.get("SOLFLAT-7").status, "FILLED");
});

test("D-049 protective partial cut uses the linked broker position, unique daily identity, and slippage bypass", async () => {
  const orders = new Map();
  let closeRequest = null;
  const persistence = {
    async getOrder(code) { return orders.get(code) ?? null; },
    async claimOrder(input) {
      const row = { ...input, requestedQuantity: input.requestedQuantity, status: "CLAIMED" };
      orders.set(input.orderCode, row);
      return row;
    },
    async markSubmitted(code, brokerOrderId) {
      const row = { ...orders.get(code), status: "SUBMITTED", brokerOrderId };
      orders.set(code, row);
      return row;
    },
    async markStatus(code, status, details) {
      const row = { ...orders.get(code), status, ...details };
      orders.set(code, row);
      return row;
    }
  };
  const guard = createSolanaExecutionGuard({
    autoExecute: true,
    strategyAutoExecute: true,
    protectiveOrdersBypassSlippageCap: true,
    adapter: { place: async () => { throw new Error("grid adapter should not be used for protective cut"); } },
    client: {
      getOpenPositions: async () => ({ positions: [{ symbol: "SOL/USD", quantity: 1.2, positionCode: "sol-pos" }] }),
      placePositionPartialClose: async (request) => { closeRequest = request; return { orderId: "cut-1" }; },
      placePositionClose: async () => { throw new Error("flatten path must not be used for a partial cut"); },
      reconcileQuantityOrder: async () => ({
        status: "FILLED", fillPrice: 82, filledQuantity: 0.6, filledAt: "2026-08-24T20:00:00.000Z"
      })
    },
    persistence
  });
  const result = await guard.executeProtectiveCut({
    stateVersion: 9,
    dayKey: "2026-08-24",
    quantity: 0.6,
    side: "SELL",
    reason: "D-049 partial cut",
    bypassSlippageCap: true
  });
  assert.equal(result.status, "FILLED");
  assert.deepEqual(closeRequest, {
    orderCode: "SOLCUT-20260824-9",
    orderSide: "SELL",
    quantity: 0.6,
    positionCode: "sol-pos"
  });
  assert.equal(orders.get("SOLCUT-20260824-9").actionType, "PROTECTIVE_CUT");
});

test("live runtime executes eligible exits before an entry crossed on the same live update", async () => {
  let state = createInitialSolanaState();
  state = applyConfirmedEntry(state, {
    type: "ENTRY",
    strategyId: "sol-outer-heavy-v1",
    stateVersion: 0,
    ringTag: "BUY1",
    tag: "BUY1",
    side: "BUY",
    quantity: 0.06,
    lotId: "BUY1-V0"
  }, {
    fillPrice: 100,
    filledQuantity: 0.06,
    filledAt: "2026-08-24T00:00:00.000Z"
  });

  const store = {
    init: async () => {},
    load: async () => state,
    initializeIfMissing: async (candidate) => { if (!state) state = candidate; return state; },
    save: async (expected, next) => {
      assert.equal(state.version, expected);
      state = next;
      return state;
    }
  };
  const ladderStore = createRiskLadderStore();
  const actions = [];
  const execution = {
    isEnabled: () => true,
    executeProtectiveCut: async () => ({ status: "ALREADY_FLAT" }),
    executeProtectiveFlatten: async () => ({ status: "ALREADY_FLAT" }),
    executeIntent: async (intent) => {
      actions.push(intent.type === "EXIT" ? `EXIT${intent.tranche}` : intent.tag);
      return {
        status: "FILLED",
        confirmed: true,
        orderCode: "TEST",
        fillPrice: intent.observedPrice,
        filledQuantity: intent.quantity,
        filledAt: "2026-08-24T00:00:30.000Z"
      };
    }
  };
  const runtime = createSolanaRuntime({
    stateStore: store,
    riskLadderStore: ladderStore,
    riskLadderConfig,
    maProvider: { getCurrent: async () => ({ ma: 100, completedThrough: "2026-08-24T00:00:00.000Z" }) },
    execution,
    minimumHoldSeconds: 25,
    getRiskSnapshot: async () => baseRisk(expectedNetUnits(state))
  });
  await runtime.init();

  await runtime.processTrade({ source: "binance", symbol: "SOLUSDT", price: 112, tradeTime: "2026-08-24T00:00:10.000Z" });
  assert.deepEqual(actions, []);

  await runtime.processTrade({ source: "binance", symbol: "SOLUSDT", price: 114, tradeTime: "2026-08-24T00:00:30.000Z" });
  const firstEntryIndex = actions.findIndex((x) => x === "SELL1");
  assert.ok(firstEntryIndex > 0, `expected exits before SELL1, got ${actions.join(",")}`);
  assert.ok(actions.slice(0, firstEntryIndex).every((x) => x.startsWith("EXIT")));
});
