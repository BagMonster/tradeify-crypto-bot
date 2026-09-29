import test from "node:test";
import assert from "node:assert/strict";
import { createRiskSupervisor } from "../src/risk/riskSupervisor.js";

const config = {
  entryBrakeUsd: 120,
  partialCutUsd: 200,
  partialCutFraction: 0.50,
  fullFlattenUsd: 250,
  dailyLossLimitUsd: 300,
  cutCooldownMs: 15 * 60 * 1000,
  cutTiers: [
    { thresholdUsd: 100, fraction: 0.10 },
    { thresholdUsd: 150, fraction: 0.20 }
  ]
};

function mutableBook(instrument, state) {
  const calls = [];
  return {
    instrument,
    calls,
    getUnrealisedUsd() { return state.unrealised; },
    getDayPnlUsd() { return state.dayPnl; },
    getExposureUsd() { return 1; },
    setEntryBrake() {},
    async executeProtectiveCut(args) {
      calls.push(["cut", args]);
      return { status: "FILLED" };
    },
    async executeProtectiveFlatten(args) {
      calls.push(["flatten", args]);
      return { status: "FILLED" };
    }
  };
}

function cutFractions(book) {
  return book.calls.filter(([kind]) => kind === "cut").map(([, args]) => args.fraction);
}

test("D-063 selects a tier from total unrealised loss, not realised day loss", async () => {
  let nowMs = 1_000_000;
  let combinedDayPnlUsd = -151.99; // 2026-09-29: loss was already realised; only $1.71 remained open.
  const losingState = { unrealised: -1.71, dayPnl: -1.71 };
  const winningState = { unrealised: 25, dayPnl: 25 };
  const losing = mutableBook("SOL/USD", losingState);
  const winning = mutableBook("DOGE/USD", winningState);
  const supervisor = createRiskSupervisor({
    config,
    instruments: [losing, winning],
    getCombinedDayPnlUsd: () => combinedDayPnlUsd,
    now: () => nowMs
  });

  const result = await supervisor.evaluate({ dayKey: "2026-09-24" });

  assert.equal(result.action, "NONE");
  assert.equal(result.tier, undefined);
  assert.deepEqual(cutFractions(losing), []);
  assert.deepEqual(cutFractions(winning), []);
});

test("D-063 self-clears after a cut, then permits a deeper unrealised-loss escalation", async () => {
  let nowMs = 2_000_000;
  let combinedDayPnlUsd = -101;
  const state = { unrealised: -101, dayPnl: -101 };
  const sol = mutableBook("SOL/USD", state);
  const supervisor = createRiskSupervisor({
    config,
    instruments: [sol],
    getCombinedDayPnlUsd: () => combinedDayPnlUsd,
    now: () => nowMs
  });

  assert.equal((await supervisor.evaluate({ dayKey: "2026-09-24" })).tier.thresholdUsd, 100);
  assert.deepEqual(cutFractions(sol), [0.10]);

  // A confirmed cut reduced the open loss. Realised day loss remains below the
  // old threshold, but that cannot cause another protective cut on its own.
  state.unrealised = -90;
  nowMs += 5 * 60 * 1000;
  assert.equal((await supervisor.evaluate({ dayKey: "2026-09-24" })).action, "NONE");
  assert.deepEqual(cutFractions(sol), [0.10]);

  // A genuinely deeper open loss bypasses the cooldown.
  combinedDayPnlUsd = -151;
  state.unrealised = -151;
  assert.equal((await supervisor.evaluate({ dayKey: "2026-09-24" })).tier.thresholdUsd, 150);
  assert.deepEqual(cutFractions(sol), [0.10, 0.20]);

  state.unrealised = -149;
  nowMs += 5 * 60 * 1000;
  assert.equal((await supervisor.evaluate({ dayKey: "2026-09-24" })).action, "NONE");
  assert.deepEqual(cutFractions(sol), [0.10, 0.20]);

  // A later worsening back through the -$100 open-loss tier waits for the
  // one ladder cooldown, then becomes eligible again.
  combinedDayPnlUsd = -201;
  state.unrealised = -101;
  nowMs += 10 * 60 * 1000;
  assert.equal((await supervisor.evaluate({ dayKey: "2026-09-24" })).tier.thresholdUsd, 100);
  assert.deepEqual(cutFractions(sol), [0.10, 0.20, 0.10]);
});

test("D-063 does not consume a tier cooldown when no open book is losing", async () => {
  let nowMs = 3_000_000;
  const state = { unrealised: 0, dayPnl: 0 };
  const sol = mutableBook("SOL/USD", state);
  const supervisor = createRiskSupervisor({
    config,
    instruments: [sol],
    getCombinedDayPnlUsd: () => -101,
    now: () => nowMs
  });

  assert.equal((await supervisor.evaluate({ dayKey: "2026-09-24" })).action, "NONE");
  assert.equal(supervisor.getSnapshot().cutCooldownRemainingMs, 0);

  state.unrealised = -101;
  nowMs += 60_000;
  assert.equal((await supervisor.evaluate({ dayKey: "2026-09-24" })).action, "CUT");
  assert.deepEqual(cutFractions(sol), [0.10]);
});

test("D-060 full flatten remains ahead of every partial-cut tier", async () => {
  let nowMs = 4_000_000;
  const state = { unrealised: -260, dayPnl: -260 };
  const sol = mutableBook("SOL/USD", state);
  const supervisor = createRiskSupervisor({
    config,
    instruments: [sol],
    getCombinedDayPnlUsd: () => -250,
    now: () => nowMs
  });

  const result = await supervisor.evaluate({ dayKey: "2026-09-24" });
  assert.equal(result.action, "FLATTEN");
  assert.deepEqual(cutFractions(sol), []);
  assert.equal(sol.calls.some(([kind]) => kind === "flatten"), true);
});
