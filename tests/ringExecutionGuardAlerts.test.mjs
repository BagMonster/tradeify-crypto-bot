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

// ---- 2026-09-22 incident: a refused entry must not retry forever ----------------------
//
// INJ SELL11 was re-sent about twice a second for over an hour. Every attempt came
// back REJECTED without reaching DXtrade (the adapter replayed a stale ledger row
// from the closed $50K account), the reason was never recorded, and each attempt
// reserved $525 of the $2,200 exposure pool.

function rejectingGuard({ enqueued, events, reason = "DXtrade order ended REJECTED" }) {
  let attempts = 0;
  const g = createRingExecutionGuard({
    instrument: "INJ/USD",
    orderPrefix: "INJGRID",
    strategyId: "injgrid-ring-grid-v1",
    lotStep: 0.01,
    autoExecute: true,
    strategyAutoExecute: true,
    adapter: {
      async place() {
        attempts += 1;
        return { confirmed: false, status: "REJECTED", reason };
      }
    },
    client: {
      async getOpenPositions() { return { positions: [] }; },
      async placePositionClose() { return {}; },
      async placePositionPartialClose() { return {}; },
      async reconcileQuantityOrder() { return { status: "PENDING" }; }
    },
    persistence: { async claimOrder() { return {}; }, async getOrder() { return null; } },
    addEvent: async (level, kind, payload) => { events.push({ level, kind, payload }); },
    notifications: { enqueue: (event) => enqueued.push(event) }
  });
  return { guard: g, attempts: () => attempts };
}

// The same ring at the same state version always produces the same order code, which
// is what makes the retry loop possible, so these tests reuse one intent.
const sameRing = () => ({ type: "ENTRY", stateVersion: 70, tag: "SELL11", ringTag: "SELL11", side: "SELL", quantity: 67.28 });

test("a rejected entry records the broker's reason instead of just the status", async () => {
  const events = [];
  const { guard: g } = rejectingGuard({ enqueued: [], events, reason: "Insufficient margin for this order" });
  const result = await g.executeIntent(sameRing());
  assert.equal(result.status, "REJECTED");
  const logged = events.find((e) => e.kind === "RING_ORDER_NOT_CONFIRMED");
  assert.equal(logged.payload.reason, "Insufficient margin for this order");
  assert.equal(logged.payload.consecutiveRejections, 1);
  assert.equal(result.reason, "Insufficient margin for this order");
});

test("the same ring stops being re-sent after three refusals, and alerts once", async () => {
  const enqueued = [];
  const events = [];
  const { guard: g, attempts } = rejectingGuard({ enqueued, events });

  for (let i = 0; i < 3; i += 1) assert.equal((await g.executeIntent(sameRing())).status, "REJECTED");
  assert.equal(attempts(), 3);

  // Every later attempt is refused locally: the broker is not called again.
  for (let i = 0; i < 20; i += 1) {
    const result = await g.executeIntent(sameRing());
    assert.equal(result.status, "BLOCKED", "a latched ring must not reach the broker");
    assert.match(result.reason, /refused this entry/);
  }
  assert.equal(attempts(), 3, "no further orders were sent");

  const blocked = enqueued.filter((e) => e.kind === "EXECUTION_BLOCKED");
  assert.equal(blocked.length, 1, "one alert for the episode, not one per attempt");
  assert.equal(blocked[0].reasonCode, "ORDER_REJECTED");
  assert.equal(blocked[0].instrument, "INJ/USD");
  assert.doesNotThrow(() => formatLiveTelegramNotification(blocked[0]));
  assert.ok(events.some((e) => e.kind === "RING_ENTRY_REJECT_LATCHED"));
});

test("the latch is per order code: a new state version starts clean", async () => {
  const { guard: g, attempts } = rejectingGuard({ enqueued: [], events: [] });
  for (let i = 0; i < 4; i += 1) await g.executeIntent(sameRing());
  assert.equal(attempts(), 3);
  await g.executeIntent({ ...sameRing(), stateVersion: 71 });
  assert.equal(attempts(), 4, "a different order code is tried again");
});

test("a latched entry reports BLOCKED, which releases its exposure-pool reservation", async () => {
  // BLOCKED is in the gate's NEVER_SENT set, so the latch cannot strand pool space.
  const { guard: g } = rejectingGuard({ enqueued: [], events: [] });
  for (let i = 0; i < 3; i += 1) await g.executeIntent(sameRing());
  assert.equal((await g.executeIntent(sameRing())).status, "BLOCKED");
});

// ---- 2026-09-22, second incident: PENDING is not a refusal ---------------------------
//
// The first version of this latch counted any non-fill. Every book then latched on
// PENDING — an order that DID reach DXtrade and had not finished — which stopped the
// adapter re-polling it. A pending order can still fill, so the bot must keep
// watching it. Only a status the broker has settled counts toward the latch.

function statusGuard(statuses, events = []) {
  let attempts = 0;
  const g = createRingExecutionGuard({
    instrument: "DOGE/USD",
    orderPrefix: "DOGEGRID",
    strategyId: "dogegrid-ring-grid-v1",
    lotStep: 0.01,
    autoExecute: true,
    strategyAutoExecute: true,
    adapter: {
      async place(request) {
        const status = statuses[Math.min(attempts, statuses.length - 1)];
        attempts += 1;
        return status === "FILLED"
          ? { confirmed: true, status: "FILLED", orderCode: request.orderCode, fillPrice: 0.1, filledQuantity: request.quantity, filledAt: "2026-09-22T18:00:00.000Z" }
          : { confirmed: false, status };
      }
    },
    client: {
      async getOpenPositions() { return { positions: [] }; },
      async placePositionClose() { return {}; },
      async placePositionPartialClose() { return {}; },
      async reconcileQuantityOrder() { return { status: "PENDING" }; }
    },
    persistence: { async claimOrder() { return {}; }, async getOrder() { return null; } },
    addEvent: async (level, kind, payload) => { events.push({ level, kind, payload }); },
    notifications: { enqueue() {} }
  });
  return { guard: g, attempts: () => attempts };
}

const dogeRing = () => ({ type: "ENTRY", stateVersion: 58, tag: "SELL3", ringTag: "SELL3", side: "SELL", quantity: 100 });

test("PENDING never latches a ring: the order is live and must keep being polled", async () => {
  const events = [];
  const { guard: g, attempts } = statusGuard(["PENDING"], events);
  for (let i = 0; i < 10; i += 1) assert.equal((await g.executeIntent(dogeRing())).status, "PENDING");
  assert.equal(attempts(), 10, "every tick must still reach the adapter");
  assert.equal(events.filter((e) => e.kind === "RING_ENTRY_REJECT_LATCHED").length, 0);
  assert.equal(events.find((e) => e.kind === "RING_ORDER_NOT_CONFIRMED").payload.consecutiveRejections, 0);
});

test("pendings before a refusal do not count toward the latch", async () => {
  // PENDING, PENDING, then REJECTED forever: latched on the third REFUSAL, not the third attempt.
  const { guard: g, attempts } = statusGuard(["PENDING", "PENDING", "REJECTED"]);
  for (let i = 0; i < 5; i += 1) await g.executeIntent(dogeRing());
  assert.equal(attempts(), 5, "two pendings plus three refusals all reached the broker");
  assert.equal((await g.executeIntent(dogeRing())).status, "BLOCKED");
  assert.equal(attempts(), 5);
});

test("a fill clears an earlier refusal count", async () => {
  const { guard: g, attempts } = statusGuard(["REJECTED", "REJECTED", "FILLED", "REJECTED"]);
  for (let i = 0; i < 4; i += 1) await g.executeIntent(dogeRing());
  // Two refusals, a fill resets the count, so the next refusal is number one again.
  assert.equal((await g.executeIntent(dogeRing())).status, "REJECTED");
  assert.equal(attempts(), 5);
});
