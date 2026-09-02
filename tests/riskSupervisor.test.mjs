import test from "node:test";
import assert from "node:assert/strict";
import { createRiskSupervisor, allocateProportionalCut } from "../src/risk/riskSupervisor.js";

const config = { entryBrakeUsd: 300, partialCutUsd: 1000, partialCutFraction: 0.5, fullFlattenUsd: 1250, dailyLossLimitUsd: 1500 };

function book(instrument, { unrealised = 0, day = 0, exposure = 1, unreadable = false } = {}) {
  const calls = [];
  return {
    instrument,
    calls,
    getUnrealisedUsd() { if (unreadable) throw new Error("unreadable"); return unrealised; },
    getDayPnlUsd() { if (unreadable) throw new Error("unreadable"); return day; },
    getExposureUsd() { if (unreadable) throw new Error("unreadable"); return exposure; },
    setEntryBrake(on) { calls.push(["brake", on]); },
    async executeProtectiveCut(args) { calls.push(["cut", args]); return { status: "FILLED" }; },
    async executeProtectiveFlatten(args) { calls.push(["flatten", args]); return { status: "ALREADY_FLAT" }; }
  };
}

test("D-060 cuts half of every losing book and never a winner", async () => {
  const sol = book("SOL/USD", { unrealised: -720, day: -720 });
  const doge = book("DOGE/USD", { unrealised: -300, day: -300 });
  const winner = book("AAVE/USD", { unrealised: 20, day: 20 });
  const supervisor = createRiskSupervisor({ config, instruments: [sol, doge, winner] });
  const result = await supervisor.evaluate({ dayKey: "2026-09-01" });
  assert.equal(result.action, "CUT");
  assert.equal(sol.calls.find(([kind]) => kind === "cut")[1].fraction, 0.5);
  assert.equal(doge.calls.find(([kind]) => kind === "cut")[1].fraction, 0.5);
  assert.equal(winner.calls.some(([kind]) => kind === "cut"), false);
  assert.equal(allocateProportionalCut([{ instrument: "SOL/USD", unrealisedUsd: -1000 }], 0.5)[0].fraction, 0.5);
});

test("D-060 flatten takes priority and unreadable data brakes every book", async () => {
  const sol = book("SOL/USD", { day: -1300 });
  const doge = book("DOGE/USD", { day: 0 });
  const supervisor = createRiskSupervisor({ config, instruments: [sol, doge] });
  assert.equal((await supervisor.evaluate({ dayKey: "2026-09-01" })).action, "FLATTEN");
  assert.equal(sol.calls.some(([kind]) => kind === "flatten"), true);
  const unreadable = book("ZEC/USD", { unreadable: true });
  const safe = book("AVAX/USD");
  const failClosed = createRiskSupervisor({ config, instruments: [unreadable, safe] });
  assert.equal((await failClosed.evaluate({ dayKey: "2026-09-01" })).action, "ACCOUNT_DATA_UNAVAILABLE");
  assert.equal(safe.calls.some(([kind, on]) => kind === "brake" && on === true), true);
});
