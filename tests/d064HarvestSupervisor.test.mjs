import test from "node:test";
import assert from "node:assert/strict";
import { createRiskSupervisor } from "../src/risk/riskSupervisor.js";

const config = Object.freeze({
  entryBrakeUsd: 600,
  partialCutUsd: 1000,
  partialCutFraction: 0.5,
  fullFlattenUsd: 1250,
  dailyLossLimitUsd: 1500,
  sessionHarvestEnabled: true,
  sessionHarvestUsd: 250
});

function memoryHarvestStore() {
  const rows = new Map();
  return {
    async get(dayKey) { return rows.get(dayKey) ?? { dayKey, status: "READY", triggerPnlUsd: null, confirmedAt: null, haltReason: null }; },
    async save(value) { const row = Object.freeze({ ...value }); rows.set(row.dayKey, row); return row; }
  };
}

function book(instrument, status = "ALREADY_FLAT") {
  const calls = [];
  return {
    instrument,
    calls,
    getUnrealisedUsd: () => 0,
    getDayPnlUsd: () => 0,
    getExposureUsd: () => 0,
    setEntryBrake: (on) => calls.push(["brake", on]),
    setTrancheExitsPaused: (on) => calls.push(["exits", on]),
    executeProtectiveCut: async () => ({ status: "ALREADY_FLAT" }),
    executeProtectiveFlatten: async () => { calls.push(["flatten"]); return { status }; }
  };
}

test("D-064 banks an already-flat +$250 account once and pauses ordinary exits", async () => {
  const sol = book("SOL/USD");
  const doge = book("DOGE/USD");
  const supervisor = createRiskSupervisor({ config, instruments: [sol, doge], harvestStore: memoryHarvestStore(), getCombinedDayPnlUsd: () => 251, now: () => Date.parse("2026-09-09T12:00:00.000Z") });
  const first = await supervisor.evaluate({ dayKey: "2026-09-09" });
  assert.equal(first.action, "HARVEST_CONFIRMED");
  assert.equal(supervisor.getSnapshot().harvest.status, "CONFIRMED");
  assert.equal(supervisor.getSnapshot().trancheExitsPaused, true);
  const second = await supervisor.evaluate({ dayKey: "2026-09-09" });
  assert.equal(second.action, "NONE");
  assert.equal(sol.calls.filter(([kind]) => kind === "flatten").length, 1);
});

test("D-064 remains pending for an idempotent broker confirmation and blocks normal grid work", async () => {
  const sol = book("SOL/USD", "PENDING");
  const supervisor = createRiskSupervisor({ config, instruments: [sol], harvestStore: memoryHarvestStore(), getCombinedDayPnlUsd: () => 250 });
  const result = await supervisor.evaluate({ dayKey: "2026-09-09" });
  assert.equal(result.action, "HARVEST_PENDING");
  assert.equal(supervisor.getSnapshot().harvest.status, "PENDING");
  assert.equal(sol.calls.some(([kind, on]) => kind === "brake" && on === true), true);
});

test("D-064 terminal harvest failure is durable and fail-closed", async () => {
  const sol = book("SOL/USD", "NOT_FLAT");
  const halts = [];
  const supervisor = createRiskSupervisor({ config, instruments: [sol], harvestStore: memoryHarvestStore(), getCombinedDayPnlUsd: () => 250, setSafetyHalt: async (reason) => halts.push(reason) });
  const result = await supervisor.evaluate({ dayKey: "2026-09-09" });
  assert.equal(result.action, "HARVEST_HALTED");
  assert.equal(supervisor.getSnapshot().harvest.status, "HALTED");
  assert.equal(halts.length, 1);
});

test("D-064 unread broker data becomes a durable halt that pauses normal exits", async () => {
  const sol = book("SOL/USD");
  let unread = false;
  sol.getDayPnlUsd = () => { if (unread) throw new Error("broker metrics unavailable"); return 0; };
  const halts = [];
  const supervisor = createRiskSupervisor({
    config,
    instruments: [sol],
    harvestStore: memoryHarvestStore(),
    getCombinedDayPnlUsd: () => 0,
    setSafetyHalt: async (reason) => halts.push(reason)
  });
  await supervisor.evaluate({ dayKey: "2026-09-09" });
  unread = true;
  const result = await supervisor.evaluate({ dayKey: "2026-09-09" });
  assert.equal(result.action, "HARVEST_HALTED");
  assert.equal(supervisor.getSnapshot().harvest.status, "HALTED");
  assert.equal(supervisor.getSnapshot().trancheExitsPaused, true);
  assert.equal(halts.length, 1);
});

test("D-064 first cold read waits without creating a durable halt, then recovers on fresh data", async () => {
  const sol = book("SOL/USD");
  let unread = true;
  sol.getDayPnlUsd = () => { if (unread) throw new Error("cold account snapshot"); return 0; };
  const store = memoryHarvestStore();
  const supervisor = createRiskSupervisor({ config, instruments: [sol], harvestStore: store, getCombinedDayPnlUsd: () => 0, clearSafetyHaltIfReason: async () => true });
  assert.equal((await supervisor.evaluate({ dayKey: "2026-09-09" })).action, "ACCOUNT_DATA_UNAVAILABLE");
  assert.equal(supervisor.getSnapshot().harvest, null);
  unread = false;
  assert.equal((await supervisor.evaluate({ dayKey: "2026-09-09" })).action, "NONE");
});

test("D-064 recovery clears only its own fresh-data halt after a fresh read and verified books", async () => {
  const store = memoryHarvestStore();
  const reason = "D-064 harvest cannot verify fresh broker account data for SOL/USD";
  await store.save({ dayKey: "2026-09-09", status: "HALTED", triggerPnlUsd: 0, confirmedAt: null, haltReason: reason });
  const sol = book("SOL/USD");
  const supervisor = createRiskSupervisor({ config, instruments: [sol], harvestStore: store, getCombinedDayPnlUsd: () => 0, clearSafetyHaltIfReason: async (value) => value === reason, getSafetyHaltState: async () => ({ safety_halt: true, halt_reason: reason }) });
  const result = await supervisor.recoverHarvest({ dayKey: "2026-09-09", booksVerified: true });
  assert.equal(result.action, "NONE");
  assert.equal(supervisor.getSnapshot().harvest.status, "READY");
});

test("D-064 recovery cannot clear a terminal harvest halt or skip book verification", async () => {
  const store = memoryHarvestStore();
  await store.save({ dayKey: "2026-09-09", status: "HALTED", triggerPnlUsd: 250, confirmedAt: null, haltReason: "D-064 harvest could not confirm every book flat; owner review required" });
  const supervisor = createRiskSupervisor({ config, instruments: [book("SOL/USD")], harvestStore: store, getCombinedDayPnlUsd: () => 0 });
  assert.equal((await supervisor.recoverHarvest({ dayKey: "2026-09-09", booksVerified: true })).action, "HARVEST_RECOVERY_REFUSED");
  assert.equal((await supervisor.recoverHarvest({ dayKey: "2026-09-09" })).action, "HARVEST_RECOVERY_REFUSED");
});

test("D-064 reset at 22:00 UTC re-enables normal exits for the new account day", async () => {
  const sol = book("SOL/USD");
  let pnl = 250;
  const supervisor = createRiskSupervisor({ config, instruments: [sol], harvestStore: memoryHarvestStore(), getCombinedDayPnlUsd: () => pnl });
  await supervisor.evaluate({ dayKey: "2026-09-09" });
  pnl = 0;
  const next = await supervisor.evaluate({ dayKey: "2026-09-10" });
  assert.equal(next.action, "NONE");
  assert.equal(supervisor.getSnapshot().harvest.status, "READY");
  assert.equal(supervisor.getSnapshot().trancheExitsPaused, false);
});

test("D-064 reloads a confirmed harvest after a worker restart", async () => {
  const store = memoryHarvestStore();
  await store.save({ dayKey: "2026-09-09", status: "CONFIRMED", triggerPnlUsd: 250, confirmedAt: "2026-09-09T12:00:00.000Z", haltReason: null });
  const sol = book("SOL/USD");
  const supervisor = createRiskSupervisor({ config, instruments: [sol], harvestStore: store, getCombinedDayPnlUsd: () => 120 });
  const result = await supervisor.evaluate({ dayKey: "2026-09-09" });
  assert.equal(result.action, "NONE");
  assert.equal(supervisor.getSnapshot().harvest.status, "CONFIRMED");
  assert.equal(supervisor.getSnapshot().trancheExitsPaused, true);
  assert.equal(sol.calls.some(([kind]) => kind === "flatten"), false);
});
