import test from "node:test";
import assert from "node:assert/strict";
import { createHaltWarningCycle } from "../src/state/haltWarningCycle.js";

function memoryStore() {
  let row = null;
  return {
    async get() { return row; },
    async save(value) { row = Object.freeze({ ...value }); return row; },
    async clear(key) { if (!row || row.key !== key) return false; row = null; return true; }
  };
}

function request() {
  return {
    key: "RECONCILIATION_MISMATCH:INJ",
    reasonCode: "RECONCILIATION_MISMATCH",
    instrument: "INJ/USD",
    reason: "INJ virtual net does not match DXtrade net.",
    correction: "Inspect /status and DXtrade, then send /pausehalt to defer the pending halt."
  };
}

test("non-harvest halt warning cycle emits five five-minute warnings before firing", async () => {
  let now = Date.parse("2026-09-09T12:00:00.000Z");
  const events = [];
  const alerts = [];
  const fired = [];
  const controller = createHaltWarningCycle({
    store: memoryStore(),
    now: () => now,
    addEvent: async (...event) => events.push(event),
    notifications: { enqueue: (event) => alerts.push(event) },
    onDue: async (cycle) => { fired.push(cycle); return { action: "HALT" }; }
  });

  assert.equal((await controller.request(request())).action, "WARNING_1");
  for (let warning = 2; warning <= 5; warning += 1) {
    now += 5 * 60 * 1000;
    assert.equal((await controller.advance()).action, `WARNING_${warning}`);
  }
  assert.equal(fired.length, 0);
  now += 5 * 60 * 1000;
  assert.equal((await controller.advance()).action, "HALTED");
  assert.equal(fired.length, 1);
  assert.equal(alerts.length, 5);
  assert.deepEqual(alerts.map((event) => event.warningNumber), [1, 2, 3, 4, 5]);
  assert.equal(events.filter(([, kind]) => kind === "HALT_WARNING").length, 5);
});

test("pausehalt restarts the same pending halt at warning one for another 25 minutes", async () => {
  let now = Date.parse("2026-09-09T12:00:00.000Z");
  const controller = createHaltWarningCycle({ store: memoryStore(), now: () => now });
  await controller.request(request());
  now += 10 * 60 * 1000;
  await controller.advance();
  await controller.advance();
  const deferred = await controller.defer();
  assert.equal(deferred.action, "DEFERRED");
  assert.equal(deferred.cycle.warningNumber, 1);
  assert.equal(Date.parse(deferred.cycle.haltAt) - now, 25 * 60 * 1000);
});

test("a recovered condition clears its pending warning cycle without firing a halt", async () => {
  let now = Date.parse("2026-09-09T12:00:00.000Z");
  const controller = createHaltWarningCycle({ store: memoryStore(), now: () => now });
  await controller.request(request());
  assert.equal(await controller.clear("RECONCILIATION_MISMATCH:INJ"), true);
  now += 30 * 60 * 1000;
  assert.equal((await controller.advance()).action, "NONE");
});
