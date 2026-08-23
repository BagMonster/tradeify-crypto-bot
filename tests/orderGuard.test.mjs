import test from "node:test";
import assert from "node:assert/strict";
import { createGuardedExecution, gridOrderCode } from "../src/execution/orderGuard.js";

const INTENT = Object.freeze({
  strategyId: "btc-progressive-reference-reset-grid-v1",
  source: "binance",
  symbol: "BTCUSDT",
  side: "BUY",
  tag: "BUY1",
  levelIndex: 0,
  movePct: 0.04,
  usd: 250,
  observedPrice: 67200,
  referencePrice: 70000,
  stateVersion: 0
});

test("execution stays blocked unless both locks are true", async () => {
  let calls = 0;
  for (const [autoExecute, strategyAutoExecute] of [[false, false], [true, false], [false, true]]) {
    const execution = createGuardedExecution({
      autoExecute,
      strategyAutoExecute,
      placeMarketOrder: async () => { calls += 1; },
      flattenPosition: async () => { calls += 1; }
    });
    const result = await execution.executeGridIntent({ intent: INTENT, quantity: 0.003 });
    assert.equal(result.status, "BLOCKED");
    assert.equal(execution.isEnabled(), false);
  }
  assert.equal(calls, 0);
});

test("deterministic order code binds to state version and grid level", () => {
  assert.equal(gridOrderCode(INTENT), "GRID-0-BUY1");
  assert.equal(gridOrderCode({ ...INTENT, stateVersion: 4, side: "SELL", tag: "SELL2" }), "GRID-4-SELL2");
});

test("broker acknowledgement without confirmed fill never counts as filled", async () => {
  const execution = createGuardedExecution({
    autoExecute: true,
    strategyAutoExecute: true,
    placeMarketOrder: async ({ orderCode }) => ({ confirmed: false, orderCode }),
    flattenPosition: async () => ({ confirmed: false })
  });
  const result = await execution.executeGridIntent({ intent: INTENT, quantity: 0.003 });
  assert.equal(result.status, "NOT_CONFIRMED");
});

test("confirmed fill is returned only with matching order identity, price, and time", async () => {
  const execution = createGuardedExecution({
    autoExecute: true,
    strategyAutoExecute: true,
    placeMarketOrder: async ({ orderCode }) => ({
      confirmed: true,
      orderCode,
      fillPrice: 67195.25,
      filledAt: "2026-08-23T08:00:00.000Z",
      brokerOrderId: "broker-1"
    }),
    flattenPosition: async () => ({ confirmed: false })
  });
  const result = await execution.executeGridIntent({ intent: INTENT, quantity: 0.003 });
  assert.equal(result.status, "FILLED");
  assert.equal(result.orderCode, "GRID-0-BUY1");
  assert.equal(result.fillPrice, 67195.25);
});

test("mismatched broker order identity fails closed", async () => {
  const execution = createGuardedExecution({
    autoExecute: true,
    strategyAutoExecute: true,
    placeMarketOrder: async () => ({
      confirmed: true,
      orderCode: "WRONG",
      fillPrice: 67195.25,
      filledAt: "2026-08-23T08:00:00.000Z"
    }),
    flattenPosition: async () => ({ confirmed: false })
  });
  await assert.rejects(
    execution.executeGridIntent({ intent: INTENT, quantity: 0.003 }),
    /orderCode does not match/i
  );
});

test("protective flatten uses the same live execution boundary", async () => {
  const blocked = createGuardedExecution({
    autoExecute: false,
    strategyAutoExecute: false,
    placeMarketOrder: async () => ({ confirmed: false }),
    flattenPosition: async () => { throw new Error("must not be called"); }
  });
  assert.equal((await blocked.executeProtectiveFlatten({ reason: "Daily-loss floor reached" })).status, "BLOCKED");

  const live = createGuardedExecution({
    autoExecute: true,
    strategyAutoExecute: true,
    placeMarketOrder: async () => ({ confirmed: false }),
    flattenPosition: async () => ({
      confirmed: true,
      fillPrice: 65000,
      filledAt: "2026-08-23T08:05:00.000Z"
    })
  });
  const result = await live.executeProtectiveFlatten({ reason: "Daily-loss floor reached" });
  assert.equal(result.status, "FILLED");
  assert.equal(result.fillPrice, 65000);
});
