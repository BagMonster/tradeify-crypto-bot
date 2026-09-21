import test from "node:test";
import assert from "node:assert/strict";
import { createExposureGate } from "../src/risk/exposureGate.js";
import { createRingExecutionGuard } from "../src/execution/ringExecutionGuard.js";
import { formatLiveTelegramNotification } from "../src/notifications/liveTelegramNotifications.js";

// Account-wide exposure pool, owner's design (2026-09-17 handoff Part 3.3):
//   SOFT: no new entries while account exposure is at or above it.
//   HARD: a single fill may never take exposure past it.
// Numbers below are the 10k profile's: $2,200 soft, $2,250 hard.

function harness({ broker = 0, observedAtMs = 0 } = {}) {
  const state = { broker, observedAtMs, t: 1_000_000, unavailable: false };
  const enqueued = [];
  const events = [];
  const gate = createExposureGate({
    softUsd: 2200,
    hardUsd: 2250,
    readExposure: () => {
      if (state.unavailable) throw new Error("Broker account data is unavailable");
      return { exposureUsd: state.broker, observedAtMs: state.observedAtMs };
    },
    notifications: { enqueue: (e) => enqueued.push(e) },
    addEvent: async (level, kind, payload) => { events.push({ level, kind, payload }); },
    now: () => state.t
  });
  return { gate, state, enqueued, events };
}

test("below the soft ceiling an entry that fits under the hard ceiling is allowed", () => {
  const { gate } = harness({ broker: 1500 });
  const d = gate.requestEntry({ instrument: "SOL/USD", notionalUsd: 300 });
  assert.equal(d.allowed, true);
  assert.equal(gate.getSnapshot().reservedUsd, 300);
});

test("at or above the soft ceiling every entry is refused, with ONE alert per episode", () => {
  const { gate, enqueued } = harness({ broker: 2200 });
  for (let i = 0; i < 4; i += 1) {
    const d = gate.requestEntry({ instrument: "INJ/USD", notionalUsd: 50 });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, "AT_SOFT_CEILING");
  }
  const closed = enqueued.filter((e) => e.kind === "EXPOSURE_GATE_CLOSED");
  assert.equal(closed.length, 1);
  assert.equal(gate.getSnapshot().refusalsThisEpisode, 4);
});

test("below the soft ceiling, a fill that would cross the hard ceiling is refused without paging", () => {
  const { gate, enqueued } = harness({ broker: 2100 });
  const big = gate.requestEntry({ instrument: "AAVE/USD", notionalUsd: 200 });
  assert.equal(big.allowed, false);
  assert.equal(big.reason, "WOULD_CROSS_HARD_CEILING");
  assert.equal(enqueued.length, 0, "the design working is not an alert");
  const small = gate.requestEntry({ instrument: "AAVE/USD", notionalUsd: 140 });
  assert.equal(small.allowed, true, "a smaller ring that fits is still allowed");
});

test("an entry that lands exactly on the hard ceiling is allowed", () => {
  const { gate } = harness({ broker: 2100 });
  assert.equal(gate.requestEntry({ instrument: "SOL/USD", notionalUsd: 150 }).allowed, true);
});

test("two books racing for the last room: the second is refused", () => {
  // 09-19 was a market-wide move: every book triggered in the same minute. The broker
  // snapshot does not yet show the first fill, so without reservations both would pass.
  const { gate } = harness({ broker: 2000 });
  const first = gate.requestEntry({ instrument: "INJ/USD", notionalUsd: 200 });
  const second = gate.requestEntry({ instrument: "AVAX/USD", notionalUsd: 40 });
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, "AT_SOFT_CEILING");
});

test("the gate reopens once exposure falls below the soft ceiling, and says so once", () => {
  const { gate, state, enqueued } = harness({ broker: 2300 });
  state.t = 1_000_000;
  gate.requestEntry({ instrument: "SOL/USD", notionalUsd: 100 });
  gate.requestEntry({ instrument: "SOL/USD", notionalUsd: 100 });
  state.broker = 1800;
  state.t = 1_000_000 + 42 * 60_000;
  assert.equal(gate.requestEntry({ instrument: "SOL/USD", notionalUsd: 100 }).allowed, true);
  const reopened = enqueued.filter((e) => e.kind === "EXPOSURE_GATE_REOPENED");
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0].refusals, 2);
  assert.equal(reopened[0].closedForMs, 42 * 60_000);
  assert.equal(gate.requestEntry({ instrument: "SOL/USD", notionalUsd: 100 }).allowed, true);
  assert.equal(enqueued.filter((e) => e.kind === "EXPOSURE_GATE_REOPENED").length, 1, "no repeat while open");
});

test("unknown exposure is never treated as zero", () => {
  const { gate, state } = harness({ broker: 0 });
  state.unavailable = true;
  const d = gate.requestEntry({ instrument: "SOL/USD", notionalUsd: 50 });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "ACCOUNT_DATA_UNAVAILABLE");
});

test("an order that never reached the broker releases its reservation at once", () => {
  const { gate } = harness({ broker: 2000 });
  const d = gate.requestEntry({ instrument: "SOL/USD", notionalUsd: 200 });
  gate.settle(d.ticket, { status: "BLOCKED" });
  assert.equal(gate.getSnapshot().reservedUsd, 0);
  assert.equal(gate.requestEntry({ instrument: "SOL/USD", notionalUsd: 150 }).allowed, true);
});

test("a filled entry stays counted until a broker snapshot taken after the fill includes it", () => {
  const { gate, state } = harness({ broker: 1000, observedAtMs: 999_000 });
  const d = gate.requestEntry({ instrument: "SOL/USD", notionalUsd: 500 });
  gate.settle(d.ticket, { status: "FILLED" }); // filled at t = 1,000,000

  // Snapshot still older than the fill: the $500 is counted from the reservation.
  state.t += 500;
  gate.requestEntry({ instrument: "SOL/USD", notionalUsd: 1 }); // triggers a prune pass
  assert.ok(gate.getSnapshot().reservedUsd >= 500);

  // A snapshot fetched after the fill now shows it; the reservation is released.
  state.broker = 1500;
  state.observedAtMs = 1_000_000 + 1_500;
  state.t += 2_000;
  const after = gate.requestEntry({ instrument: "SOL/USD", notionalUsd: 100 });
  assert.equal(after.exposureUsd, 1501, "broker $1,500 + the $1 ticket still held, not double-counting the $500");
});

test("an unsettled or uncertain reservation cannot choke the pool forever", () => {
  const { gate, state } = harness({ broker: 2000 });
  gate.requestEntry({ instrument: "SOL/USD", notionalUsd: 200 }); // never settled
  assert.equal(gate.requestEntry({ instrument: "SOL/USD", notionalUsd: 10 }).allowed, false);
  state.t += 60_000;
  assert.equal(gate.requestEntry({ instrument: "SOL/USD", notionalUsd: 10 }).allowed, true);
});

test("both pool alerts pass the real formatter", () => {
  const { gate, state, enqueued } = harness({ broker: 2210 });
  gate.requestEntry({ instrument: "INJ/USD", notionalUsd: 180 });
  state.broker = 1900;
  state.t += 30 * 60_000;
  gate.requestEntry({ instrument: "INJ/USD", notionalUsd: 100 });
  assert.equal(enqueued.length, 2);
  const closed = formatLiveTelegramNotification(enqueued[0]);
  assert.match(closed.message, /EXPOSURE CEILING REACHED/);
  assert.match(closed.message, /Soft ceiling: \$2200\.00/);
  assert.match(closed.message, /First refused: INJ\/USD entry of \$180\.00/);
  const reopened = formatLiveTelegramNotification(enqueued[1]);
  assert.match(reopened.message, /ENTRIES RESUMED/);
  assert.match(reopened.message, /paused for: 30m 0s/);
});

test("the constructor rejects a soft ceiling at or above the hard ceiling", () => {
  assert.throws(() => createExposureGate({ softUsd: 2250, hardUsd: 2250, readExposure: () => ({}) }), /softUsd must be below hardUsd/);
});

// ---- Inside the real execution guard -------------------------------------------

function guardWith({ gate, placed }) {
  return createRingExecutionGuard({
    instrument: "INJ/USD",
    orderPrefix: "INJGRID",
    strategyId: "inj-ring-grid-v1",
    autoExecute: true,
    strategyAutoExecute: true,
    adapter: {
      async place(request) {
        placed.push(request);
        return { confirmed: true, status: "FILLED", orderCode: request.orderCode, fillPrice: 12, filledQuantity: request.quantity, filledAt: "2026-09-21T10:00:00.000Z" };
      }
    },
    client: {
      async getOpenPositions() { return { positions: [] }; },
      async placePositionClose() { return {}; },
      async placePositionPartialClose() { return {}; },
      async reconcileQuantityOrder() { return { status: "PENDING" }; }
    },
    persistence: { async claimOrder() { return {}; }, async getOrder() { return null; } },
    exposureGate: gate
  });
}

let version = 0;
function entry(quantity, observedPrice) {
  version += 1;
  return { type: "ENTRY", stateVersion: version, tag: "SELL2", ringTag: "SELL2", side: "SELL", quantity, observedPrice };
}

test("the guard refuses an entry at the soft ceiling and never calls the broker", async () => {
  const { gate } = harness({ broker: 2250 });
  const placed = [];
  const result = await guardWith({ gate, placed }).executeIntent(entry(10, 12));
  assert.equal(result.status, "BLOCKED");
  assert.match(result.reason, /AT_SOFT_CEILING/);
  assert.equal(placed.length, 0);
});

test("the guard sizes the check as quantity x observed price and settles the fill", async () => {
  const { gate } = harness({ broker: 1000 });
  const placed = [];
  const result = await guardWith({ gate, placed }).executeIntent(entry(10, 12)); // $120
  assert.equal(result.status, "FILLED");
  assert.equal(placed.length, 1);
  assert.equal(gate.getSnapshot().reservedUsd, 120, "held until the broker snapshot shows it");
});

test("without a gate configured the guard behaves exactly as before", async () => {
  const placed = [];
  const result = await guardWith({ gate: null, placed }).executeIntent(entry(10, 12));
  assert.equal(result.status, "FILLED");
});
