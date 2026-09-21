import test from "node:test";
import assert from "node:assert/strict";
import { createRingExecutionGuard } from "../src/execution/ringExecutionGuard.js";
import { formatLiveTelegramNotification } from "../src/notifications/liveTelegramNotifications.js";

// On 2026-09-19 a dead DXtrade session blocked dozens of entries and exits. Each
// one wrote an ERROR row and none reached the owner. These tests pin the fix: one
// alert when an outage starts, a count while it lasts, one recovery alert when a
// broker read succeeds again.

function guard({ readFails, enqueued, withNotifications = true }) {
  return createRingExecutionGuard({
    instrument: "INJ/USD",
    orderPrefix: "INJGRID",
    strategyId: "injgrid-ring-grid-v1",
    lotStep: 0.01,
    autoExecute: true,
    strategyAutoExecute: true,
    adapter: {
      async place(request) {
        return { confirmed: true, status: "FILLED", orderCode: request.orderCode, fillPrice: 12.5, filledQuantity: request.quantity, filledAt: "2026-09-21T10:00:00.000Z" };
      }
    },
    client: {
      async getOpenPositions() {
        if (readFails()) throw new Error("HTTP 401, code 1: Authorization required");
        return { positions: [] };
      },
      async placePositionClose() { return {}; },
      async placePositionPartialClose() { return {}; },
      async reconcileQuantityOrder() { return { status: "PENDING" }; }
    },
    persistence: { async claimOrder() { return {}; }, async getOrder() { return null; } },
    ...(withNotifications ? { notifications: { enqueue: (event) => enqueued.push(event) } } : {})
  });
}

let version = 0;
function entry() {
  version += 1;
  return { type: "ENTRY", stateVersion: version, tag: "SELL2", ringTag: "SELL2", side: "SELL", quantity: 1 };
}
function exit() {
  version += 1;
  return { type: "EXIT", stateVersion: version, tag: "SELL2", ringTag: "SELL2", lotId: `SELL2-V${version}`, tranche: 1, side: "BUY", virtualSide: "SELL", quantity: 1 };
}

test("an outage sends one alert, counts blocked actions, and one recovery alert", async () => {
  let failing = true;
  const enqueued = [];
  const g = guard({ readFails: () => failing, enqueued });

  assert.equal((await g.executeIntent(exit())).status, "ACCOUNT_DATA_UNAVAILABLE");
  assert.equal((await g.executeIntent(entry())).status, "ACCOUNT_DATA_UNAVAILABLE");
  assert.equal((await g.executeIntent(exit())).status, "ACCOUNT_DATA_UNAVAILABLE");

  const blocked = enqueued.filter((e) => e.kind === "EXECUTION_BLOCKED");
  assert.equal(blocked.length, 1, "one alert per outage, not one per blocked action");
  assert.equal(blocked[0].path, "EXIT", "the alert names the path that failed first");
  assert.equal(blocked[0].instrument, "INJ/USD");

  failing = false;
  assert.equal((await g.executeIntent(entry())).status, "FILLED");

  const recovered = enqueued.filter((e) => e.kind === "EXECUTION_RECOVERED");
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].blockedCount, 3);
  assert.ok(recovered[0].outageMs >= 0);

  // Both alerts must survive the real formatter, or notify() drops them silently.
  for (const event of [blocked[0], recovered[0]]) assert.doesNotThrow(() => formatLiveTelegramNotification(event));
});

test("a second outage opens a new episode with its own alert", async () => {
  let failing = true;
  const enqueued = [];
  const g = guard({ readFails: () => failing, enqueued });
  await g.executeIntent(entry());
  failing = false;
  await g.executeIntent(entry());
  failing = true;
  await g.executeIntent(entry());
  assert.equal(enqueued.filter((e) => e.kind === "EXECUTION_BLOCKED").length, 2);
});

test("a healthy read with no prior outage sends nothing", async () => {
  const enqueued = [];
  const g = guard({ readFails: () => false, enqueued });
  assert.equal((await g.executeIntent(entry())).status, "FILLED");
  assert.equal(enqueued.length, 0);
});

test("without notifications wired, blocked actions behave exactly as before", async () => {
  const g = guard({ readFails: () => true, enqueued: [], withNotifications: false });
  const result = await g.executeIntent(entry());
  assert.equal(result.status, "ACCOUNT_DATA_UNAVAILABLE");
});

test("a throwing notifier cannot break the execution path", async () => {
  const g = createRingExecutionGuard({
    instrument: "INJ/USD",
    orderPrefix: "INJGRID",
    strategyId: "injgrid-ring-grid-v1",
    autoExecute: true,
    strategyAutoExecute: true,
    adapter: { async place() { throw new Error("must not be reached"); } },
    client: {
      async getOpenPositions() { throw new Error("HTTP 401"); },
      async placePositionClose() { return {}; },
      async placePositionPartialClose() { return {}; },
      async reconcileQuantityOrder() { return { status: "PENDING" }; }
    },
    persistence: { async claimOrder() { return {}; }, async getOrder() { return null; } },
    notifications: { enqueue() { throw new Error("telegram down"); } }
  });
  assert.equal((await g.executeIntent(entry())).status, "ACCOUNT_DATA_UNAVAILABLE");
});
