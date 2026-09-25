import test from "node:test";
import assert from "node:assert/strict";
import { loadProfiledConfigFiles } from "../src/config/accountProfile.js";
import { buildGridDefinition } from "../src/strategies/ringGridDefinition.js";
import { createRingGrid } from "../src/strategies/ringGrid.js";
import { createRingGridInstance } from "../src/runtime/ringGridInstance.js";
import { formatLiveTelegramNotification } from "../src/notifications/liveTelegramNotifications.js";
import {
  accountDayStartMs,
  createDailyDustCleanupCoordinator,
  dustCleanupDue,
  dustLossBudgetUsd
} from "../src/risk/dailyDustCleanup.js";

const { instruments: raw } = await loadProfiledConfigFiles("10k");

test("daily dust cleanup uses the 22:00 UTC account day and the shallowest cut tier's percentage", () => {
  assert.equal(accountDayStartMs("2026-09-25"), Date.parse("2026-09-24T22:00:00.000Z"));
  assert.equal(dustCleanupDue({ nowMs: Date.parse("2026-09-25T22:02:59.999Z") }), false);
  assert.equal(dustCleanupDue({ nowMs: Date.parse("2026-09-25T22:03:00.000Z") }), true);
  assert.equal(dustLossBudgetUsd([{ thresholdUsd: 100 }, { thresholdUsd: 200 }]), 2);
  assert.equal(dustLossBudgetUsd([{ thresholdUsd: 1000 }, { thresholdUsd: 2000 }]), 20);
});

test("dust scan includes legacy bot lots for later exact-ticket resolution", () => {
  const grid = createRingGrid(buildGridDefinition(raw.instruments.find((entry) => entry.instrument === "SOL/USD")));
  const cutoff = accountDayStartMs("2026-09-25");
  const state = structuredClone(grid.createInitialState());
  const ring = state.rings.find((entry) => entry.tag === "BUY1");
  const newDayRing = state.rings.find((entry) => entry.tag === "BUY2");
  const tooLargeRing = state.rings.find((entry) => entry.tag === "BUY3");
  const legacyRing = state.rings.find((entry) => entry.tag === "BUY4");
  const intended = 10;
  ring.lots.push({ id: "old-dust", side: "BUY", ringTag: "BUY1", entryPrice: ring.usd / intended, originalUnits: 1, intendedUnits: intended, remainingUnits: 1, done: 1, normalExitTranches: 1, openedAt: "2026-09-24T21:59:59.000Z", positionCode: "old-dust" });
  newDayRing.lots.push({ id: "new-day", side: "BUY", ringTag: "BUY2", entryPrice: newDayRing.usd / intended, originalUnits: 1, intendedUnits: intended, remainingUnits: 1, done: 1, normalExitTranches: 1, openedAt: "2026-09-24T22:00:00.000Z", positionCode: "new-day" });
  tooLargeRing.lots.push({ id: "too-large", side: "BUY", ringTag: "BUY3", entryPrice: tooLargeRing.usd / intended, originalUnits: 2, intendedUnits: intended, remainingUnits: 2, done: 1, normalExitTranches: 1, openedAt: "2026-09-24T21:00:00.000Z", positionCode: "too-large" });
  legacyRing.lots.push({ id: "legacy-dust", side: "BUY", ringTag: "BUY4", entryPrice: legacyRing.usd / intended, originalUnits: 1, intendedUnits: intended, remainingUnits: 1, done: 1, normalExitTranches: 1, openedAt: "2026-09-24T21:00:00.000Z", positionCode: null });
  ring.armed = false;
  newDayRing.armed = false;
  tooLargeRing.armed = false;
  legacyRing.armed = false;
  state.adopted.push({ id: "manual", adopted: true, side: "BUY", positionCode: "manual", entryPrice: 100, originalUnits: 1, remainingUnits: 1, done: 0, openedAt: "2026-09-24T21:00:00.000Z", ma: 100 });
  const candidates = grid.dustCleanupCandidates(grid.normalizeState(state), { openedBeforeMs: cutoff, maxRemainingFraction: 0.10 });
  assert.deepEqual(candidates.map((candidate) => candidate.positionCode), ["old-dust", null]);
  assert.equal(candidates[1].needsLegacyTicketLink, true);
  const scan = grid.dustCleanupScan(grid.normalizeState(state), { openedBeforeMs: cutoff, maxRemainingFraction: 0.10 });
  assert.deepEqual(scan.excluded, {
    currentAccountDay: 1,
    missingPositionCode: 0,
    noIntendedUnits: 0,
    aboveMaximumFraction: 1
  });
});

test("coordinator persists confirmed loss after every close and completes once", async () => {
  let state = { dayKey: "2026-09-25", autoLossUsd: 0, completedAt: null };
  const saves = [];
  const coordinator = createDailyDustCleanupCoordinator({
    accountRisk: { cutTiers: [{ thresholdUsd: 100, fraction: 0.1 }], dustCleanup: { maxRemainingFraction: 0.1, lossBudgetFraction: 0.02, minuteUtc: 3 } },
    books: [{
      instrument: "SOL/USD",
      isExecutionEnabled: () => true,
      isMarketReady: () => true,
      async runDustCleanup(args) {
        const fill = { realizedPnlUsd: -1.25 };
        await args.onConfirmedClose(fill);
        return { closed: [fill], deferred: [{ reason: "LOSS_BUDGET" }], failed: [] };
      }
    }],
    store: {
      async getDailyDustCleanupState() { return state; },
      async saveDailyDustCleanupState(next) { saves.push(next); state = { ...next }; return state; }
    },
    now: () => Date.parse("2026-09-25T22:03:00.000Z")
  });
  const result = await coordinator.run();
  assert.equal(result.action, "COMPLETED");
  assert.equal(result.autoLossUsd, 1.25);
  assert.equal(saves.length, 2);
  assert.equal(saves.at(-1).completedAt, "2026-09-25T22:03:00.000Z");
  assert.equal((await coordinator.run()).action, "ALREADY_COMPLETED");
});

test("coordinator sends a completed no-op summary with exclusion counts", async () => {
  let state = { dayKey: "2026-09-26", autoLossUsd: 0, completedAt: null };
  const notifications = [];
  const coordinator = createDailyDustCleanupCoordinator({
    accountRisk: { cutTiers: [{ thresholdUsd: 100, fraction: 0.1 }] },
    books: [{
      instrument: "SOL/USD",
      isExecutionEnabled: () => true,
      isMarketReady: () => true,
      async runDustCleanup() {
        return {
          candidates: [],
          excluded: { currentAccountDay: 3, missingPositionCode: 2, noIntendedUnits: 0, aboveMaximumFraction: 1 },
          closed: [], deferred: [], failed: []
        };
      }
    }],
    store: {
      async getDailyDustCleanupState() { return state; },
      async saveDailyDustCleanupState(next) { state = { ...next }; return state; }
    },
    notifications: { enqueue(event) { notifications.push(event); } },
    now: () => Date.parse("2026-09-25T22:03:00.000Z")
  });
  const result = await coordinator.run();
  assert.equal(result.action, "COMPLETED");
  assert.deepEqual(notifications, [{
    kind: "DUST_CLEANUP_SUMMARY",
    eventKey: "DUST-CLEANUP:2026-09-26:20260925220300000",
    dayKey: "2026-09-26",
    candidateCount: 0,
    excludedCurrentAccountDay: 3,
    excludedMissingPositionCode: 2,
    excludedNoIntendedUnits: 0,
    excludedAboveMaximumFraction: 1,
    closedCount: 0,
    deferredCount: 0,
    failedCount: 0,
    autoLossUsd: 0,
    lossBudgetUsd: 2,
    closed: []
  }]);
});

test("dust cleanup notification makes a no-op and its exclusions visible", () => {
  const rendered = formatLiveTelegramNotification({
    kind: "DUST_CLEANUP_SUMMARY",
    eventKey: "DUST-CLEANUP:2026-09-26:20260925T220300000Z",
    dayKey: "2026-09-26",
    candidateCount: 0,
    excludedCurrentAccountDay: 3,
    excludedMissingPositionCode: 2,
    excludedNoIntendedUnits: 0,
    excludedAboveMaximumFraction: 1,
    closedCount: 0,
    deferredCount: 0,
    failedCount: 0,
    autoLossUsd: 0,
    lossBudgetUsd: 2
  });
  assert.match(rendered.message, /Eligible bot-owned residual tickets: 0/);
  assert.match(rendered.message, /3 opened this account day/);
  assert.match(rendered.message, /2 without an exact broker ticket ID/);
});

test("dust cleanup notification lists each confirmed ring close", () => {
  const rendered = formatLiveTelegramNotification({
    kind: "DUST_CLEANUP_SUMMARY",
    eventKey: "DUST-CLEANUP:2026-09-25:20260925T041500000Z",
    dayKey: "2026-09-25",
    candidateCount: 2,
    excludedCurrentAccountDay: 0,
    excludedMissingPositionCode: 0,
    excludedNoIntendedUnits: 0,
    excludedAboveMaximumFraction: 0,
    closedCount: 2,
    deferredCount: 0,
    failedCount: 0,
    autoLossUsd: 0.73,
    lossBudgetUsd: 2,
    closed: [
      { instrument: "SOL/USD", ringTag: "SELL6", filledQuantity: 0.04, realizedPnlUsd: -0.12 },
      { instrument: "INJ/USD", ringTag: "SELL3", filledQuantity: 0.07, realizedPnlUsd: 0.03 }
    ]
  });
  assert.match(rendered.message, /Confirmed closes:/);
  assert.match(rendered.message, /SOL\/USD SELL6 · 0.04 SOL · −\$0\.12/);
  assert.match(rendered.message, /INJ\/USD SELL3 · 0.07 INJ · \+\$0\.03/);
});

test("runtime releases a dust ring only after an exact confirmed broker close", async () => {
  const grid = createRingGrid(buildGridDefinition(raw.instruments.find((entry) => entry.instrument === "SOL/USD")));
  let state = structuredClone(grid.createInitialState());
  const ring = state.rings.find((entry) => entry.tag === "BUY1");
  ring.lots.push({ id: "dust", side: "BUY", ringTag: "BUY1", entryPrice: 100, originalUnits: 0.1, intendedUnits: 1, remainingUnits: 0.1, done: 1, normalExitTranches: 1, openedAt: "2026-09-24T21:00:00.000Z", positionCode: "DX-DUST" });
  ring.armed = false;
  state = grid.normalizeState(state);
  const requested = [];
  const instance = createRingGridInstance({
    grid,
    stateStore: {
      async init() {},
      async load() { return state; },
      async initializeIfMissing(value) { state ??= value; return state; },
      async save(version, next) { assert.equal(version, state.version); state = next; return state; }
    },
    maProvider: { async getCurrent() { return { ma: 100 }; } },
    execution: {
      isEnabled: () => true,
      async executeIntent() { throw new Error("not expected"); },
      async executeProtectiveCut() { throw new Error("not expected"); },
      async executeProtectiveFlatten() { throw new Error("not expected"); },
      async executeDustCleanup(input) {
        requested.push(input);
        return { status: "FILLED", orderCode: "DUST-CLOSE", fillPrice: 101, filledQuantity: 0.1, filledAt: "2026-09-25T22:03:00.000Z" };
      }
    }
  });
  await instance.init();
  const result = await instance.cleanupDust({ dayKey: "2026-09-25", openedBeforeMs: accountDayStartMs("2026-09-25"), maxRemainingFraction: 0.1, remainingLossBudgetUsd: 2, markPrice: 101 });
  assert.equal(result.closed.length, 1);
  assert.equal(requested[0].positionCode, "DX-DUST");
  assert.equal(state.rings.find((entry) => entry.tag === "BUY1").lots.length, 0);
  assert.equal(state.rings.find((entry) => entry.tag === "BUY1").armed, true);
});

test("runtime closes a legacy dust lot only after an exact ticket link", async () => {
  const grid = createRingGrid(buildGridDefinition(raw.instruments.find((entry) => entry.instrument === "SOL/USD")));
  let state = structuredClone(grid.createInitialState());
  const ring = state.rings.find((entry) => entry.tag === "SELL1");
  ring.lots.push({ id: "legacy-dust", side: "SELL", ringTag: "SELL1", entryPrice: 100, originalUnits: 0.1, intendedUnits: 1, remainingUnits: 0.1, done: 1, normalExitTranches: 1, openedAt: "2026-09-24T21:00:00.000Z", positionCode: null });
  ring.armed = false;
  state = grid.normalizeState(state);
  const requested = [];
  const instance = createRingGridInstance({
    grid,
    stateStore: {
      async init() {},
      async load() { return state; },
      async initializeIfMissing(value) { state ??= value; return state; },
      async save(version, next) { assert.equal(version, state.version); state = next; return state; }
    },
    maProvider: { async getCurrent() { return { ma: 100 }; } },
    execution: {
      isEnabled: () => true,
      async executeIntent() { throw new Error("not expected"); },
      async executeProtectiveCut() { throw new Error("not expected"); },
      async executeProtectiveFlatten() { throw new Error("not expected"); },
      async resolveLegacyDustTicket(input) {
        assert.deepEqual(input, { lotId: "legacy-dust", virtualSide: "SELL", quantity: 0.1 });
        return { status: "LINKED", positionCode: "DX-LEGACY" };
      },
      async executeDustCleanup(input) {
        requested.push(input);
        return { status: "FILLED", orderCode: "DUST-LEGACY", fillPrice: 99, filledQuantity: 0.1, filledAt: "2026-09-25T22:03:00.000Z" };
      }
    }
  });
  await instance.init();
  const result = await instance.cleanupDust({ dayKey: "2026-09-25", openedBeforeMs: accountDayStartMs("2026-09-25"), maxRemainingFraction: 0.1, remainingLossBudgetUsd: 2, markPrice: 99 });
  assert.equal(result.closed.length, 1);
  assert.equal(requested[0].positionCode, "DX-LEGACY");
  assert.equal(state.rings.find((entry) => entry.tag === "SELL1").lots.length, 0);
  assert.equal(state.rings.find((entry) => entry.tag === "SELL1").armed, true);
});
