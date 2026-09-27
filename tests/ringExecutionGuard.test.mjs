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

test("D-068 reads every live broker ticket for its configured account book", async () => {
  const guard = createRingExecutionGuard({
    instrument: "SOL/USD",
    orderPrefix: "SOL",
    strategyId: "sol-ring-grid-v1",
    lotStep: 0.01,
    autoExecute: false,
    strategyAutoExecute: false,
    adapter: { async place() { throw new Error("not expected"); } },
    client: {
      async getOpenPositions() {
        return { positions: [
          { symbol: "SOL/USD", positionCode: "BOT-TICKET", side: "BUY", quantity: 2, openPrice: 100 },
          { symbol: "SOL/USD", positionCode: "MANUAL-TICKET", side: "BUY", quantity: 3, openPrice: 90 },
          { symbol: "DOGE/USD", positionCode: "OTHER-BOOK", side: "BUY", quantity: 5, openPrice: 1 }
        ] };
      },
      async placePositionClose() { return {}; },
      async placePositionPartialClose() { return {}; },
      async reconcileQuantityOrder() { return { status: "PENDING" }; }
    },
    persistence: { async claimOrder() { return {}; }, async getOrder() { return null; } }
  });
  const candidates = await guard.listRolloverHarvestPositions({ markPrice: 110 });
  assert.deepEqual(candidates.map((candidate) => candidate.positionCode), ["BOT-TICKET", "MANUAL-TICKET"]);
  assert.deepEqual(candidates.map((candidate) => candidate.entryPrice), [100, 90]);
});
