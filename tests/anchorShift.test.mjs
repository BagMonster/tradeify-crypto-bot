import test from "node:test";
import assert from "node:assert/strict";
import { buildGridDefinition } from "../src/strategies/ringGridDefinition.js";
import { createRingGrid } from "../src/strategies/ringGrid.js";
import { createRingGridInstance } from "../src/runtime/ringGridInstance.js";
import { computeShift, initialAnchorShiftState, trackExcursion } from "../src/strategies/anchorShift.js";
import { createAnchorShiftCoordinator } from "../src/risk/anchorShiftCoordinator.js";
import { createMultiInstrumentOwnerService } from "../src/multiInstrumentOwnerService.js";

const solGeometry = { band: 0.05, deadZoneBands: 3, activeLevelsPerSide: 10, innerLevels: 5 };
const iso = (n) => new Date(n).toISOString();

function tracked(price, at = iso(Date.UTC(2026, 9, 5))) {
  return trackExcursion(initialAnchorShiftState(), { price, anchor: 100, geometry: solGeometry, occurredAt: at }).state;
}

test("1. upper and lower computeShift place SOL ring F at the literal extreme", () => {
  const upper = computeShift(tracked(180), { maNow: 100, geometry: solGeometry, shiftedAt: iso(Date.UTC(2026, 9, 5, 1)) });
  assert.ok(Math.abs(upper.multiplier - (1.8 / 1.45)) < 1e-9);
  assert.ok(Math.abs(upper.anchor * 1.45 - 180) < 1e-9);
  const lowerState = trackExcursion(initialAnchorShiftState(), { price: 20, anchor: 100, geometry: solGeometry, occurredAt: iso(Date.UTC(2026, 9, 5)) }).state;
  const lower = computeShift(lowerState, { maNow: 100, geometry: solGeometry, shiftedAt: iso(Date.UTC(2026, 9, 5, 1)) });
  assert.equal(lower.side, "LOWER");
  assert.ok(Math.abs(lower.anchor * 0.55 - 20) < 1e-9);
});

test("2. excursion extreme survives returning inside and no excursion produces no shift", () => {
  const high = trackExcursion(initialAnchorShiftState(), { price: 180, anchor: 100, geometry: solGeometry, occurredAt: iso(1) }).state;
  const returned = trackExcursion(high, { price: 120, anchor: 100, geometry: solGeometry, occurredAt: iso(2) }).state;
  assert.equal(returned.upperExtreme, 180);
  assert.equal(computeShift(initialAnchorShiftState(), { maNow: 100, geometry: solGeometry, shiftedAt: iso(3) }), null);
});

test("3. stacked shifts calculate from the shifted grid in both directions", () => {
  const first = computeShift(tracked(180), { maNow: 100, geometry: solGeometry, shiftedAt: iso(1) });
  const secondState = trackExcursion(first.state, { price: 250, anchor: 100 * first.multiplier, geometry: solGeometry, occurredAt: iso(2) }).state;
  const second = computeShift(secondState, { maNow: 105, geometry: solGeometry, shiftedAt: iso(3) });
  assert.ok(Math.abs(second.multiplier - (250 / 1.45 / 105)) < 1e-9);
  const downState = trackExcursion(second.state, { price: 30, anchor: 105 * second.multiplier, geometry: solGeometry, occurredAt: iso(4) }).state;
  const down = computeShift(downState, { maNow: 100, geometry: solGeometry, shiftedAt: iso(5) });
  assert.equal(down.side, "LOWER");
  assert.ok(Math.abs(down.multiplier - (30 / 0.55 / 100)) < 1e-9);
});

test("4. recenter requires a not-flat transition, two healthy reads, and the nine-second hold", async () => {
  let t = 0; let shifted = 0; let held = false; let pending = true; let virtual = false; let inFlight = false;
  const coordinator = createAnchorShiftCoordinator({
    books: [{ instrument: "SOL/USD", setAnchorShiftHold: (on) => { held = on; }, hasPendingAnchorExcursion: () => pending, hasVirtualLots: () => virtual, hasOrderInFlight: () => inFlight, applyAnchorShift: async () => { shifted += 1; pending = false; return { shifted: true, instrument: "SOL/USD" }; } }],
    now: () => t,
    holdMs: 9000
  });
  const bad = { openPositionsCount: 0, signedNetReadOk: false };
  const flat = { openPositionsCount: 0, signedNetReadOk: true, accountLocked: false, positionsReadFailed: false };
  const open = { ...flat, openPositionsCount: 1 };
  assert.equal((await coordinator.observe(bad)).action, "INITIAL_NOT_FLAT");
  assert.equal((await coordinator.observe(open)).action, "NOT_FLAT");
  assert.equal((await coordinator.observe(flat)).action, "HOLD_STARTED");
  assert.equal(held, true);
  t = 2_000; assert.equal((await coordinator.observe(flat)).action, "HOLDING");
  virtual = true; t = 4_000; assert.equal((await coordinator.observe(flat)).action, "NOT_FLAT");
  assert.equal(held, false); assert.equal(shifted, 0);
  virtual = false; await coordinator.observe(open); await coordinator.observe(flat);
  t = 6_000; assert.equal((await coordinator.observe(flat)).action, "HOLDING"); t = 14_000;
  assert.equal((await coordinator.observe(flat)).action, "SHIFTED");
  assert.equal(shifted, 1); assert.equal(held, false);
  inFlight = true; await coordinator.observe(open); await coordinator.observe(flat);
  assert.equal(held, false, "an in-flight order cannot start a hold");
});

test("4b. verified-flat recovery still requires the nine-second hold and another fresh snapshot", async () => {
  let t = 0; let shifted = 0; let held = false; let pending = true;
  const coordinator = createAnchorShiftCoordinator({
    books: [{ instrument: "ZEC/USD", setAnchorShiftHold: (on) => { held = on; }, hasPendingAnchorExcursion: () => pending, hasVirtualLots: () => false, hasOrderInFlight: () => false, applyAnchorShift: async () => { shifted += 1; pending = false; return { shifted: true, instrument: "ZEC/USD" }; } }],
    now: () => t, holdMs: 9000
  });
  const flat = { openPositionsCount: 0, signedNetReadOk: true, accountLocked: false, positionsReadFailed: false };
  assert.equal((await coordinator.beginVerifiedFlatRecovery(flat)).action, "HOLD_STARTED");
  assert.equal(held, true);
  t = 8_999; assert.equal((await coordinator.observe(flat)).action, "HOLDING");
  assert.equal(shifted, 0);
  t = 9_000; assert.equal((await coordinator.observe(flat)).action, "SHIFTED");
  assert.equal(shifted, 1); assert.equal(held, false);
  assert.equal((await coordinator.beginVerifiedFlatRecovery({ ...flat, openPositionsCount: 1 })).action, "RECOVERY_REFUSED");
});

function fixtureDefinition() {
  return buildGridDefinition({ instrument: "SOL/USD", marketSymbol: "SOLUSDT", orderPrefix: "SOL", geometry: { maDays: 200, bandPct: 0.05, deadZoneBands: 0, activeLevelsPerSide: 2, growth: 1.2, innerLevels: 1, innerPositionsPerRing: 1, outerPositionsPerRing: 2, rearmBands: 0.5 }, sizing: { capUsd: 500, lotStep: 0.01, roundTripCostFloorPct: 0.001 }, tranches: { weights: [1, 2, 3, 4], denominator: 10 } });
}

function memoryAnchorStore() {
  let state = null; const history = [];
  return { async load() { return state; }, async save(next) { state = structuredClone(next); return state; }, async appendHistory(row) { history.push(row); }, history };
}

function memoryGridStore() {
  let state = null;
  return { async init() {}, async load() { return state; }, async initializeIfMissing(value) { state = value; return state; }, async save(version, value) { assert.equal(version, state.version); state = value; return state; } };
}

test("5. a recenter resets previous price so an already-past ring waits for a fresh crossing", async () => {
  const grid = createRingGrid(fixtureDefinition()); const calls = []; const anchors = memoryAnchorStore();
  const instance = createRingGridInstance({ grid, stateStore: memoryGridStore(), anchorStore: anchors, maProvider: { async getCurrent() { return { ma: 100 }; } }, execution: { isEnabled: () => true, async executeIntent(intent) { calls.push(intent); return { status: "FILLED", fillPrice: intent.observedPrice, filledQuantity: intent.quantity, filledAt: iso(1), orderCode: "x" }; }, async executeProtectiveCut() {}, async executeProtectiveFlatten() {} } });
  await instance.init();
  await instance.process({ source: "binance", symbol: "SOLUSDT", price: 120, tradeTime: iso(1) });
  assert.equal((await instance.applyAnchorShift({ shiftedAt: iso(2) })).shifted, true);
  await instance.process({ source: "binance", symbol: "SOLUSDT", price: 120, tradeTime: iso(3) });
  assert.equal(calls.length, 0);
  await instance.process({ source: "binance", symbol: "SOLUSDT", price: 121, tradeTime: iso(4) });
  await instance.process({ source: "binance", symbol: "SOLUSDT", price: 119, tradeTime: iso(5) });
  assert.ok(calls.length >= 1);
});

test("6. multiplier, extremes, and history survive an instance restart", async () => {
  const grid = createRingGrid(fixtureDefinition()); const anchors = memoryAnchorStore(); const stateStore = memoryGridStore();
  const make = () => createRingGridInstance({ grid, stateStore, anchorStore: anchors, maProvider: { async getCurrent() { return { ma: 100 }; } }, execution: { isEnabled: () => false, async executeIntent() {}, async executeProtectiveCut() {}, async executeProtectiveFlatten() {} } });
  const first = make(); await first.init(); await first.process({ source: "binance", symbol: "SOLUSDT", price: 120, tradeTime: iso(1) });
  await new Promise((resolve) => setImmediate(resolve));
  const second = make(); await second.init(); assert.equal(second.getAnchorState().upperExtreme, 120);
  await second.applyAnchorShift({ shiftedAt: iso(2) }); assert.equal(anchors.history.length, 1); assert.notEqual(second.getAnchorState().multiplier, 1);
});

test("7. multiplier x1.0 reproduces existing ring candidates exactly", () => {
  const grid = createRingGrid(fixtureDefinition()); const state = grid.createInitialState();
  const today = grid.entryCandidates(state, { previousPrice: 89, price: 90, ma: 100 });
  const anchored = grid.entryCandidates(state, { previousPrice: 89, price: 90, ma: 100 * initialAnchorShiftState().multiplier });
  assert.deepEqual(anchored, today);
});

test("8. anchor command views render fixture state and unknown coin is clear", async () => {
  const service = createMultiInstrumentOwnerService({
    instrumentConfigs: [{ instrument: "SOL/USD", orderPrefix: "SOL", enabled: true }],
    recoverAnchors: async () => ({ action: "HOLD_STARTED", instruments: ["SOL/USD"] }),
    buildOwnerService: () => ({
      anchorSummaryLine: async () => "SOL/USD  ×1.0000  anchor $100.00 (MA $100.00)  excursion: none  shifts: 0",
      anchorText: async () => "SOL/USD ANCHOR DETAIL\nProjected shift: ×1.2414",
      anchorHistoryText: async () => "SOL/USD ANCHOR HISTORY\nNo shifts recorded.",
      anchorStatsText: async () => "SOL/USD ANCHOR STATS\nEntries: 0",
      inspectForRerun: async () => ({ instrument: "SOL/USD", ok: true, match: true, virtualNet: 0, brokerNet: 0, openLots: 0 })
    })
  });
  assert.match(await service.anchorsText(), /ANCHORS/);
  assert.match(await service.anchorText("SOL"), /Projected shift/);
  assert.match(await service.anchorHistoryText("SOL"), /HISTORY/);
  assert.match(await service.anchorStatsText("SOL"), /STATS/);
  assert.match(await service.anchorText("NOPE"), /Unknown instrument/);
  assert.match(await service.anchorRecoveryText(), /CONFIRM/);
  assert.match(await service.anchorRecoveryText("CONFIRM"), /HOLD STARTED/);
});
