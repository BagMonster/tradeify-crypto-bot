import test from "node:test";
import assert from "node:assert/strict";
import { createSolanaExecutionGuard } from "../src/execution/solanaExecutionGuard.js";

function persistenceMap() {
  const orders = new Map();
  return {
    orders,
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
}

function clientStub({ positions, onPartial, onClose, onPlaceMarket, afterClosePositions = [] }) {
  let closed = false;
  return {
    getOpenPositions: async () => ({ positions: closed ? afterClosePositions : positions }),
    placeMarketQuantityOrder: async (request) => {
      if (onPlaceMarket) onPlaceMarket(request);
      return { orderId: "open-1" };
    },
    placePositionPartialClose: async (request) => {
      if (onPartial) onPartial(request);
      return { orderId: "partial-1" };
    },
    placePositionClose: async (request) => {
      if (onClose) onClose(request);
      closed = true;
      return { orderId: "close-1" };
    },
    reconcileQuantityOrder: async ({ requestedQuantity }) => ({
      status: "FILLED",
      fillPrice: 95.5,
      filledQuantity: requestedQuantity,
      filledAt: "2026-08-30T12:00:00.000Z"
    })
  };
}

function guardFor({ client, adapterPlace }) {
  return createSolanaExecutionGuard({
    autoExecute: true,
    strategyAutoExecute: true,
    protectiveOrdersBypassSlippageCap: true,
    adapter: {
      place: async (request) => {
        if (adapterPlace) adapterPlace(request);
        return {
          confirmed: true,
          status: "FILLED",
          orderCode: request.orderCode,
          fillPrice: 90,
          filledQuantity: request.quantity,
          filledAt: "2026-08-30T12:00:00.000Z"
        };
      }
    },
    client,
    persistence: persistenceMap()
  });
}

test("tranche EXIT on a short lot uses partial close by position code and does not OPEN", async () => {
  const partials = [];
  const closes = [];
  let adapterCalls = 0;
  const guard = guardFor({
    adapterPlace: () => { adapterCalls += 1; },
    client: clientStub({
      positions: [{ symbol: "SOL/USD", quantity: -0.44, side: "SELL", positionCode: "sol-pos" }],
      onPartial: (request) => partials.push(request),
      onClose: (request) => closes.push(request)
    })
  });

  const result = await guard.executeIntent({
    type: "EXIT",
    strategyId: "sol-outer-heavy-v1",
    stateVersion: 1,
    tag: "SELL2",
    ringTag: "SELL2",
    lotId: "SELL2-V1",
    tranche: 2,
    side: "BUY",
    virtualSide: "SELL",
    quantity: 0.10
  });

  assert.equal(result.status, "FILLED");
  assert.equal(adapterCalls, 0);
  assert.equal(closes.length, 0);
  assert.deepEqual(partials, [{
    orderCode: "SOLGRID-1-SELL2-X2",
    orderSide: "BUY",
    quantity: 0.1,
    positionCode: "sol-pos"
  }]);
});

test("final tranche equal to the whole broker position uses full position close", async () => {
  const partials = [];
  const closes = [];
  const guard = guardFor({
    client: clientStub({
      positions: [{ symbol: "SOL/USD", quantity: -0.44, side: "SHORT", positionCode: "sol-pos" }],
      onPartial: (request) => partials.push(request),
      onClose: (request) => closes.push(request),
      afterClosePositions: []
    })
  });

  const result = await guard.executeIntent({
    type: "EXIT",
    strategyId: "sol-outer-heavy-v1",
    stateVersion: 3,
    tag: "SELL2",
    ringTag: "SELL2",
    lotId: "SELL2-V0",
    tranche: 4,
    side: "BUY",
    virtualSide: "SELL",
    quantity: 0.44
  });

  assert.equal(result.status, "FILLED");
  assert.equal(partials.length, 0);
  assert.deepEqual(closes, [{
    orderCode: "SOLGRID-3-SELL2-X4",
    orderSide: "BUY",
    quantity: 0.44,
    positionCode: "sol-pos"
  }]);
});

test("ENTRY is BLOCKED with zero broker calls when an opposing-side position is open", async () => {
  let adapterCalls = 0;
  let brokerOrders = 0;
  const guard = guardFor({
    adapterPlace: () => { adapterCalls += 1; },
    client: {
      getOpenPositions: async () => ({
        positions: [{ symbol: "SOL/USD", quantity: -0.44, side: "SELL", positionCode: "sol-pos" }]
      }),
      placeMarketQuantityOrder: async () => { brokerOrders += 1; },
      placePositionPartialClose: async () => { brokerOrders += 1; },
      placePositionClose: async () => { brokerOrders += 1; },
      reconcileQuantityOrder: async () => ({ status: "PENDING" })
    }
  });

  const result = await guard.executeIntent({
    type: "ENTRY",
    strategyId: "sol-outer-heavy-v1",
    stateVersion: 1,
    tag: "BUY1",
    ringTag: "BUY1",
    lotId: "BUY1-V1",
    side: "BUY",
    quantity: 0.17
  });

  assert.equal(result.status, "BLOCKED");
  assert.match(result.reason, /opposing/i);
  assert.equal(adapterCalls, 0);
  assert.equal(brokerOrders, 0);
});

test("ENTRY proceeds through the OPEN adapter when only same-side positions are open", async () => {
  const placed = [];
  const guard = guardFor({
    adapterPlace: (request) => placed.push(request),
    client: clientStub({
      positions: [{ symbol: "SOL/USD", quantity: 0.17, side: "BUY", positionCode: "sol-pos" }]
    })
  });

  const result = await guard.executeIntent({
    type: "ENTRY",
    strategyId: "sol-outer-heavy-v1",
    stateVersion: 4,
    tag: "BUY2",
    ringTag: "BUY2",
    lotId: "BUY2-V4",
    side: "BUY",
    quantity: 0.12
  });

  assert.equal(result.status, "FILLED");
  assert.equal(placed.length, 1);
  assert.equal(placed[0].actionType, "ENTRY");
  assert.equal(placed[0].side, "BUY");
  assert.equal(placed[0].quantity, 0.12);
  assert.equal(placed[0].orderCode, "SOLGRID-4-BUY2-E");
});

test("EXIT with no matching-side position returns BLOCKED and sends nothing", async () => {
  let brokerOrders = 0;
  let adapterCalls = 0;
  const guard = guardFor({
    adapterPlace: () => { adapterCalls += 1; },
    client: {
      getOpenPositions: async () => ({
        positions: [{ symbol: "SOL/USD", quantity: 0.20, side: "BUY", positionCode: "position-abc" }]
      }),
      placeMarketQuantityOrder: async () => { brokerOrders += 1; },
      placePositionPartialClose: async () => { brokerOrders += 1; },
      placePositionClose: async () => { brokerOrders += 1; },
      reconcileQuantityOrder: async () => ({ status: "PENDING" })
    }
  });

  const result = await guard.executeIntent({
    type: "EXIT",
    strategyId: "sol-outer-heavy-v1",
    stateVersion: 2,
    tag: "SELL1",
    ringTag: "SELL1",
    lotId: "SELL1-V2",
    tranche: 1,
    side: "BUY",
    virtualSide: "SELL",
    quantity: 0.10
  });

  assert.equal(result.status, "BLOCKED");
  assert.match(result.reason, /No open SHORT/);
  assert.equal(adapterCalls, 0);
  assert.equal(brokerOrders, 0);
});

test("protective flatten closes a long and a short leg with matching close sides", async () => {
  const closes = [];
  let remaining = [
    { symbol: "SOL/USD", quantity: 0.20, side: "BUY", positionCode: "position-abc" },
    { symbol: "SOL/USD", quantity: -0.10, side: "SELL", positionCode: "sol-pos" }
  ];
  const guard = createSolanaExecutionGuard({
    autoExecute: true,
    strategyAutoExecute: true,
    protectiveOrdersBypassSlippageCap: true,
    adapter: { place: async () => { throw new Error("adapter must not run for flatten"); } },
    persistence: persistenceMap(),
    client: {
      getOpenPositions: async () => ({ positions: remaining }),
      placePositionPartialClose: async () => { throw new Error("flatten must use full close"); },
      placePositionClose: async (request) => {
        closes.push(request);
        remaining = remaining.filter((row) => row.positionCode !== request.positionCode);
        return { orderId: `flat-${closes.length}` };
      },
      reconcileQuantityOrder: async ({ requestedQuantity }) => ({
        status: "FILLED",
        fillPrice: 88,
        filledQuantity: requestedQuantity,
        filledAt: "2026-08-30T12:00:00.000Z"
      })
    }
  });

  const result = await guard.executeProtectiveFlatten({ stateVersion: 7, reason: "daily floor" });
  assert.equal(result.status, "FILLED");
  assert.deepEqual(closes, [
    {
      orderCode: "SOLFLAT-7-38241ba0ed7b",
      orderSide: "SELL",
      quantity: 0.2,
      positionCode: "position-abc"
    },
    {
      orderCode: "SOLFLAT-7-76cb1b28ecf2",
      orderSide: "BUY",
      quantity: 0.1,
      positionCode: "sol-pos"
    }
  ]);
});

test("protective flatten returns NOT_FLAT when a position survives filled legs", async () => {
  const guard = guardFor({
    client: clientStub({
      positions: [{ symbol: "SOL/USD", quantity: -0.12, side: "SELL", positionCode: "position-sol-1" }],
      afterClosePositions: [{ symbol: "SOL/USD", quantity: -0.12, side: "SELL", positionCode: "position-sol-1" }]
    })
  });

  const result = await guard.executeProtectiveFlatten({ stateVersion: 7, reason: "daily floor" });
  assert.equal(result.status, "NOT_FLAT");
  assert.equal(result.orderCode, "SOLFLAT-7-c08ef31fe356");
});
