import test from "node:test";
import assert from "node:assert/strict";
import { createRingExecutionGuard } from "../src/execution/ringExecutionGuard.js";

function lockedGuard(instrument, orderPrefix) {
  return createRingExecutionGuard({
    instrument,
    orderPrefix,
    strategyId: orderPrefix.toLowerCase() + "-ring-grid-v1",
    lotStep: 0.01,
    autoExecute: false,
    strategyAutoExecute: false,
    adapter: { async place() { throw new Error("must stay locked"); } },
    client: {
      async getOpenPositions() { return { positions: [] }; },
      async placePositionClose() { return {}; },
      async placePositionPartialClose() { return {}; },
      async reconcileQuantityOrder() { return { status: "PENDING" }; }
    },
    persistence: { async claimOrder() { return {}; }, async getOrder() { return null; } }
  });
}

test("D-060 guards derive collision-free instrument order codes while locked", async () => {
  const intent = { type: "ENTRY", stateVersion: 4, tag: "SELL2", ringTag: "SELL2", side: "SELL", quantity: 1 };
  const [doge, sol] = await Promise.all([
    lockedGuard("DOGE/USD", "DOGE").executeIntent(intent),
    lockedGuard("SOL/USD", "SOL").executeIntent(intent)
  ]);
  assert.equal(doge.orderCode, "DOGEGRID-4-SELL2-E");
  assert.equal(sol.orderCode, "SOLGRID-4-SELL2-E");
  assert.equal(doge.status, "BLOCKED");
});
