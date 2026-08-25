import test from "node:test";
import assert from "node:assert/strict";
import { createSolanaRuntime } from "../src/runtime/solanaRuntime.js";
import {
  applyConfirmedEntry,
  createInitialSolanaState,
  entryCandidates,
  expectedNetUnits
} from "../src/strategies/solanaGrid.js";

const config = Object.freeze({
  enabled: true,
  entryBrakeUsd: 300,
  partialCutUsd: 1000,
  partialCutFraction: 0.5,
  fullFlattenUsd: 1250,
  protectiveOrdersBypassSlippageCap: true,
  resumeAfterFlatten: "nextDailyRollover"
});

function stateStore(initial = createInitialSolanaState()) {
  let state = initial;
  return {
    get value() { return state; },
    init: async () => {},
    load: async () => state,
    initializeIfMissing: async (candidate) => { if (!state) state = candidate; return state; },
    save: async (expected, next) => {
      assert.equal(state.version, expected);
      state = next;
      return state;
    }
  };
}

function ladderStore(initial = null) {
  let row = initial;
  return {
    get value() { return row; },
    async getLatestRiskLadderState() { return row; },
    async saveRiskLadderState(input) { row = Object.freeze({ ...input }); return row; }
  };
}

function risk({ brokerNetUnits = 0, equity = 50_000, fresh = true } = {}) {
  return {
    startingBalance: 50_000,
    maxLossOffset: 3_000,
    peakClosedBalance: 50_000,
    payoutTaken: false,
    previousDayClosingBalance: 50_000,
    dailyLossLimit: 1_500,
    liveEquity: equity,
    currentNotional: Math.abs(brokerNetUnits) * 85,
    maxNotional: 100_000,
    operatorPaused: false,
    safetyHalt: false,
    accountLocked: false,
    feedHealthy: true,
    accountDataFresh: fresh,
    nettingConfirmed: true,
    brokerNetUnits
  };
}

function oneLongLot() {
  const initial = createInitialSolanaState();
  const intent = entryCandidates(initial, { previousPrice: 90, price: 86.5, ma: 100 }).find((x) => x.tag === "BUY1");
  return applyConfirmedEntry(initial, intent, {
    fillPrice: 86.5,
    filledQuantity: intent.quantity,
    filledAt: "2026-08-24T19:00:00.000Z"
  });
}

function runtime({ store, ladder, equity, execution, notifications = null, fresh = true }) {
  return createSolanaRuntime({
    stateStore: store,
    riskLadderStore: ladder,
    riskLadderConfig: config,
    maProvider: { getCurrent: async () => ({ ma: 100, completedThrough: "2026-08-24T00:00:00.000Z" }) },
    getRiskSnapshot: async () => risk({ brokerNetUnits: expectedNetUnits(store.value), equity, fresh }),
    execution,
    notifications
  });
}

test("D-049 -$300 brake blocks a crossed ring while normal exits remain available", async () => {
  const store = stateStore();
  const ladder = ladderStore();
  let entries = 0;
  const engine = runtime({
    store,
    ladder,
    equity: 49_700,
    execution: {
      isEnabled: () => true,
      executeProtectiveCut: async () => ({ status: "FILLED" }),
      executeProtectiveFlatten: async () => ({ status: "ALREADY_FLAT" }),
      executeIntent: async () => { entries += 1; throw new Error("entry must stay braked"); }
    }
  });
  await engine.init();
  await engine.processTrade({ source: "binance", symbol: "SOLUSDT", price: 90, tradeTime: "2026-08-24T20:00:00.000Z" });
  const result = await engine.processTrade({ source: "binance", symbol: "SOLUSDT", price: 86.4, tradeTime: "2026-08-24T20:00:01.000Z" });
  assert.equal(entries, 0);
  assert.equal(ladder.value.brakeEngaged, true);
  assert.equal(result.ladderVerdict.action, "BRAKE");
});

test("D-049 -$1,000 cut halves each executable virtual lot and persists one-cut state", async () => {
  const store = stateStore(oneLongLot());
  const ladder = ladderStore();
  const notified = [];
  let cuts = 0;
  const engine = runtime({
    store,
    ladder,
    equity: 49_000,
    execution: {
      isEnabled: () => true,
      executeProtectiveCut: async ({ quantity, side }) => {
        cuts += 1;
        assert.equal(quantity, 0.16);
        assert.equal(side, "SELL");
        return {
          status: "FILLED",
          confirmed: true,
          orderCode: "SOLCUT-20260824-1",
          fillPrice: 84,
          filledQuantity: 0.16,
          filledAt: "2026-08-24T20:00:00.000Z"
        };
      },
      executeProtectiveFlatten: async () => ({ status: "ALREADY_FLAT" }),
      executeIntent: async () => { throw new Error("entries are braked after cut"); }
    },
    notifications: { enqueue: (event) => { notified.push(event); return { status: "QUEUED" }; } }
  });
  await engine.init();
  await engine.processTrade({ source: "binance", symbol: "SOLUSDT", price: 84, tradeTime: "2026-08-24T20:00:00.000Z" });
  assert.equal(cuts, 1);
  assert.equal(ladder.value.partialCutDone, true);
  const lot = store.value.rings.find((r) => r.tag === "BUY1").lots[0];
  assert.equal(lot.originalUnits, 0.17);
  assert.equal(lot.remainingUnits, 0.17);
  assert.equal(notified.find((x) => x.kind === "D049_PARTIAL_CUT")?.lotsAffected, 1);

  await engine.processTrade({ source: "binance", symbol: "SOLUSDT", price: 83, tradeTime: "2026-08-24T20:00:01.000Z" });
  assert.equal(cuts, 1, "partial cut must not repeat in the same account day");
});

test("D-049 -$1,250 full flatten resets grid and halts through the account day", async () => {
  const store = stateStore(oneLongLot());
  const ladder = ladderStore();
  const notified = [];
  let flattens = 0;
  const engine = runtime({
    store,
    ladder,
    equity: 48_750,
    execution: {
      isEnabled: () => true,
      executeProtectiveCut: async () => { throw new Error("cut must not outrank flatten"); },
      executeProtectiveFlatten: async ({ dayKey, bypassSlippageCap }) => {
        flattens += 1;
        assert.equal(dayKey, "2026-08-24");
        assert.equal(bypassSlippageCap, true);
        return {
          status: "FILLED",
          fillPrice: 82,
          filledQuantity: 0.33,
          filledAt: "2026-08-24T20:00:00.000Z"
        };
      },
      executeIntent: async () => { throw new Error("no normal action may run after full flatten"); }
    },
    notifications: { enqueue: (event) => { notified.push(event); return { status: "QUEUED" }; } }
  });
  await engine.init();
  const first = await engine.processTrade({ source: "binance", symbol: "SOLUSDT", price: 82, tradeTime: "2026-08-24T20:00:00.000Z" });
  assert.equal(first.status, "D049_FULL_FLATTENED");
  assert.equal(flattens, 1);
  assert.equal(ladder.value.flattenDone, true);
  assert.equal(ladder.value.haltedForDay, true);
  assert.equal(store.value.rings.every((ring) => ring.lots.length === 0 && ring.armed), true);
  assert.equal(notified.some((x) => x.kind === "D049_FULL_FLATTEN"), true);

  const second = await engine.processTrade({ source: "binance", symbol: "SOLUSDT", price: 81, tradeTime: "2026-08-24T20:00:01.000Z" });
  assert.equal(second.status, "D049_HALTED_FOR_DAY");
  assert.equal(flattens, 1);
});

test("D-049 unknown fresh account inputs fail closed without guessing a cut or flatten", async () => {
  const store = stateStore();
  const ladder = ladderStore();
  let orders = 0;
  const engine = runtime({
    store,
    ladder,
    equity: 49_000,
    fresh: false,
    execution: {
      isEnabled: () => true,
      executeProtectiveCut: async () => { orders += 1; },
      executeProtectiveFlatten: async () => { orders += 1; },
      executeIntent: async () => { orders += 1; }
    }
  });
  await engine.init();
  const result = await engine.processTrade({ source: "binance", symbol: "SOLUSDT", price: 86.4, tradeTime: "2026-08-24T20:00:00.000Z" });
  assert.equal(result.status, "D049_ACCOUNT_INPUT_UNAVAILABLE");
  assert.equal(orders, 0);
});
