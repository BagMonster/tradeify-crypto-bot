import test from "node:test";
import assert from "node:assert/strict";
import { createSolanaHeartbeat } from "../src/runtime/solanaHeartbeat.js";

function memoryPersistence({ latestFilledAt = null } = {}) {
  const orders = new Map();
  return {
    orders,
    async getLatestFilledAt() {
      const fills = [...orders.values()].filter((row) => row.status === "FILLED" && row.filledAt).map((row) => row.filledAt);
      if (fills.length) return fills.sort().at(-1);
      return latestFilledAt;
    },
    async getLatestHeartbeatOpen() {
      return [...orders.values()].filter((row) => row.actionType === "HEARTBEAT_OPEN").at(-1) ?? null;
    },
    async getOrder(code) { return orders.get(code) ?? null; },
    async claimOrder(input) {
      const row = {
        orderCode: input.orderCode,
        strategyId: input.strategyId,
        instrument: input.instrument,
        stateVersion: input.stateVersion,
        actionType: input.actionType,
        side: input.side,
        requestedQuantity: input.requestedQuantity,
        status: "CLAIMED",
        filledAt: null
      };
      orders.set(input.orderCode, row);
      return row;
    }
  };
}

test("heartbeat never places an order while execution is locked", async () => {
  let calls = 0;
  const heartbeat = createSolanaHeartbeat({
    persistence: memoryPersistence({ latestFilledAt: "2026-07-01T00:00:00.000Z" }),
    adapter: { place: async () => { calls += 1; } },
    isExecutionEnabled: () => false,
    acquireMaintenance: async () => true,
    releaseMaintenance: async () => {},
    now: () => Date.parse("2026-08-24T00:00:00.000Z")
  });
  assert.equal((await heartbeat.checkOnce()).status, "LOCKED");
  assert.equal(calls, 0);
});

test("after 25 days heartbeat performs exactly one isolated 0.01 SOL BUY then SELL round trip", async () => {
  const persistence = memoryPersistence({ latestFilledAt: "2026-07-29T00:00:00.000Z" });
  const calls = [];
  let nowMs = Date.parse("2026-08-24T00:00:00.000Z");
  const adapter = {
    async place(request) {
      calls.push({ ...request });
      const row = persistence.orders.get(request.orderCode) ?? await persistence.claimOrder({
        ...request,
        requestedQuantity: request.quantity
      });
      row.status = "FILLED";
      row.filledAt = new Date(nowMs).toISOString();
      row.filledQuantity = request.quantity;
      row.fillPrice = request.side === "BUY" ? 100 : 100.1;
      persistence.orders.set(request.orderCode, row);
      return {
        confirmed: true,
        status: "FILLED",
        orderCode: request.orderCode,
        filledAt: row.filledAt,
        filledQuantity: request.quantity,
        fillPrice: row.fillPrice
      };
    }
  };
  let acquired = 0;
  let released = 0;
  const heartbeat = createSolanaHeartbeat({
    persistence,
    adapter,
    isExecutionEnabled: () => true,
    acquireMaintenance: async () => { acquired += 1; return true; },
    releaseMaintenance: async () => { released += 1; },
    now: () => nowMs,
    sleep: async (ms) => { nowMs += ms; }
  });

  const result = await heartbeat.checkOnce();
  assert.equal(result.status, "COMPLETE");
  assert.equal(acquired, 1);
  assert.equal(released, 1);
  assert.deepEqual(calls.map((x) => [x.actionType, x.side, x.quantity]), [
    ["HEARTBEAT_OPEN", "BUY", 0.01],
    ["HEARTBEAT_CLOSE", "SELL", 0.01]
  ]);
  assert.ok(nowMs >= Date.parse("2026-08-24T00:00:25.000Z"));
});

test("heartbeat resumes an opened cycle before considering a new inactivity cycle", async () => {
  const persistence = memoryPersistence();
  persistence.orders.set("SOLHB-20260823-OPEN", {
    orderCode: "SOLHB-20260823-OPEN",
    actionType: "HEARTBEAT_OPEN",
    status: "FILLED",
    filledAt: "2026-08-23T23:59:00.000Z"
  });
  const calls = [];
  const heartbeat = createSolanaHeartbeat({
    persistence,
    adapter: {
      place: async (request) => {
        calls.push(request);
        const row = {
          orderCode: request.orderCode,
          actionType: request.actionType,
          status: "FILLED",
          filledAt: "2026-08-24T00:00:00.000Z"
        };
        persistence.orders.set(request.orderCode, row);
        return { confirmed: true, status: "FILLED", filledAt: row.filledAt, filledQuantity: 0.01, fillPrice: 100 };
      }
    },
    isExecutionEnabled: () => true,
    acquireMaintenance: async () => true,
    releaseMaintenance: async () => {},
    now: () => Date.parse("2026-08-24T00:00:00.000Z"),
    sleep: async () => {}
  });
  const result = await heartbeat.checkOnce();
  assert.equal(result.status, "COMPLETE");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actionType, "HEARTBEAT_CLOSE");
  assert.equal(calls[0].side, "SELL");
});
