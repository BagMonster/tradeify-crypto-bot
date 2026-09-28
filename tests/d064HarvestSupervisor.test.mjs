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

test("D-064 retries an unverified or non-flat protective flatten while remaining fail-closed", async () => {
  const sol = book("SOL/USD", "NOT_FLAT");
  const halts = [];
  const supervisor = createRiskSupervisor({ config, instruments: [sol], harvestStore: memoryHarvestStore(), getCombinedDayPnlUsd: () => 250, setSafetyHalt: async (reason) => halts.push(reason) });
  const result = await supervisor.evaluate({ dayKey: "2026-09-09" });
  assert.equal(result.action, "HARVEST_PENDING");
  assert.equal(supervisor.getSnapshot().harvest.status, "PENDING");
  assert.equal(supervisor.getSnapshot().trancheExitsPaused, true);
  assert.equal(sol.calls.some(([kind, on]) => kind === "brake" && on === true), true);
  assert.equal(halts.length, 0);
});

test("D-064 durable execution failure remains fail-closed", async () => {
  const sol = book("SOL/USD", "REJECTED");
  const halts = [];
  const supervisor = createRiskSupervisor({ config, instruments: [sol], harvestStore: memoryHarvestStore(), getCombinedDayPnlUsd: () => 250, setSafetyHalt: async (reason) => halts.push(reason) });
  const result = await supervisor.evaluate({ dayKey: "2026-09-09" });
  assert.equal(result.action, "HARVEST_HALTED");
  assert.equal(supervisor.getSnapshot().harvest.status, "HALTED");
  assert.equal(halts.length, 1);
});

test("D-064 gives a fresh-data read five minutes before it becomes a durable halt", async () => {
  const sol = book("SOL/USD");
  let unread = false;
  let nowMs = Date.parse("2026-09-09T12:00:00.000Z");
  sol.getDayPnlUsd = () => { if (unread) throw new Error("broker metrics unavailable"); return 0; };
  const halts = [];
  const notifications = [];
  const supervisor = createRiskSupervisor({
    config,
    instruments: [sol],
    harvestStore: memoryHarvestStore(),
    getCombinedDayPnlUsd: () => 0,
    setSafetyHalt: async (reason) => halts.push(reason),
    notifications: { enqueue: (event) => notifications.push(event) },
    now: () => nowMs
  });
  await supervisor.evaluate({ dayKey: "2026-09-09" });
  unread = true;
  const first = await supervisor.evaluate({ dayKey: "2026-09-09" });
  assert.equal(first.action, "ACCOUNT_DATA_UNAVAILABLE");
  assert.equal(first.graceRemainingMs, 300000);
  assert.equal(supervisor.getSnapshot().freshDataGrace.remainingMs, 300000);
  assert.equal(halts.length, 0);
  assert.equal(notifications.filter((event) => event.kind === "HARVEST_FRESHNESS_GRACE").length, 1);
  nowMs += 299999;
  assert.equal((await supervisor.evaluate({ dayKey: "2026-09-09" })).action, "ACCOUNT_DATA_UNAVAILABLE");
  assert.equal(halts.length, 0);
  nowMs += 1;
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

test("D-064 verified-flat recovery confirms the original harvest without re-triggering it", async () => {
  const store = memoryHarvestStore();
  const reason = "D-064 harvest could not confirm every book flat; owner review required";
  await store.save({ dayKey: "2026-09-09", status: "HALTED", triggerPnlUsd: 250.82, confirmedAt: null, haltReason: reason });
  const sol = book("SOL/USD");
  const supervisor = createRiskSupervisor({
    config,
    instruments: [sol],
    harvestStore: store,
    getCombinedDayPnlUsd: () => 74.87,
    clearSafetyHaltIfReason: async (value) => value === reason,
    getSafetyHaltState: async () => ({ safety_halt: true, halt_reason: reason }),
    now: () => Date.parse("2026-09-09T12:00:00.000Z")
  });
  const result = await supervisor.recoverHarvest({ dayKey: "2026-09-09", booksVerified: true, recoveryKind: "VERIFIED_FLAT" });
  assert.equal(result.action, "HARVEST_CONFIRMED");
  assert.equal(supervisor.getSnapshot().harvest.status, "CONFIRMED");
  assert.equal(supervisor.getSnapshot().harvest.triggerPnlUsd, 250.82);
  assert.equal(supervisor.getSnapshot().trancheExitsPaused, true);
  assert.equal(sol.calls.some(([kind, on]) => kind === "brake" && on === false), true);
});

test("D-064 recovery requires the correct recovery kind and book verification", async () => {
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

test("D-068 harvests only the proportional $33 rollover-profit plan and leaves books open", async () => {
  const store = memoryHarvestStore();
  const closes = [];
  const sol = book("SOL/USD");
  sol.getRolloverHarvestCandidates = async () => [{
    instrument: "SOL/USD", lotId: "BUY1-V0", ringTag: "BUY1", positionCode: "DX-SOL", virtualSide: "BUY",
    entryPrice: 100, markPrice: 110, remainingUnits: 4, lotStep: 0.01, openedAt: "2026-09-24T21:00:00.000Z"
  }];
  sol.executeRolloverHarvest = async ({ allocations, onConfirmedClose }) => {
    assert.equal(allocations.length, 1);
    assert.ok(allocations[0].quantity < 4);
    const close = { instrument: "SOL/USD", lotId: "BUY1-V0", filledQuantity: allocations[0].quantity, realizedPnlUsd: 33 };
    await onConfirmedClose(close);
    closes.push(close);
    return { closed: [close], pending: [] };
  };
  const config33 = { ...config, sessionHarvestUsd: 33 };
  const supervisor = createRiskSupervisor({ config: config33, instruments: [sol], harvestStore: store, getCombinedDayPnlUsd: () => 4, now: () => Date.parse("2026-09-25T01:00:00.000Z") });
  const result = await supervisor.evaluate({ dayKey: "2026-09-25" });
  assert.equal(result.action, "HARVEST_CONFIRMED");
  assert.equal(closes.length, 1);
  assert.equal(supervisor.getSnapshot().harvest.mode, "ROLLOVER_PARTIAL");
  assert.equal(supervisor.getSnapshot().trancheExitsPaused, true);
  assert.equal(sol.calls.some(([kind]) => kind === "flatten"), false);
});

test("D-068 waits for startup market marks without creating a durable harvest halt", async () => {
  const halts = [];
  const sol = book("SOL/USD");
  sol.getRolloverHarvestCandidates = async () => null;
  const supervisor = createRiskSupervisor({
    config: { ...config, sessionHarvestUsd: 33 },
    instruments: [sol],
    harvestStore: memoryHarvestStore(),
    getCombinedDayPnlUsd: () => 0,
    setSafetyHalt: async (reason) => halts.push(reason)
  });
  const result = await supervisor.evaluate({ dayKey: "2026-09-27" });
  assert.equal(result.action, "NONE");
  assert.equal(supervisor.getSnapshot().harvest.status, "READY");
  assert.deepEqual(halts, []);
});

test("D-068 does not harvest when winners exceed $33 but the account-wide ticket P&L does not", async () => {
  const closes = [];
  const sol = book("SOL/USD");
  sol.getRolloverHarvestCandidates = async () => [
    { instrument: "SOL/USD", lotId: "winner", ringTag: null, positionCode: "DX-WINNER", virtualSide: "BUY", entryPrice: 100, markPrice: 110, remainingUnits: 5, lotStep: 0.01 },
    { instrument: "SOL/USD", lotId: "loser", ringTag: null, positionCode: "DX-LOSER", virtualSide: "BUY", entryPrice: 100, markPrice: 90, remainingUnits: 2, lotStep: 0.01 }
  ];
  sol.executeRolloverHarvest = async () => { closes.push("unexpected"); return { closed: [], pending: [] }; };
  const supervisor = createRiskSupervisor({
    config: { ...config, sessionHarvestUsd: 33 },
    instruments: [sol],
    harvestStore: memoryHarvestStore(),
    getCombinedDayPnlUsd: () => -3.65
  });
  const result = await supervisor.evaluate({ dayKey: "2026-09-27" });
  assert.equal(result.action, "NONE");
  assert.equal(supervisor.getSnapshot().harvest.status, "READY");
  assert.deepEqual(closes, []);
});

test("D-068 defers an unsubmitted changed ticket with a warning and leaves normal trading available", async () => {
  const events = [];
  const notifications = [];
  const halts = [];
  const sol = book("SOL/USD");
  sol.getRolloverHarvestCandidates = async () => [{
    instrument: "SOL/USD", lotId: "ticket", ringTag: null, positionCode: "DX-TICKET", virtualSide: "BUY",
    entryPrice: 100, markPrice: 110, remainingUnits: 4, lotStep: 0.01
  }];
  sol.executeRolloverHarvest = async () => ({ closed: [], pending: [{ instrument: "SOL/USD", lotId: "ticket", status: "POSITION_CHANGED" }] });
  const supervisor = createRiskSupervisor({
    config: { ...config, sessionHarvestUsd: 33 },
    instruments: [sol],
    harvestStore: memoryHarvestStore(),
    getCombinedDayPnlUsd: () => 4,
    setSafetyHalt: async (reason) => halts.push(reason),
    addEvent: async (level, type, payload) => events.push({ level, type, payload }),
    notifications: { enqueue: (event) => notifications.push(event) }
  });
  const result = await supervisor.evaluate({ dayKey: "2026-09-27" });
  assert.equal(result.action, "HARVEST_DEFERRED");
  assert.equal(supervisor.getSnapshot().harvest.status, "READY");
  assert.deepEqual(halts, []);
  assert.equal(events.some((event) => event.type === "D068_ROLLOVER_HARVEST_DEFERRED"), true);
  assert.equal(notifications.at(-1).kind, "HARVEST_DEFERRED");
  assert.equal(sol.calls.some(([kind, on]) => kind === "brake" && on === false), true);
});

test("D-068 no-fill recovery clears the exact legacy halt even when its mode was persisted as FULL", async () => {
  const store = memoryHarvestStore();
  const reason = "D-068 rollover harvest could not confirm its planned profit closes; owner review required";
  await store.save({
    dayKey: "2026-09-27",
    status: "HALTED",
    mode: "FULL",
    plan: { allocations: [{ instrument: "SOL/USD", lotId: "ticket" }], completed: [] },
    triggerPnlUsd: -3.65,
    confirmedAt: null,
    haltReason: reason
  });
  const sol = book("SOL/USD");
  const supervisor = createRiskSupervisor({
    config: { ...config, sessionHarvestUsd: 33 },
    instruments: [sol],
    harvestStore: store,
    getCombinedDayPnlUsd: () => -3.65,
    getSafetyHaltState: async () => ({ safety_halt: true, halt_reason: reason }),
    clearSafetyHaltIfReason: async (value) => value === reason
  });
  const result = await supervisor.recoverHarvest({ dayKey: "2026-09-27", booksVerified: true, recoveryKind: "ROLLOVER_UNVERIFIED" });
  assert.equal(result.action, "NONE");
  assert.equal(supervisor.getSnapshot().harvest.status, "READY");
});

test("D-068 unverified legacy plan clears to READY even when its saved completed list is non-empty", async () => {
  const store = memoryHarvestStore();
  const reason = "D-068 rollover harvest could not confirm its planned profit closes; owner review required";
  await store.save({
    dayKey: "2026-09-27",
    status: "HALTED",
    mode: "FULL",
    plan: { allocations: [{ instrument: "SOL/USD", lotId: "ticket" }], completed: ["SOL/USD:ticket"] },
    triggerPnlUsd: 5.03,
    confirmedAt: null,
    haltReason: reason
  });
  const supervisor = createRiskSupervisor({
    config: { ...config, sessionHarvestUsd: 33 },
    instruments: [book("SOL/USD")],
    harvestStore: store,
    getCombinedDayPnlUsd: () => 5.03
  });
  const result = await supervisor.recoverHarvest({ dayKey: "2026-09-27", booksVerified: true, recoveryKind: "ROLLOVER_UNVERIFIED" });
  assert.equal(result.action, "NONE");
  assert.equal(supervisor.getSnapshot().harvest.status, "READY");
  assert.equal(supervisor.getSnapshot().trancheExitsPaused, false);
});

test("D-068 owner recovery clears an unverified legacy confirmation and restores ordinary exits", async () => {
  const store = memoryHarvestStore();
  await store.save({ dayKey: "2026-09-28", status: "CONFIRMED", mode: "ROLLOVER_PARTIAL", plan: { allocations: [{ instrument: "SOL/USD", lotId: "ticket" }], completed: ["SOL/USD:ticket"] }, triggerPnlUsd: 5.03, confirmedAt: "2026-09-28T00:06:49.797Z", haltReason: null });
  const sol = book("SOL/USD");
  const supervisor = createRiskSupervisor({ config: { ...config, sessionHarvestUsd: 33 }, instruments: [sol], harvestStore: store, getCombinedDayPnlUsd: () => 5.03 });
  const result = await supervisor.recoverHarvest({ dayKey: "2026-09-28", booksVerified: true, recoveryKind: "ROLLOVER_UNVERIFIED" });
  assert.equal(result.action, "NONE");
  assert.equal(supervisor.getSnapshot().harvest.status, "READY");
  assert.equal(supervisor.getSnapshot().trancheExitsPaused, false);
  assert.equal(sol.calls.some(([kind]) => kind === "flatten"), false);
});

test("D-068 full-pool schedule uses $16.50 after 24 hours", async () => {
  const store = memoryHarvestStore();
  const nowMs = Date.parse("2026-09-28T12:00:00.000Z");
  const closes = [];
  const sol = book("SOL/USD");
  sol.getRolloverHarvestCandidates = async () => [{ instrument: "SOL/USD", lotId: "ticket", positionCode: "DX-TICKET", virtualSide: "BUY", entryPrice: 100, markPrice: 110, remainingUnits: 4, lotStep: 0.01 }];
  sol.executeRolloverHarvest = async ({ allocations, onConfirmedClose }) => {
    closes.push(allocations[0]);
    await onConfirmedClose({ instrument: "SOL/USD", lotId: "ticket", filledQuantity: allocations[0].quantity, realizedPnlUsd: allocations[0].estimatedProfitUsd });
    return { closed: [], pending: [] };
  };
  const supervisor = createRiskSupervisor({
    config: { ...config, sessionHarvestUsd: 33, exposurePoolHarvest: { firstAfterHours: 24, secondAfterHours: 36, firstFraction: 0.5, minimumFraction: 0.25 } },
    instruments: [sol], harvestStore: store, getCombinedDayPnlUsd: () => 0, now: () => nowMs,
    getExposurePoolSnapshot: () => ({ closed: true, closedSinceMs: nowMs - 24 * 60 * 60 * 1000 })
  });
  await supervisor.evaluate({ dayKey: "2026-09-28" });
  assert.equal(closes[0].estimatedProfitUsd, 16.5);
});

test("D-068 full-pool schedule floors at $8.25 after 36 hours", async () => {
  const store = memoryHarvestStore();
  const nowMs = Date.parse("2026-09-29T12:00:00.000Z");
  const sol = book("SOL/USD");
  sol.getRolloverHarvestCandidates = async () => [{ instrument: "SOL/USD", lotId: "ticket", positionCode: "DX-TICKET", virtualSide: "BUY", entryPrice: 100, markPrice: 110, remainingUnits: 4, lotStep: 0.01 }];
  let allocation = null;
  sol.executeRolloverHarvest = async ({ allocations, onConfirmedClose }) => {
    allocation = allocations[0];
    await onConfirmedClose({ instrument: "SOL/USD", lotId: "ticket", filledQuantity: allocation.quantity, realizedPnlUsd: allocation.estimatedProfitUsd });
    return { closed: [], pending: [] };
  };
  const supervisor = createRiskSupervisor({
    config: { ...config, sessionHarvestUsd: 33, exposurePoolHarvest: { firstAfterHours: 24, secondAfterHours: 36, firstFraction: 0.5, minimumFraction: 0.25 } },
    instruments: [sol], harvestStore: store, getCombinedDayPnlUsd: () => 0, now: () => nowMs,
    getExposurePoolSnapshot: () => ({ closed: true, closedSinceMs: nowMs - 36 * 60 * 60 * 1000 })
  });
  await supervisor.evaluate({ dayKey: "2026-09-29" });
  assert.equal(supervisor.getSnapshot().harvest.plan.targetUsd, 8.25);
  assert.ok(allocation.estimatedProfitUsd <= 8.25);
});
