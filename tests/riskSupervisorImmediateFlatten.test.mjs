import test from "node:test";
import assert from "node:assert/strict";
import { createRiskSupervisor } from "../src/risk/riskSupervisor.js";

// Owner decision, 2026-09-21: at the full-flatten threshold the bot flattens
// immediately. It previously started a 25-minute halt-warning cycle and skipped
// the cut tiers until it came due. On the $10,000 account the flatten (-$250)
// sits $50 above a daily limit Tradeify enforces on intraday equity the moment
// it is touched, so any wait there is fatal.

// The decided $10,000 ladder (handoff §6.0). Also proves the constructor's
// validation accepts it: tiers strictly decreasing, deepest tier before the
// flatten, flatten before the limit.
const TEN_K = Object.freeze({
  entryBrakeUsd: 120,
  cutTiers: [{ thresholdUsd: 150, fraction: 0.2 }, { thresholdUsd: 100, fraction: 0.1 }],
  partialCutUsd: 200,
  partialCutFraction: 0.5,
  fullFlattenUsd: 250,
  dailyLossLimitUsd: 300
});

function book(instrument, { unrealised = 0, day = 0 } = {}) {
  const calls = [];
  return {
    instrument,
    calls,
    getUnrealisedUsd: () => unrealised,
    getDayPnlUsd: () => day,
    getExposureUsd: () => 1,
    setEntryBrake(on) { calls.push(["brake", on]); },
    async executeProtectiveCut(args) { calls.push(["cut", args]); return { status: "FILLED" }; },
    async executeProtectiveFlatten(args) { calls.push(["flatten", args]); return { status: "FILLED" }; }
  };
}

function supervisor({ books, combined, warnings, enqueued }) {
  return createRiskSupervisor({
    config: TEN_K,
    instruments: books,
    getCombinedDayPnlUsd: () => combined,
    // index.mjs still passes this. It must no longer be consulted.
    requestHaltWarning: async (input) => { warnings.push(input); return { status: "WARNING_STARTED" }; },
    notifications: { enqueue: (event) => enqueued.push(event) }
  });
}

test("the $10K ladder passes constructor validation", () => {
  assert.doesNotThrow(() => createRiskSupervisor({ config: TEN_K, instruments: [book("SOL/USD")] }));
});

test("at -$250 every book is flattened immediately and no warning cycle starts", async () => {
  const sol = book("SOL/USD", { unrealised: -140, day: -150 });
  const inj = book("INJ/USD", { unrealised: -90, day: -101 });
  const warnings = [];
  const enqueued = [];
  const result = await supervisor({ books: [sol, inj], combined: -251, warnings, enqueued })
    .evaluate({ dayKey: "2026-09-21" });

  assert.equal(result.action, "FLATTEN");
  assert.equal(warnings.length, 0, "the halt-warning cycle must not be started");
  assert.ok(sol.calls.some(([kind]) => kind === "flatten"));
  assert.ok(inj.calls.some(([kind]) => kind === "flatten"));
  assert.ok(sol.calls.some(([kind, on]) => kind === "brake" && on === true), "entries are braked");

  const alert = enqueued.find((e) => e.kind === "SAFETY_HALT");
  assert.equal(alert?.reasonCode, "D060_ACCOUNT_FULL_FLATTEN", "the owner is told after the flatten");
});

test("exactly at the threshold counts as reached", async () => {
  const sol = book("SOL/USD", { unrealised: -250, day: -250 });
  const result = await supervisor({ books: [sol], combined: -250, warnings: [], enqueued: [] })
    .evaluate({ dayKey: "2026-09-21" });
  assert.equal(result.action, "FLATTEN");
});

test("the flatten fires once per day, not on every tick", async () => {
  const sol = book("SOL/USD", { unrealised: -260, day: -260 });
  const risk = supervisor({ books: [sol], combined: -260, warnings: [], enqueued: [] });
  assert.equal((await risk.evaluate({ dayKey: "2026-09-21" })).action, "FLATTEN");
  assert.equal((await risk.evaluate({ dayKey: "2026-09-21" })).action, "ALREADY_FLATTENED");
  assert.equal(sol.calls.filter(([kind]) => kind === "flatten").length, 1);
});

test("above the threshold the cut tiers still run", async () => {
  const sol = book("SOL/USD", { unrealised: -160, day: -160 });
  const warnings = [];
  const result = await supervisor({ books: [sol], combined: -160, warnings, enqueued: [] })
    .evaluate({ dayKey: "2026-09-21" });
  assert.equal(result.action, "CUT");
  assert.equal(result.tier.thresholdUsd, 150);
  assert.equal(warnings.length, 0);
  assert.equal(sol.calls.some(([kind]) => kind === "flatten"), false);
});
