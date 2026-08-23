import test from "node:test";
import assert from "node:assert/strict";
import { createGuardedExecution, gridOrderCode } from "../src/execution/orderGuard.js";

const SOL_INTENT = Object.freeze({
  strategyId: "sol-statistical-grid-v1",
  source: "binance",
  symbol: "SOLUSDT",
  side: "BUY",
  tag: "BUY1",
  levelIndex: 0,
  movePct: 0.04,
  usd: 250,
  observedPrice: 145,
  referencePrice: 151,
  stateVersion: 0
});

test("SOL execution guard uses isolated SOL order identity and DXtrade instrument", async () => {
  let submitted = null;
  const execution = createGuardedExecution({
    autoExecute: true,
    strategyAutoExecute: true,
    instrument: "SOL/USD",
    marketSymbol: "SOLUSDT",
    orderCodePrefix: "SOLGRID",
    placeMarketOrder: async (request) => {
      submitted = request;
      return { confirmed: false, status: "PENDING" };
    },
    flattenPosition: async () => ({ confirmed: false })
  });

  const result = await execution.executeGridIntent({ intent: SOL_INTENT });
  assert.equal(result.orderCode, "SOLGRID-0-BUY1");
  assert.equal(submitted.instrument, "SOL/USD");
  assert.equal(submitted.intent.symbol, "SOLUSDT");
});

test("SOL order code cannot accidentally accept a BTC market intent", () => {
  assert.equal(gridOrderCode(SOL_INTENT, { marketSymbol: "SOLUSDT", orderCodePrefix: "SOLGRID" }), "SOLGRID-0-BUY1");
  assert.throws(() => gridOrderCode({ ...SOL_INTENT, symbol: "BTCUSDT" }, {
    marketSymbol: "SOLUSDT",
    orderCodePrefix: "SOLGRID"
  }), /SOLUSDT/);
});
