import test from "node:test";
import assert from "node:assert/strict";
import { runDxtradePreflight, DXTRADE_PREFLIGHT_POLICY } from "../src/execution/dxtradePreflight.js";

test("preflight finds the smallest passing cash probe and never places an order", async () => {
  const validations = [];
  let loginCalls = 0;
  let placementCalls = 0;

  const client = {
    async login() {
      loginCalls += 1;
      return { authenticated: true };
    },
    async validateMarketCashOrder(input) {
      validations.push({ ...input });
      if (input.cashQuantity < 10) {
        const error = new Error("minimum size");
        error.status = 400;
        error.apiCode = "MIN_SIZE";
        throw error;
      }
      return { valid: true };
    },
    async placeMarketCashOrder() {
      placementCalls += 1;
      throw new Error("preflight must never place an order");
    }
  };

  const result = await runDxtradePreflight({
    client,
    wait: async () => {}
  });

  assert.equal(loginCalls, 1);
  assert.equal(placementCalls, 0);
  assert.equal(result.validationOnly, true);
  assert.equal(result.instrument, "BTC/USD");
  assert.equal(result.smallestPassingCash, 10);
  assert.deepEqual(result.probes.map((probe) => probe.amount), [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10]);
  assert.equal(result.probes.at(-1).ok, true);
  assert.equal(result.gridBuy.amount, 250);
  assert.equal(result.gridBuy.side, "BUY");
  assert.equal(result.gridBuy.ok, true);
  assert.equal(result.gridSell.amount, 250);
  assert.equal(result.gridSell.side, "SELL");
  assert.equal(result.gridSell.ok, true);
  assert.equal(validations.some((item) => item.orderSide === "SELL" && item.cashQuantity === 250), true);
});

test("preflight reports no passing size when every validation rejects", async () => {
  const client = {
    async login() {
      return { authenticated: true };
    },
    async validateMarketCashOrder() {
      const error = new Error("rejected");
      error.status = 400;
      error.apiCode = "MIN_SIZE";
      throw error;
    }
  };

  const result = await runDxtradePreflight({ client, wait: async () => {} });
  assert.equal(result.smallestPassingCash, null);
  assert.equal(result.probes.length, DXTRADE_PREFLIGHT_POLICY.cashProbes.length);
  assert.equal(result.gridBuy.ok, false);
  assert.equal(result.gridSell.ok, false);
});
