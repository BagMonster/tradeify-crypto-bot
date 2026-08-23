import test from "node:test";
import assert from "node:assert/strict";
import { createGridRuntime } from "../src/runtime/gridRuntime.js";

function createMemoryStore() {
  let state = null;
  return {
    async init() {},
    async load() { return state; },
    async initializeIfMissing(next) { if (!state) state = next; return state; },
    async save(expectedVersion, next) {
      if (!state || state.version !== expectedVersion) throw new Error("version conflict");
      state = next;
      return state;
    }
  };
}

const BASE_RISK = Object.freeze({
  startingBalance: 50_000,
  maxLossOffset: 3_000,
  peakClosedBalance: 50_000,
  payoutTaken: false,
  previousDayClosingBalance: 50_000,
  dailyLossLimit: 1_500,
  liveEquity: 50_000,
  currentNotional: 0,
  maxNotional: 100_000,
  operatorPaused: false,
  safetyHalt: false,
  accountLocked: false,
  feedHealthy: true,
  accountDataFresh: true,
  nettingConfirmed: true
});

function trade(price, minute = 0) {
  return Object.freeze({
    source: "binance",
    symbol: "BTCUSDT",
    price,
    tradeTime: `2026-08-23T08:${String(minute).padStart(2, "0")}:00.000Z`
  });
}

function liveExecution() {
  return {
    async executeGridIntent({ intent }) {
      return Object.freeze({
        status: "FILLED",
        orderCode: `TEST-${intent.stateVersion}-${intent.tag}`,
        fillPrice: intent.observedPrice,
        filledAt: `2026-08-23T08:${String(intent.stateVersion + 1).padStart(2, "0")}:30.000Z`
      });
    },
    async executeProtectiveFlatten() {
      return Object.freeze({ status: "FILLED", fillPrice: 65_000, filledAt: "2026-08-23T08:59:00.000Z" });
    }
  };
}

test("runtime initializes once and does nothing when no level is crossed", async () => {
  const store = createMemoryStore();
  const runtime = createGridRuntime({
    stateStore: store,
    getRiskSnapshot: async () => BASE_RISK,
    execution: liveExecution()
  });

  const initial = await runtime.initialize(70_000);
  assert.equal(initial.version, 0);
  const result = await runtime.processTrade(trade(69_000));
  assert.equal(result.status, "NO_INTENT");
  assert.equal((await store.load()).referencePrice, 70_000);
});

test("grid state advances only after a confirmed fill", async () => {
  const store = createMemoryStore();
  const runtime = createGridRuntime({
    stateStore: store,
    getRiskSnapshot: async () => BASE_RISK,
    execution: liveExecution()
  });
  await runtime.initialize(70_000);

  const result = await runtime.processTrade(trade(67_200, 1));
  assert.equal(result.status, "FILLED");
  const state = await store.load();
  assert.equal(state.version, 1);
  assert.equal(state.referencePrice, 67_200);
  assert.equal(state.buyCount, 1);
  assert.equal(state.sellCount, 0);
});

test("unconfirmed broker result leaves reference and counters unchanged", async () => {
  const store = createMemoryStore();
  const runtime = createGridRuntime({
    stateStore: store,
    getRiskSnapshot: async () => BASE_RISK,
    execution: {
      async executeGridIntent() { return Object.freeze({ status: "NOT_CONFIRMED" }); },
      async executeProtectiveFlatten() { return Object.freeze({ status: "NOT_CONFIRMED" }); }
    }
  });
  await runtime.initialize(70_000);

  const result = await runtime.processTrade(trade(67_200, 1));
  assert.equal(result.status, "NOT_CONFIRMED");
  const state = await store.load();
  assert.equal(state.version, 0);
  assert.equal(state.referencePrice, 70_000);
  assert.equal(state.buyCount, 0);
});

test("deterministic replay exercises three buys and opposite-side reset without waiting for market movement", async () => {
  const store = createMemoryStore();
  const runtime = createGridRuntime({
    stateStore: store,
    getRiskSnapshot: async () => BASE_RISK,
    execution: liveExecution()
  });
  await runtime.initialize(70_000);

  assert.equal((await runtime.processTrade(trade(67_200, 1))).intent.tag, "BUY1");
  assert.equal((await runtime.processTrade(trade(61_152, 2))).intent.tag, "BUY2");
  assert.equal((await runtime.processTrade(trade(55_036.8, 3))).intent.tag, "BUY3");
  let state = await store.load();
  assert.equal(state.buyCount, 3);
  assert.equal(state.buyPtr, 3);

  assert.equal((await runtime.processTrade(trade(57_100.68, 4))).intent.tag, "SELL1");
  state = await store.load();
  assert.equal(state.buyCount, 0);
  assert.equal(state.buyPtr, 0);
  assert.equal(state.sellCount, 1);
  assert.equal(state.referencePrice, 57_100.68);
});

test("daily or maximum-loss floor takes protective precedence even with no grid intent", async () => {
  const store = createMemoryStore();
  const runtime = createGridRuntime({
    stateStore: store,
    getRiskSnapshot: async () => ({ ...BASE_RISK, liveEquity: 46_900 }),
    execution: liveExecution()
  });
  await runtime.initialize(70_000);

  const result = await runtime.processTrade(trade(69_900, 5));
  assert.equal(result.status, "PROTECTIVE_FILLED");
  const state = await store.load();
  assert.equal(state.version, 1);
  assert.equal(state.referencePrice, 65_000);
  assert.equal(state.lastFillSide, "PROTECTIVE_FLAT");
  assert.equal(state.buyCount, 0);
  assert.equal(state.sellCount, 0);
});
