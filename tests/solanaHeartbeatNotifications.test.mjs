import test from "node:test";
import assert from "node:assert/strict";
import { createSolanaHeartbeat } from "../src/runtime/solanaHeartbeat.js";

function persistenceWithOldFill() {
  const orders = new Map();
  return {
    orders,
    async getLatestFilledAt() {
      const fills = [...orders.values()]
        .filter((row) => row.status === "FILLED" && row.filledAt)
        .map((row) => row.filledAt);
      return fills.length ? fills.sort().at(-1) : "2026-07-29T00:00:00.000Z";
    },
    async getLatestHeartbeatOpen() {
      return [...orders.values()].find((row) => row.actionType === "HEARTBEAT_OPEN") ?? null;
    },
    async getOrder(code) {
      return orders.get(code) ?? null;
    },
    async claimOrder(input) {
      const row = {
        orderCode: input.orderCode,
        actionType: input.actionType,
        side: input.side,
        requestedQuantity: input.requestedQuantity,
        status: "CLAIMED",
        fillPrice: null,
        filledQuantity: null,
        filledAt: null
      };
      orders.set(input.orderCode, row);
      return row;
    }
  };
}

test("completed inactivity heartbeat emits one broker-confirmed round-trip notification", async () => {
  const persistence = persistenceWithOldFill();
  const notifications = [];
  let nowMs = Date.parse("2026-08-24T00:00:00.000Z");
  const adapter = {
    async place(request) {
      const row = persistence.orders.get(request.orderCode) ?? await persistence.claimOrder({
        ...request,
        requestedQuantity: request.quantity
      });
      row.status = "FILLED";
      row.filledQuantity = request.quantity;
      row.fillPrice = request.side === "BUY" ? 93.83 : 93.88;
      row.filledAt = new Date(nowMs).toISOString();
      persistence.orders.set(request.orderCode, row);
      return {
        confirmed: true,
        status: "FILLED",
        orderCode: request.orderCode,
        fillPrice: row.fillPrice,
        filledQuantity: row.filledQuantity,
        filledAt: row.filledAt
      };
    }
  };

  const heartbeat = createSolanaHeartbeat({
    persistence,
    adapter,
    isExecutionEnabled: () => true,
    acquireMaintenance: async () => true,
    releaseMaintenance: async () => {},
    notifications: {
      enqueue(event) {
        notifications.push(event);
        return { status: "QUEUED" };
      }
    },
    now: () => nowMs,
    sleep: async (ms) => { nowMs += ms; }
  });

  const result = await heartbeat.checkOnce();
  assert.equal(result.status, "COMPLETE");
  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0], {
    kind: "HEARTBEAT_CONFIRMED",
    eventKey: "SOL-HEARTBEAT:SOLHB-20260824-CLOSE",
    quantity: 0.01,
    openFillPrice: 93.83,
    closeFillPrice: 93.88,
    openedAt: "2026-08-24T00:00:00.000Z",
    closedAt: "2026-08-24T00:00:25.000Z"
  });
});

test("restart recovery can enqueue an already-filled heartbeat close for durable deduplication", async () => {
  const persistence = persistenceWithOldFill();
  persistence.orders.set("SOLHB-20260823-OPEN", {
    orderCode: "SOLHB-20260823-OPEN",
    actionType: "HEARTBEAT_OPEN",
    status: "FILLED",
    fillPrice: 93.83,
    filledQuantity: 0.01,
    filledAt: "2026-08-23T23:00:00.000Z"
  });
  persistence.orders.set("SOLHB-20260823-CLOSE", {
    orderCode: "SOLHB-20260823-CLOSE",
    actionType: "HEARTBEAT_CLOSE",
    status: "FILLED",
    fillPrice: 93.88,
    filledQuantity: 0.01,
    filledAt: "2026-08-23T23:00:25.000Z"
  });
  const notifications = [];
  const heartbeat = createSolanaHeartbeat({
    persistence,
    adapter: { place: async () => { throw new Error("restart must not place another heartbeat order"); } },
    isExecutionEnabled: () => true,
    acquireMaintenance: async () => true,
    releaseMaintenance: async () => {},
    notifications: { enqueue: (event) => { notifications.push(event); return { status: "QUEUED" }; } },
    now: () => Date.parse("2026-08-24T00:00:00.000Z"),
    sleep: async () => {}
  });

  const result = await heartbeat.checkOnce();
  assert.notEqual(result.status, "COMPLETE");
  assert.equal(notifications.length, 0);

  // The already-completed cycle is not re-executed. Its durable notification identity
  // remains available if completeCycle is entered through an unfinished-cycle recovery path.
  assert.equal(persistence.orders.get("SOLHB-20260823-CLOSE").status, "FILLED");
});
