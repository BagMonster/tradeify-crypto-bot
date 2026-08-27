import test from "node:test";
import assert from "node:assert/strict";
import { createSolanaRuntime } from "../src/runtime/solanaRuntime.js";
import { createInitialSolanaState, expectedNetUnits } from "../src/strategies/solanaGrid.js";

const config = Object.freeze({
  enabled: true,
  entryBrakeUsd: 300,
  partialCutUsd: 1000,
  partialCutFraction: 0.5,
  fullFlattenUsd: 1250,
  protectiveOrdersBypassSlippageCap: true,
  resumeAfterFlatten: "nextDailyRollover"
});

test("a few cents of DXtrade day-open wobble does not halt the grid", async () => {
  const state = createInitialSolanaState();
  const store = {
    init: async () => {},
    load: async () => state,
    initializeIfMissing: async (candidate) => candidate,
    save: async (_expected, next) => next
  };
  const ladder = {
    async getLatestRiskLadderState() {
      return {
        dayKey: "2026-08-26",
        baselineClosedBalanceUsd: 49999.87,
        brakeEngaged: false,
        partialCutDone: false,
        flattenDone: false,
        haltedForDay: false,
        worstDrawdownUsd: 0
      };
    },
    async saveRiskLadderState(input) { return input; }
  };
  const runtime = createSolanaRuntime({
    stateStore: store,
    riskLadderStore: ladder,
    riskLadderConfig: config,
    maProvider: { getCurrent: async () => ({ ma: 81.41, completedThrough: "2026-08-27T00:00:00.000Z" }) },
    getRiskSnapshot: async () => ({
      startingBalance: 50_000,
      maxLossOffset: 3_000,
      peakClosedBalance: 50_000,
      payoutTaken: false,
      previousDayClosingBalance: 49999.83,
      dailyLossLimit: 1_500,
      liveEquity: 49993.30,
      currentNotional: 111,
      maxNotional: 100_000,
      operatorPaused: false,
      safetyHalt: false,
      accountLocked: false,
      feedHealthy: true,
      accountDataFresh: true,
      nettingConfirmed: true,
      brokerNetUnits: expectedNetUnits(state)
    }),
    execution: {
      isEnabled: () => false,
      executeIntent: async () => ({ status: "SKIPPED" }),
      executeProtectiveCut: async () => ({ status: "SKIPPED" }),
      executeProtectiveFlatten: async () => ({ status: "SKIPPED" })
    }
  });
  await runtime.init();
  const result = await runtime.processTrade({
    source: "binance",
    symbol: "SOLUSDT",
    price: 103.6,
    tradeTime: "2026-08-27T08:09:38.538Z"
  });
  assert.notEqual(result.status, "D049_BASELINE_MISMATCH");
  assert.equal(result.ladderVerdict.action, "NORMAL");
});
