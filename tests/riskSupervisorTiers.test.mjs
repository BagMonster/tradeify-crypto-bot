import test from "node:test";
import assert from "node:assert/strict";
import { createRiskSupervisor } from "../src/risk/riskSupervisor.js";

const legacy = {
  entryBrakeUsd: 300,
  partialCutUsd: 1000,
  partialCutFraction: 0.5,
  fullFlattenUsd: 1250,
  dailyLossLimitUsd: 1500
};

const tiered = {
  ...legacy,
  entryBrakeUsd: 600,
  cutTiers: [
    { thresholdUsd: 500, fraction: 0.10 },
    { thresholdUsd: 750, fraction: 0.20 }
  ]
};

function book(instrument, { unrealised = 0, day = 0, exposure = 1 } = {}) {
  const calls = [];
  return {
    instrument,
    calls,
    getUnrealisedUsd() { return unrealised; },
    getDayPnlUsd() { return day; },
    getExposureUsd() { return exposure; },
    setEntryBrake(on) { calls.push(["brake", on]); },
    async executeProtectiveCut(args) { calls.push(["cut", args]); return { status: "FILLED" }; },
    async executeProtectiveFlatten(args) { calls.push(["flatten", args]); return { status: "ALREADY_FLAT" }; }
  };
}

function cutFraction(instrumentBook) {
  const call = instrumentBook.calls.find(([kind]) => kind === "cut");
  return call ? call[1].fraction : null;
}

test("D-063 selects the 10% tier at combined -$550", async () => {
  const sol = book("SOL/USD", { unrealised: -280, day: -280 });
  const doge = book("DOGE/USD", { unrealised: -270, day: -270 });
  const supervisor = createRiskSupervisor({ config: tiered, instruments: [sol, doge] });
  const result = await supervisor.evaluate({ dayKey: "2026-09-03" });
  assert.equal(result.action, "CUT");
  assert.equal(result.combinedDayPnlUsd, -550);
  assert.equal(result.tier.thresholdUsd, 500);
  assert.equal(result.tier.fraction, 0.10);
  assert.equal(cutFraction(sol), 0.10);
  assert.equal(cutFraction(doge), 0.10);
});

test("D-063 selects the 20% tier at combined -$800", async () => {
  const sol = book("SOL/USD", { unrealised: -400, day: -400 });
  const doge = book("DOGE/USD", { unrealised: -400, day: -400 });
  const result = await createRiskSupervisor({ config: tiered, instruments: [sol, doge] })
    .evaluate({ dayKey: "2026-09-03" });
  assert.equal(result.action, "CUT");
  assert.equal(result.tier.thresholdUsd, 750);
  assert.equal(result.tier.fraction, 0.20);
  assert.equal(cutFraction(sol), 0.20);
});

test("D-063 selects the 50% tier at combined -$1,100", async () => {
  const sol = book("SOL/USD", { unrealised: -600, day: -600 });
  const doge = book("DOGE/USD", { unrealised: -500, day: -500 });
  const result = await createRiskSupervisor({ config: tiered, instruments: [sol, doge] })
    .evaluate({ dayKey: "2026-09-03" });
  assert.equal(result.action, "CUT");
  assert.equal(result.tier.thresholdUsd, 1000);
  assert.equal(result.tier.fraction, 0.5);
  assert.equal(cutFraction(sol), 0.5);
  assert.equal(cutFraction(doge), 0.5);
});

test("D-063 flatten at -$1,300 fires with no cut", async () => {
  const sol = book("SOL/USD", { unrealised: -1300, day: -1300 });
  const doge = book("DOGE/USD", { unrealised: 0, day: 0 });
  const result = await createRiskSupervisor({ config: tiered, instruments: [sol, doge] })
    .evaluate({ dayKey: "2026-09-03" });
  assert.equal(result.action, "FLATTEN");
  assert.equal(sol.calls.some(([kind]) => kind === "cut"), false);
  assert.equal(doge.calls.some(([kind]) => kind === "cut"), false);
  assert.equal(sol.calls.some(([kind]) => kind === "flatten"), true);
});

test("absent cutTiers keeps the legacy single 50% cut at -$1,000", async () => {
  const sol = book("SOL/USD", { unrealised: -280, day: -280 });
  const doge = book("DOGE/USD", { unrealised: -270, day: -270 });
  const shallow = await createRiskSupervisor({ config: legacy, instruments: [sol, doge] })
    .evaluate({ dayKey: "2026-09-03" });
  assert.equal(shallow.action, "NONE");

  const deepSol = book("SOL/USD", { unrealised: -720, day: -720 });
  const deepDoge = book("DOGE/USD", { unrealised: -300, day: -300 });
  const winner = book("AAVE/USD", { unrealised: 20, day: 20 });
  const deep = await createRiskSupervisor({ config: legacy, instruments: [deepSol, deepDoge, winner] })
    .evaluate({ dayKey: "2026-09-03" });
  assert.equal(deep.action, "CUT");
  assert.equal(deep.tier.thresholdUsd, 1000);
  assert.equal(deep.tier.fraction, 0.5);
  assert.equal(cutFraction(deepSol), 0.5);
  assert.equal(winner.calls.some(([kind]) => kind === "cut"), false);
});

test("rejects a cut tier at or deeper than flatten", () => {
  assert.throws(() => createRiskSupervisor({
    config: { ...legacy, cutTiers: [{ thresholdUsd: 1250, fraction: 0.2 }] },
    instruments: [book("SOL/USD")]
  }), /deepest cut tier must trigger before the full flatten/);
});

test("rejects a cut fraction above 1", () => {
  assert.throws(() => createRiskSupervisor({
    config: { ...legacy, cutTiers: [{ thresholdUsd: 500, fraction: 1.1 }] },
    instruments: [book("SOL/USD")]
  }), /fraction must be between 0 and 1/);
});

test("rejects duplicate cut thresholds", () => {
  assert.throws(() => createRiskSupervisor({
    config: { ...legacy, cutTiers: [{ thresholdUsd: 1000, fraction: 0.2 }] },
    instruments: [book("SOL/USD")]
  }), /strictly decreasing/);
});

test("rejects a non-positive cut threshold", () => {
  assert.throws(() => createRiskSupervisor({
    config: { ...legacy, cutTiers: [{ thresholdUsd: 0, fraction: 0.1 }] },
    instruments: [book("SOL/USD")]
  }), /thresholdUsd must be positive/);
});
