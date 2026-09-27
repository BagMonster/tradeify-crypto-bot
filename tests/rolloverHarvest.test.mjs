import test from "node:test";
import assert from "node:assert/strict";
import { buildProportionalRolloverHarvestPlan } from "../src/risk/rolloverHarvest.js";
import { createRingGrid } from "../src/strategies/ringGrid.js";
import { buildGridDefinition } from "../src/strategies/ringGridDefinition.js";
import { createRingGridInstance } from "../src/runtime/ringGridInstance.js";

function candidate({ lotId, entryPrice, markPrice, units }) {
  return {
    instrument: "SOL/USD",
    lotId,
    ringTag: "BUY1",
    positionCode: `DX-${lotId}`,
    virtualSide: "BUY",
    entryPrice,
    markPrice,
    remainingUnits: units,
    lotStep: 0.01,
    openedAt: "2026-09-24T21:59:59.000Z"
  };
}

test("rollover harvest divides the $33 profit target proportionally without exceeding it", () => {
  const plan = buildProportionalRolloverHarvestPlan({
    dayKey: "2026-09-25",
    thresholdUsd: 33,
    candidates: [
      candidate({ lotId: "one", entryPrice: 100, markPrice: 110, units: 4 }), // +$40
      candidate({ lotId: "two", entryPrice: 100, markPrice: 110, units: 2 })  // +$20
    ]
  });
  assert.equal(plan.totalUnrealisedPnlUsd, 60);
  assert.equal(plan.allocations.length, 2);
  assert.ok(plan.plannedUsd <= 33 + 1e-8);
  assert.ok(Math.abs(plan.allocations[0].estimatedProfitUsd / plan.allocations[1].estimatedProfitUsd - 2) < 0.03);
});

test("rollover harvest excludes a lot opened at the new account-day boundary", () => {
  assert.throws(() => buildProportionalRolloverHarvestPlan({
    dayKey: "2026-09-25",
    thresholdUsd: 33,
    candidates: [{ ...candidate({ lotId: "new", entryPrice: 100, markPrice: 110, units: 4 }), openedAt: "2026-09-24T22:00:00.000Z" }]
  }), /not pre-rollover inventory/);
});

test("runtime sends an exact-ticket partial close and leaves the remaining ring lot open", async () => {
  const raw = {
    instrument: "SOL/USD",
    marketSymbol: "SOLUSDT",
    orderPrefix: "TEST",
    geometry: { maDays: 200, bandPct: 0.1, deadZoneBands: 0, activeLevelsPerSide: 1, growth: 1.2, innerLevels: 0, innerPositionsPerRing: 1, outerPositionsPerRing: 1, rearmBands: 0.5 },
    sizing: { capUsd: 1000, lotStep: 0.01, roundTripCostFloorPct: 0.001 },
    tranches: { weights: [1, 2, 3, 4], denominator: 10 }
  };
  const grid = createRingGrid(buildGridDefinition(raw));
  let state = structuredClone(grid.createInitialState());
  const ring = state.rings.find((item) => item.tag === "BUY1");
  ring.lots.push({ id: "old-lot", side: "BUY", ringTag: "BUY1", entryPrice: 100, originalUnits: 4, intendedUnits: 4, remainingUnits: 4, done: 0, normalExitTranches: 0, openedAt: "2026-09-24T21:00:00.000Z", positionCode: "DX-OLD" });
  ring.armed = false;
  state = grid.normalizeState(state);
  const calls = [];
  const instance = createRingGridInstance({
    grid,
    stateStore: {
      async init() {},
      async load() { return state; },
      async initializeIfMissing(value) { state ??= value; return state; },
      async save(version, value) { assert.equal(version, state.version); state = value; return state; }
    },
    maProvider: { async getCurrent() { return { ma: 100 }; } },
    execution: {
      isEnabled: () => true,
      async executeIntent() { throw new Error("not expected"); },
      async executeProtectiveCut() { throw new Error("not expected"); },
      async executeProtectiveFlatten() { throw new Error("not expected"); },
      async executeRolloverHarvestClose(input) {
        calls.push(input);
        return { status: "FILLED", orderCode: "RHV", fillPrice: 110, filledQuantity: input.quantity, filledAt: "2026-09-25T01:00:00.000Z" };
      }
    }
  });
  await instance.init();
  const result = await instance.executeRolloverHarvest({
    dayKey: "2026-09-25",
    allocations: [{ instrument: "SOL/USD", lotId: "old-lot", positionCode: "DX-OLD", virtualSide: "BUY", remainingUnits: 4, quantity: 1.5 }]
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].positionCode, "DX-OLD");
  assert.equal(result.closed[0].realizedPnlUsd, 15);
  assert.equal(state.rings.find((item) => item.tag === "BUY1").lots[0].remainingUnits, 2.5);
});
