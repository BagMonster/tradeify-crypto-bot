import test from "node:test";
import assert from "node:assert/strict";
import { createRiskSupervisor, allocateProportionalCut } from "../src/risk/riskSupervisor.js";

const config = { entryBrakeUsd: 300, partialCutUsd: 1000, partialCutFraction: 0.5, fullFlattenUsd: 1250, dailyLossLimitUsd: 1500 };

function book(instrument, { unrealised = 0, day = 0, exposure = 1, unreadable = false, markUnavailable = false, hasOpenPosition = exposure > 0 } = {}) {
  const calls = [];
  const state = { unrealised, day, exposure, unreadable, markUnavailable, hasOpenPosition };
  return {
    instrument,
    calls,
    setRisk(next) { Object.assign(state, next); },
    getUnrealisedUsd() { if (state.unreadable) throw new Error("unreadable"); return state.unrealised; },
    getDayPnlUsd() { if (state.unreadable) throw new Error("unreadable"); return state.day; },
    getExposureUsd() { if (state.unreadable) throw new Error("unreadable"); return state.exposure; },
    getRiskReading() {
      if (state.unreadable) throw new Error("unreadable");
      return { unrealisedUsd: state.unrealised, dayPnlUsd: state.day, exposureUsd: state.exposure, source: state.markUnavailable ? "MARK_UNAVAILABLE" : "TEST_MARK", markUnavailable: state.markUnavailable, hasOpenPosition: state.hasOpenPosition };
    },
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

test("D-060 flatten takes priority over a cut", async () => {
  const sol = book("SOL/USD", { day: -1300 });
  const doge = book("DOGE/USD", { day: 0 });
  const supervisor = createRiskSupervisor({ config, instruments: [sol, doge] });
  assert.equal((await supervisor.evaluate({ dayKey: "2026-09-01" })).action, "FLATTEN");
  assert.equal(sol.calls.some(([kind]) => kind === "flatten"), true);
});

test("unread shared data is alert-only and does not brake either book", async () => {
  const unread = book("ZEC/USD", { unreadable: true });
  const safe = book("AVAX/USD");
  const supervisor = createRiskSupervisor({ config, instruments: [unread, safe] });
  assert.equal((await supervisor.evaluate({ dayKey: "2026-09-01" })).action, "ACCOUNT_DATA_UNAVAILABLE");
  assert.equal(unread.calls.some(([kind, on]) => kind === "brake" && on === true), false);
  assert.equal(safe.calls.some(([kind, on]) => kind === "brake" && on === true), false);
  assert.deepEqual(supervisor.getSnapshot().brakedInstruments, []);

  const recoveredZec = book("ZEC/USD", { day: 0 });
  const recoveredAvax = book("AVAX/USD", { day: 0 });
  const recovered = createRiskSupervisor({ config, instruments: [recoveredZec, recoveredAvax] });
  await recovered.evaluate({ dayKey: "2026-09-01" });
  const again = await recovered.evaluate({ dayKey: "2026-09-01" });
  assert.equal(again.action, "NONE");
  assert.equal(recovered.getSnapshot().brakedInstruments.length, 0);
  assert.equal(recoveredZec.calls.at(-1)[1], false);
  assert.equal(recoveredAvax.calls.at(-1)[1], false);
});

test("one unavailable mark is local while broker P&L still fires protective cuts", async () => {
  const quiet = book("RUNE/USD", { markUnavailable: true, exposure: 400, hasOpenPosition: true });
  const loser = book("SOL/USD", { unrealised: -40, day: -40, exposure: 400 });
  const winner = book("AAVE/USD", { unrealised: 10, day: 10, exposure: 400 });
  const supervisor = createRiskSupervisor({
    config: { ...config, partialCutUsd: 100, partialCutFraction: 0.1 },
    instruments: [quiet, loser, winner],
    getCombinedDayPnlUsd: () => -110,
    getCombinedOpenPnlUsd: () => -110
  });

  const result = await supervisor.evaluate({ dayKey: "2026-10-05" });
  assert.equal(result.action, "CUT");
  assert.equal(quiet.calls.find(([kind]) => kind === "cut")[1].fraction, 0.1);
  assert.equal(loser.calls.find(([kind]) => kind === "cut")[1].fraction, 0.1);
  assert.equal(winner.calls.some(([kind]) => kind === "cut"), false);
  const quietStatus = supervisor.getSnapshot().perInstrument.find((entry) => entry.instrument === "RUNE/USD");
  assert.equal(quietStatus.markUnavailable, true);
  assert.equal(quietStatus.entryBlockedForMark, true);
});

test("unread mark group is braked from broker residual loss while that loss remains", async () => {
  const rune = book("RUNE/USD", { markUnavailable: true, exposure: 400, hasOpenPosition: true });
  const sol = book("SOL/USD", { unrealised: 4, day: 4, exposure: 400 });
  const supervisor = createRiskSupervisor({
    config: { ...config, entryBrakeUsd: 33 },
    instruments: [rune, sol],
    getCombinedDayPnlUsd: () => -40,
    getCombinedOpenPnlUsd: () => -40
  });

  assert.equal((await supervisor.evaluate({ dayKey: "2026-10-05" })).action, "BRAKE");
  assert.equal(supervisor.getSnapshot().brakedInstruments.includes("RUNE/USD"), true);
});

test("entry brake uses an instrument's open ticket P&L, not its account-day allocation", async () => {
  const rune = book("RUNE/USD", { unrealised: -71.54, day: 3.25, exposure: 965 });
  const supervisor = createRiskSupervisor({
    config: { ...config, entryBrakeUsd: 33 },
    instruments: [rune]
  });

  const result = await supervisor.evaluate({ dayKey: "2026-10-04" });
  assert.equal(result.action, "BRAKE");
  assert.deepEqual(result.instruments, ["RUNE/USD"]);
  assert.equal(supervisor.getSnapshot().perInstrument[0].braked, true);
});

test("entry brake releases as soon as live ticket P&L recovers and is never restored", async () => {
  const rune = book("RUNE/USD", { unrealised: -34, day: -34, exposure: 965 });
  const supervisor = createRiskSupervisor({
    config: { ...config, entryBrakeUsd: 33 },
    instruments: [rune]
  });

  await supervisor.evaluate({ dayKey: "2026-10-04" });
  assert.equal(supervisor.getSnapshot().brakedInstruments.includes("RUNE/USD"), true);
  assert.equal(rune.calls.some(([kind, on]) => kind === "brake" && on === true), true);
  rune.setRisk({ unrealised: -1, day: -1 });
  await supervisor.evaluate({ dayKey: "2026-10-04" });
  assert.equal(supervisor.getSnapshot().brakedInstruments.includes("RUNE/USD"), false);
  assert.equal(rune.calls.at(-1)[1], false);

  const restarted = createRiskSupervisor({
    config: { ...config, entryBrakeUsd: 33 },
    instruments: [book("RUNE/USD", { unrealised: -1, day: -1, exposure: 965 })]
  });
  await restarted.evaluate({ dayKey: "2026-10-04" });
  assert.deepEqual(restarted.getSnapshot().brakedInstruments, []);
});
