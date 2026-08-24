import test from "node:test";
import assert from "node:assert/strict";
import { createSolanaLiveCanary } from "../src/execution/solanaCanary.js";

function createPersistence(initial = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    getOrder: async (code) => rows.get(code) ?? null,
    claimOrder: async (input) => {
      const row = {
        orderCode: input.orderCode,
        strategyId: input.strategyId,
        instrument: input.instrument,
        stateVersion: input.stateVersion,
        actionType: input.actionType,
        side: input.side,
        requestedQuantity: input.requestedQuantity,
        status: "CLAIMED",
        fillPrice: null,
        filledQuantity: null,
        filledAt: null
      };
      rows.set(input.orderCode, row);
      return row;
    },
    markSubmitted: async (code, brokerOrderId) => {
      const row = { ...rows.get(code), status: "SUBMITTED", brokerOrderId };
      rows.set(code, row);
      return row;
    },
    markStatus: async (code, status, details = {}) => {
      const row = { ...rows.get(code), status, ...details };
      rows.set(code, row);
      return row;
    }
  };
}

test("approved SOL canary performs one 0.01 open, hold, exact position close, and flat verification", async () => {
  const persistence = createPersistence();
  const calls = [];
  const filledAt = new Date().toISOString();
  const adapter = {
    place: async (request) => {
      calls.push({ type: "OPEN", request });
      assert.equal(request.actionType, "CANARY_OPEN");
      assert.equal(request.instrument, "SOL/USD");
      assert.equal(request.side, "BUY");
      assert.equal(request.quantity, 0.01);
      persistence.rows.set(request.orderCode, {
        orderCode: request.orderCode,
        strategyId: request.strategyId,
        instrument: request.instrument,
        stateVersion: request.stateVersion,
        actionType: request.actionType,
        side: request.side,
        requestedQuantity: request.quantity,
        status: "FILLED",
        fillPrice: 145.25,
        filledQuantity: 0.01,
        filledAt
      });
      return {
        confirmed: true,
        status: "FILLED",
        fillPrice: 145.25,
        filledQuantity: 0.01,
        filledAt
      };
    }
  };

  let positionRead = 0;
  const client = {
    getOpenPositions: async () => {
      positionRead += 1;
      if (positionRead === 1) return { positions: [] };
      if (positionRead === 2) {
        return { positions: [{ symbol: "SOL/USD", quantity: 0.01, positionCode: "sol-position-1" }] };
      }
      return { positions: [] };
    },
    placePositionClose: async (request) => {
      calls.push({ type: "CLOSE", request });
      return { orderId: 802 };
    },
    reconcileQuantityOrder: async ({ orderCode, requestedQuantity }) => {
      assert.equal(orderCode, "SOLCANARY-V2-CLOSE");
      assert.equal(requestedQuantity, 0.01);
      return {
        status: "FILLED",
        fillPrice: 145.20,
        filledQuantity: 0.01,
        filledAt: new Date().toISOString()
      };
    }
  };

  const sleeps = [];
  const canary = createSolanaLiveCanary({
    adapter,
    client,
    persistence,
    automaticExecutionEnabled: () => false,
    minimumHoldSeconds: 25,
    sleep: async (ms) => { sleeps.push(ms); }
  });

  const result = await canary.run({ stateVersion: 7 });
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.quantity, 0.01);
  assert.ok(sleeps.some((ms) => ms > 24_000 && ms <= 25_000));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], {
    type: "CLOSE",
    request: {
      orderCode: "SOLCANARY-V2-CLOSE",
      orderSide: "SELL",
      quantity: 0.01,
      positionCode: "sol-position-1"
    }
  });
  assert.equal(persistence.rows.get("SOLCANARY-V2-CLOSE").status, "FILLED");
});

test("SOL canary refuses to run while automatic grid execution is enabled", async () => {
  let brokerCalls = 0;
  const canary = createSolanaLiveCanary({
    adapter: { place: async () => { brokerCalls += 1; } },
    client: {
      getOpenPositions: async () => { brokerCalls += 1; return { positions: [] }; },
      placePositionClose: async () => { brokerCalls += 1; },
      reconcileQuantityOrder: async () => ({ status: "PENDING" })
    },
    persistence: createPersistence(),
    automaticExecutionEnabled: () => true
  });

  const result = await canary.run();
  assert.equal(result.status, "BLOCKED");
  assert.equal(brokerCalls, 0);
});

test("completed canary is idempotent and never places a second round trip", async () => {
  const persistence = createPersistence({
    "SOLCANARY-V2-OPEN": {
      orderCode: "SOLCANARY-V2-OPEN",
      status: "FILLED",
      fillPrice: 140,
      filledQuantity: 0.01,
      filledAt: "2026-08-24T02:00:00.000Z"
    },
    "SOLCANARY-V2-CLOSE": {
      orderCode: "SOLCANARY-V2-CLOSE",
      status: "FILLED",
      fillPrice: 140.1,
      filledQuantity: 0.01,
      filledAt: "2026-08-24T02:00:30.000Z"
    }
  });
  let placements = 0;
  const canary = createSolanaLiveCanary({
    adapter: { place: async () => { placements += 1; } },
    client: {
      getOpenPositions: async () => ({ positions: [] }),
      placePositionClose: async () => { placements += 1; },
      reconcileQuantityOrder: async () => ({ status: "PENDING" })
    },
    persistence,
    automaticExecutionEnabled: () => false
  });

  const result = await canary.run();
  assert.equal(result.status, "COMPLETE");
  assert.equal(placements, 0);
});
