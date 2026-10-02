import test from "node:test";
import assert from "node:assert/strict";
import { createRingGrid } from "../src/strategies/ringGrid.js";
import { classifyBook, VERDICT } from "../src/runtime/hybridReconciler.js";
import { runReconciliationPass } from "../src/runtime/hybridAbsorber.js";

const INSTRUMENT = "AAVE/USD";
const POSITION_CODE = "aave-short-1";
const FILLED_AT = "2026-09-29T11:41:55.000Z";

function grid() {
  return createRingGrid({
    strategyId: "aave-test-grid",
    instrument: INSTRUMENT,
    marketSymbol: "AAVEUSDT",
    orderPrefix: "AAVE",
    geometry: { maDays: 200, bandPct: 0.01, deadZoneBands: 1, activeLevelsPerSide: 1, growth: 1, innerLevels: 0, innerPositionsPerRing: 1, outerPositionsPerRing: 1, rearmBands: 0.5 },
    sizing: { lotStep: 0.01, capUsd: 1000, roundTripCostFloorPct: 0.001 },
    tranches: { weights: [1, 1, 1, 1], denominator: 4 }
  });
}

function botClose(quantity = 0.8) {
  return {
    instrument: INSTRUMENT,
    status: "COMPLETED",
    finalStatus: true,
    side: "BUY",
    transactionTime: FILLED_AT,
    audit: { userAgent: "node" },
    legs: [{ positionCode: POSITION_CODE, positionEffect: "CLOSE", filledQuantity: quantity, averagePrice: 100 }]
  };
}

test("a broker-confirmed bot CLOSE exactly explaining a stale virtual lot is recoverable", () => {
  const decision = classifyBook(
    { instrument: INSTRUMENT, ok: true, virtualNet: -1, brokerNet: -0.2 },
    [botClose()]
  );

  assert.equal(decision.verdict, VERDICT.ABSORB);
  assert.equal(decision.fills.length, 1);
  assert.equal(decision.fills[0].effect, "CLOSE");
  assert.equal(decision.fills[0].origin, "BOT");
});

test("replayed bot close requires a fresh matching pass before a hybrid halt may clear", async () => {
  const instance = grid();
  let state = instance.adoptPosition(instance.createInitialState(), {
    positionCode: POSITION_CODE,
    side: "SELL",
    entryPrice: 100,
    originalUnits: 1,
    remainingUnits: 1,
    openedAt: "2026-09-29T10:00:00.000Z",
    ma: 100
  });
  const savedWatermarks = {};
  const store = {
    async load() { return state; },
    async save(expectedVersion, next) {
      assert.equal(expectedVersion, state.version);
      state = next;
    }
  };
  const deps = {
    inspectBooks: async () => [{
      instrument: INSTRUMENT,
      ok: true,
      virtualNet: instance.expectedNetUnits(state),
      brokerNet: -0.2
    }],
    recentOrders: async () => [botClose()],
    knownClientOrderIds: async () => new Set(),
    loadWatermarks: async () => savedWatermarks,
    saveWatermark: async (watermark) => { savedWatermarks[watermark.instrument] = watermark; },
    books: { [INSTRUMENT]: { grid: instance, stateStore: store, movingAverage: async () => 100 } }
  };

  const recovered = await runReconciliationPass(deps);
  assert.equal(recovered.escalations.length, 0);
  assert.equal(recovered.absorbed[0].result, "APPLIED");
  assert.equal(recovered.recheckRequired, true);
  assert.equal(instance.expectedNetUnits(state), -0.2);

  const verified = await runReconciliationPass(deps);
  assert.equal(verified.escalations.length, 0);
  assert.equal(verified.recheckRequired, false);
  assert.deepEqual(verified.matched, [INSTRUMENT]);
});

test("a bot OPEN remains unexplained and cannot be adopted automatically", () => {
  const order = { ...botClose(), side: "SELL", legs: [{ positionCode: POSITION_CODE, positionEffect: "OPEN", filledQuantity: 0.8, averagePrice: 100 }] };
  const decision = classifyBook(
    { instrument: INSTRUMENT, ok: true, virtualNet: 0, brokerNet: -0.8 },
    [order]
  );
  assert.equal(decision.verdict, VERDICT.UNEXPLAINED);
});


test("sub-lot floating-point residual is a match", () => {
  const decision = classifyBook({
    instrument: "PEPE/USD",
    ok: true,
    virtualNet: -40054738.24,
    brokerNet: -40054738.240000015
  });

  assert.equal(decision.verdict, VERDICT.MATCH);
  assert.equal(decision.delta, 0);
});

test("a tradable net difference remains unexplained", () => {
  const decision = classifyBook({
    instrument: "PEPE/USD",
    ok: true,
    virtualNet: 0,
    brokerNet: 0.01
  });

  assert.equal(decision.verdict, VERDICT.UNEXPLAINED);
  assert.match(decision.reason, /does not match/);
});
