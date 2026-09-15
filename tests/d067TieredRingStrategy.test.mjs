import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRingGrid } from "../src/strategies/ringGrid.js";
import { buildGridDefinition } from "../src/strategies/ringGridDefinition.js";
import { createRingGridInstance } from "../src/runtime/ringGridInstance.js";

const raw = JSON.parse(await readFile(new URL("../config/instruments.json", import.meta.url), "utf8"));
const OPENED_AT = "2026-09-15T00:00:00.000Z";
const FILLED_AT = "2026-09-15T00:01:00.000Z";

function gridFor(instrument) {
  const config = raw.instruments.find((entry) => entry.instrument === instrument);
  return createRingGrid(buildGridDefinition(config));
}

function addRingLot(grid, state, { tag, id, done = 0, normalExitTranches = done }) {
  const next = structuredClone(state);
  const ring = next.rings.find((candidate) => candidate.tag === tag);
  ring.lots.push({
    id,
    side: ring.side,
    ringTag: tag,
    entryPrice: 80,
    originalUnits: 10,
    remainingUnits: 10,
    done,
    normalExitTranches,
    openedAt: OPENED_AT,
    positionCode: id
  });
  ring.armed = false;
  return grid.normalizeState(next);
}

function candidatesAt(grid, state, tag, ma = 100) {
  const ring = state.rings.find((candidate) => candidate.tag === tag);
  const price = ma * (1 + ring.distance);
  return grid.entryCandidates(state, { previousPrice: price + 1, price, ma });
}

test("D-067 allocates exactly $200,000 across one active tiered side", () => {
  for (const instrument of ["SOL/USD", "DOGE/USD", "INJ/USD", "AAVE/USD", "AVAX/USD"]) {
    const grid = gridFor(instrument);
    const state = grid.createInitialState();
    const buyExposure = state.rings
      .filter((ring) => ring.side === "BUY")
      .reduce((total, ring) => total + (ring.usd * ring.capacity), 0);
    assert.equal(Number(buyExposure.toFixed(6)), 200000);
  }

  const sol = gridFor("SOL/USD").createInitialState();
  assert.equal(sol.rings.find((ring) => ring.tag === "BUY5").capacity, 1);
  assert.equal(sol.rings.find((ring) => ring.tag === "BUY6").capacity, 2);
  const doge = gridFor("DOGE/USD").createInitialState();
  assert.equal(doge.rings.find((ring) => ring.tag === "BUY6").capacity, 1);
  assert.equal(doge.rings.find((ring) => ring.tag === "BUY7").capacity, 2);
});

test("D-067 preserves a legacy inner two-lot state but disallows another inner entry", () => {
  const grid = gridFor("SOL/USD");
  let state = grid.createInitialState();
  state = addRingLot(grid, state, { tag: "BUY1", id: "legacy-1" });
  state = addRingLot(grid, state, { tag: "BUY1", id: "legacy-2" });
  const buy1 = state.rings.find((ring) => ring.tag === "BUY1");
  assert.equal(buy1.capacity, 1);
  assert.equal(buy1.lots.length, 2);
  assert.equal(candidatesAt(grid, state, "BUY1").some((candidate) => candidate.ringTag === "BUY1"), false);
});

test("D-067 applies the inner all-deeper gate and outer two-level gate per live lot", () => {
  const grid = gridFor("DOGE/USD");
  let state = grid.createInitialState();

  state = addRingLot(grid, state, { tag: "BUY7", id: "buy7-unreleased" });
  assert.equal(candidatesAt(grid, state, "BUY6").some((candidate) => candidate.ringTag === "BUY6"), false);
  state = grid.normalizeState({
    ...structuredClone(state),
    rings: structuredClone(state.rings).map((ring) => ring.tag === "BUY7"
      ? { ...ring, lots: ring.lots.map((lot) => ({ ...lot, done: 1, normalExitTranches: 1 })) }
      : ring)
  });
  assert.equal(candidatesAt(grid, state, "BUY6").some((candidate) => candidate.ringTag === "BUY6"), true);

  state = grid.createInitialState();
  state = addRingLot(grid, state, { tag: "BUY8", id: "buy8-unreleased" });
  assert.equal(candidatesAt(grid, state, "BUY7").some((candidate) => candidate.ringTag === "BUY7"), true);
  state = addRingLot(grid, state, { tag: "BUY9", id: "buy9-unreleased" });
  assert.equal(candidatesAt(grid, state, "BUY7").some((candidate) => candidate.ringTag === "BUY7"), false);
  state = grid.normalizeState({
    ...structuredClone(state),
    rings: structuredClone(state.rings).map((ring) => ring.tag === "BUY9"
      ? { ...ring, lots: ring.lots.map((lot) => ({ ...lot, done: 1, normalExitTranches: 1 })) }
      : ring)
  });
  assert.equal(candidatesAt(grid, state, "BUY7").some((candidate) => candidate.ringTag === "BUY7"), true);
  state = addRingLot(grid, state, { tag: "BUY10", id: "buy10-unreleased" });
  assert.equal(candidatesAt(grid, state, "BUY7").some((candidate) => candidate.ringTag === "BUY7"), false);
});

test("D-067 requires a broker-confirmed normal exit, not a recorded skipped tranche", () => {
  const grid = gridFor("DOGE/USD");
  let state = grid.createInitialState();
  state = addRingLot(grid, state, { tag: "BUY9", id: "buy9-skipped", done: 1, normalExitTranches: 0 });
  assert.equal(candidatesAt(grid, state, "BUY7").some((candidate) => candidate.ringTag === "BUY7"), false);
});

test("D-067 records a confirmed normal T1 as the nearer-ring release signal", () => {
  const grid = gridFor("DOGE/USD");
  let state = addRingLot(grid, grid.createInitialState(), { tag: "BUY9", id: "buy9" });
  const action = grid.nextExitAction(state, { price: 85, ma: 100 });
  assert.equal(action.forcedAtMovingAverage, undefined);
  assert.equal(action.tranche, 1);
  state = grid.applyConfirmedExit(state, action, { fillPrice: 85, filledQuantity: action.quantity, filledAt: FILLED_AT });
  assert.equal(state.rings.find((ring) => ring.tag === "BUY9").lots[0].normalExitTranches, 1);
  assert.equal(candidatesAt(grid, state, "BUY7").some((candidate) => candidate.ringTag === "BUY7"), true);
});

test("D-067 manual positions are exit-only but allow same-side ring entries", () => {
  const grid = gridFor("DOGE/USD");
  let state = grid.createInitialState();
  state = grid.adoptPosition(state, {
    id: "manual-long",
    side: "BUY",
    positionCode: "manual-long",
    entryPrice: 80,
    originalUnits: 10,
    remainingUnits: 10,
    openedAt: OPENED_AT,
    ma: 100
  });
  assert.equal(candidatesAt(grid, state, "BUY7").some((candidate) => candidate.ringTag === "BUY7"), true);
  assert.equal(candidatesAt(grid, state, "SELL1").some((candidate) => candidate.ringTag === "SELL1"), false);

  state = addRingLot(grid, grid.createInitialState(), { tag: "BUY10", id: "bot-long" });
  assert.equal(candidatesAt(grid, state, "SELL1").some((candidate) => candidate.ringTag === "SELL1"), false);
});

test("D-067 moving-average exit closes full remaining bot and manual lots", () => {
  const grid = gridFor("SOL/USD");
  let state = addRingLot(grid, grid.createInitialState(), { tag: "BUY6", id: "buy6" });
  const botAction = grid.nextMovingAverageExitAction(state, { price: 100, ma: 100 });
  assert.equal(botAction.forcedAtMovingAverage, true);
  assert.equal(botAction.quantity, 10);
  state = grid.applyConfirmedExit(state, botAction, { fillPrice: 100, filledQuantity: 10, filledAt: FILLED_AT });
  assert.equal(state.rings.find((ring) => ring.tag === "BUY6").lots.length, 0);

  state = grid.adoptPosition(grid.createInitialState(), {
    id: "manual-long",
    side: "BUY",
    positionCode: "manual-long",
    entryPrice: 80,
    originalUnits: 10,
    remainingUnits: 10,
    openedAt: OPENED_AT,
    ma: 100
  });
  const manualAction = grid.nextMovingAverageExitAction(state, { price: 100, ma: 100 });
  assert.equal(manualAction.adopted, true);
  state = grid.applyConfirmedExit(state, manualAction, { fillPrice: 100, filledQuantity: 10, filledAt: FILLED_AT });
  assert.equal(state.adopted.length, 0);
});

test("D-067 harvest remains absolute over the moving-average final exit", async () => {
  const grid = gridFor("SOL/USD");
  let state = addRingLot(grid, grid.createInitialState(), { tag: "BUY6", id: "buy6" });
  const submitted = [];
  const store = {
    async init() {},
    async load() { return state; },
    async initializeIfMissing(value) { state ??= value; return state; },
    async save(version, value) { assert.equal(version, state.version); state = value; return state; }
  };
  const instance = createRingGridInstance({
    grid,
    stateStore: store,
    maProvider: { async getCurrent() { return { ma: 100 }; } },
    execution: {
      isEnabled: () => true,
      async executeIntent(action) { submitted.push(action); return { status: "FILLED", fillPrice: 100, filledQuantity: action.quantity, filledAt: FILLED_AT, orderCode: "MA-EXIT" }; },
      async executeProtectiveCut() { throw new Error("not expected"); },
      async executeProtectiveFlatten() { throw new Error("not expected"); }
    }
  });
  await instance.init();
  await instance.setTrancheExitsPaused(true);
  await instance.process({ source: "binance", symbol: "SOLUSDT", price: 100, tradeTime: FILLED_AT });
  assert.equal(submitted.length, 0);
  assert.equal(state.rings.find((ring) => ring.tag === "BUY6").lots.length, 1);
});

test("D-067 executes the moving-average exit before considering any new entry", async () => {
  const grid = gridFor("SOL/USD");
  let state = addRingLot(grid, grid.createInitialState(), { tag: "BUY6", id: "buy6" });
  const submitted = [];
  const store = {
    async init() {},
    async load() { return state; },
    async initializeIfMissing(value) { state ??= value; return state; },
    async save(version, value) { assert.equal(version, state.version); state = value; return state; }
  };
  const instance = createRingGridInstance({
    grid,
    stateStore: store,
    maProvider: { async getCurrent() { return { ma: 100 }; } },
    execution: {
      isEnabled: () => true,
      async executeIntent(action) { submitted.push(action); return { status: "FILLED", fillPrice: 100, filledQuantity: action.quantity, filledAt: FILLED_AT, orderCode: "MA-EXIT" }; },
      async executeProtectiveCut() { throw new Error("not expected"); },
      async executeProtectiveFlatten() { throw new Error("not expected"); }
    }
  });
  await instance.init();
  await instance.process({ source: "binance", symbol: "SOLUSDT", price: 100, tradeTime: FILLED_AT });
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].forcedAtMovingAverage, true);
  assert.equal(state.rings.find((ring) => ring.tag === "BUY6").lots.length, 0);
});
