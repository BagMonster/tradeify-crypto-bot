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

test("D-063 selects a tier from combined day P&L, while cutting only losing books", async () => {
  let nowMs = 1_000_000;
  let combinedDayPnlUsd = -101; // Includes a prior realised loss; open loss is only $40.
  const losingState = { unrealised: -40, dayPnl: -40 };
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

  assert.equal(result.action, "CUT");
  assert.equal(result.tier.thresholdUsd, 100);
  assert.deepEqual(cutFractions(losing), [0.10]);
  assert.deepEqual(cutFractions(winning), []);
  assert.match(losing.calls[0][1].reason, /combined day P&L -101\.00/);
});

test("D-063 gives each tier its own 15-minute cooldown and permits immediate escalation", async () => {
  let nowMs = 2_000_000;
  let combinedDayPnlUsd = -101;
  const state = { unrealised: -60, dayPnl: -60 };
  const sol = mutableBook("SOL/USD", state);
  const supervisor = createRiskSupervisor({
    config,
    instruments: [sol],
    getCombinedDayPnlUsd: () => combinedDayPnlUsd,
    now: () => nowMs
  });

  assert.equal((await supervisor.evaluate({ dayKey: "2026-09-24" })).tier.thresholdUsd, 100);
  assert.deepEqual(cutFractions(sol), [0.10]);

  nowMs += 5 * 60 * 1000;
  assert.equal((await supervisor.evaluate({ dayKey: "2026-09-24" })).action, "NONE");
  assert.deepEqual(cutFractions(sol), [0.10]);

  // A deeper tier has not fired, so its own timer is clear and it may act now.
  combinedDayPnlUsd = -151;
  assert.equal((await supervisor.evaluate({ dayKey: "2026-09-24" })).tier.thresholdUsd, 150);
  assert.deepEqual(cutFractions(sol), [0.10, 0.20]);

  nowMs += 5 * 60 * 1000;
  assert.equal((await supervisor.evaluate({ dayKey: "2026-09-24" })).action, "NONE");
  assert.deepEqual(cutFractions(sol), [0.10, 0.20]);

  // Recovery into the shallower band follows that tier's original timer.
  combinedDayPnlUsd = -101;
  nowMs += 5 * 60 * 1000;
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

  state.unrealised = -10;
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
