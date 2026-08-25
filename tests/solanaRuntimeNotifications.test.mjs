import test from "node:test";
import assert from "node:assert/strict";
import { createSolanaRuntime } from "../src/runtime/solanaRuntime.js";
import {
  applyConfirmedEntry,
  applyConfirmedExit,
  createInitialSolanaState,
  expectedNetUnits
} from "../src/strategies/solanaGrid.js";

function baseRisk(brokerNetUnits = 0) {
  return {
    startingBalance: 50_000,
    maxLossOffset: 3_000,
    peakClosedBalance: 50_000,
    payoutTaken: false,
    previousDayClosingBalance: 50_000,
    dailyLossLimit: 1_500,
    liveEquity: 50_000,
    currentNotional: 0,
    maxNotional: 100_000,
    operatorPaused: false,
    safetyHalt: false,
    accountLocked: false,
    feedHealthy: true,
    accountDataFresh: true,
    nettingConfirmed: true,
    brokerNetUnits
  };
}

function createRiskLadderStore() {
  let row = null;
  return {
    async getLatestRiskLadderState() { return row; },
    async saveRiskLadderState(input) { row = Object.freeze({ ...input }); return row; }
  };
}

const riskLadderConfig = Object.freeze({
  enabled: true,
  entryBrakeUsd: 300,
  partialCutUsd: 1000,
  partialCutFraction: 0.5,
  fullFlattenUsd: 1250,
  protectiveOrdersBypassSlippageCap: true,
  resumeAfterFlatten: "nextDailyRollover"
});

function stateAtFinalTranche() {
  let state = createInitialSolanaState();
  state = applyConfirmedEntry(state, {
    type: "ENTRY",
    stateVersion: 0,
    ringTag: "BUY1",
    side: "BUY",
    quantity: 0.1,
    lotId: "BUY1-V0"
  }, {
    fillPrice: 100,
    filledQuantity: 0.1,
    filledAt: "2026-08-24T10:00:00.000Z"
  });

  const exits = [
    { tranche: 1, quantity: 0.01, fillPrice: 105, filledAt: "2026-08-24T11:00:00.000Z" },
    { tranche: 2, quantity: 0.02, fillPrice: 110, filledAt: "2026-08-24T12:00:00.000Z" },
    { tranche: 3, quantity: 0.03, fillPrice: 115, filledAt: "2026-08-24T13:00:00.000Z" }
  ];

  for (const exit of exits) {
    state = applyConfirmedExit(state, {
      type: "EXIT",
      stateVersion: state.version,
      ringTag: "BUY1",
      lotId: "BUY1-V0",
      tranche: exit.tranche,
      quantity: exit.quantity,
      side: "SELL"
    }, exit);
  }
  return state;
}

test("final confirmed tranche emits both tranche-exit and fully-closed-lot notifications after state save", async () => {
  let state = stateAtFinalTranche();
  const observed = [];
  let saveCount = 0;
  const store = {
    init: async () => {},
    load: async () => state,
    initializeIfMissing: async (candidate) => { if (!state) state = candidate; return state; },
    save: async (expectedVersion, next) => {
      assert.equal(state.version, expectedVersion);
      state = next;
      saveCount += 1;
      return state;
    }
  };

  const runtime = createSolanaRuntime({
    stateStore: store,
    riskLadderStore: createRiskLadderStore(),
    riskLadderConfig,
    maProvider: { getCurrent: async () => ({ ma: 120, completedThrough: "2026-08-24T00:00:00.000Z" }) },
    getRiskSnapshot: async () => baseRisk(expectedNetUnits(state)),
    minimumHoldSeconds: 25,
    execution: {
      isEnabled: () => true,
      executeProtectiveCut: async () => ({ status: "ALREADY_FLAT" }),
      executeProtectiveFlatten: async () => ({ status: "ALREADY_FLAT" }),
      executeIntent: async (intent) => ({
        status: "FILLED",
        confirmed: true,
        orderCode: `SOLGRID-${intent.stateVersion}-${intent.tag}-X${intent.tranche}`,
        fillPrice: 120,
        filledQuantity: intent.quantity,
        filledAt: "2026-08-24T14:00:00.000Z"
      })
    },
    notifications: {
      enqueue(event) {
        assert.ok(saveCount > 0, "notification must occur after durable state save");
        observed.push(event);
        return { status: "QUEUED" };
      }
    }
  });

  await runtime.init();
  const result = await runtime.processTrade({
    source: "binance",
    symbol: "SOLUSDT",
    price: 120,
    tradeTime: "2026-08-24T14:00:00.000Z"
  });

  assert.equal(result.status, "PROCESSED");
  assert.deepEqual(observed.map((event) => event.kind), [
    "TRANCHE_EXIT_CONFIRMED",
    "LOT_CLOSED"
  ]);
  assert.equal(observed[0].tranche, 4);
  assert.equal(observed[0].remainingQuantity, 0);
  assert.equal(observed[1].lotId, "BUY1-V0");
  assert.equal(observed[1].entryPrice, 100);
  assert.equal(observed[1].originalQuantity, 0.1);
});
