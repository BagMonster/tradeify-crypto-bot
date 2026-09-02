import test from "node:test";
import assert from "node:assert/strict";
import {
  ALERT_COUNT,
  ALERT_INTERVAL_MS,
  FILL_GRACE_MS,
  HALT_AFTER_MS,
  nextReconciliationWarning,
  withinFillGrace
} from "../src/runtime/reconciliationWarning.js";

test("a matching tick clears the warning clock", () => {
  const prior = { firstAt: 1_000, lastAlertAt: 1_000, alertsSent: 1 };
  const next = nextReconciliationWarning(prior, { now: 2_000, mismatched: false });
  assert.equal(next.action, "CLEAR");
  assert.equal(next.state, null);
});

test("first mismatch alerts immediately and halt waits 15 minutes", () => {
  const t0 = 1_700_000_000_000;
  const first = nextReconciliationWarning(null, { now: t0, mismatched: true });
  assert.equal(first.action, "ALERT");
  assert.equal(first.alertNumber, 1);

  const mid = nextReconciliationWarning(first.state, { now: t0 + ALERT_INTERVAL_MS - 1, mismatched: true });
  assert.equal(mid.action, "WAIT");

  const second = nextReconciliationWarning(first.state, { now: t0 + ALERT_INTERVAL_MS, mismatched: true });
  assert.equal(second.action, "ALERT");
  assert.equal(second.alertNumber, 2);

  const third = nextReconciliationWarning(second.state, { now: t0 + 2 * ALERT_INTERVAL_MS, mismatched: true });
  assert.equal(third.action, "ALERT");
  assert.equal(third.alertNumber, ALERT_COUNT);

  const beforeHalt = nextReconciliationWarning(third.state, { now: t0 + HALT_AFTER_MS - 1, mismatched: true });
  assert.equal(beforeHalt.action, "WAIT");

  const halt = nextReconciliationWarning(third.state, { now: t0 + HALT_AFTER_MS, mismatched: true });
  assert.equal(halt.action, "HALT");
});

test("fill grace covers 25 seconds and not 25.001", () => {
  const filledAt = "2026-09-02T04:00:00.000Z";
  assert.equal(withinFillGrace({ lastFillAt: filledAt, now: "2026-09-02T04:00:24.999Z" }), true);
  assert.equal(withinFillGrace({ lastFillAt: filledAt, now: "2026-09-02T04:00:25.000Z" }), false);
  assert.equal(FILL_GRACE_MS, 25_000);
});
