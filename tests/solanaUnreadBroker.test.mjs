import test from "node:test";
import assert from "node:assert/strict";
import { createSolanaRuntime } from "../src/runtime/solanaRuntime.js";
import {
  applyConfirmedEntry,
  createInitialSolanaState,
  entryCandidates
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

function shortLotState() {
  const initial = createInitialSolanaState();
  const intent = entryCandidates(initial, { previousPrice: 90, price: 95.91, ma: 81.41 })
    .find((item) => item.side === "SELL") ?? {
    tag: "SELL2",
    ringTag: "SELL2",
    side: "SELL",
    quantity: 0.44,
    usd: 42,
    ringLevel: 2
  };
  return applyConfirmedEntry(initial, {
    ...intent,
    stateVersion: initial.version,
    lotId: "SELL2-V1"
  }, {
    fillPrice: 95.91,
    filledQuantity: intent.quantity ?? 0.44,
    filledAt: "2026-08-26T15:59:10.937Z"
  });
}

function stores(state) {
  return {
    stateStore: {
      init: async () => {},
      load: async () => state,
      initializeIfMissing: async () => state,
      save: async () => state
    },
    riskLadderStore: {
      getLatestRiskLadderState: async () => null,
      saveRiskLadderState: async (row) => row
    }
  };
}

test("an unread broker net blocks without raising a reconciliation mismatch halt", async () => {
  const events = [];
  const { stateStore, riskLadderStore } = stores(shortLotState());
  const runtime = createSolanaRuntime({
    stateStore,
    riskLadderStore,
    riskLadderConfig: config,
    maProvider: { getCurrent: async () => ({ ma: 81.41, completedThrough: "2026-08-27T00:00:00.000Z" }) },
    getRiskSnapshot: async () => ({
      startingBalance: 50_000,
      maxLossOffset: 3_000,
      peakClosedBalance: 50_000,
      payoutTaken: false,
      previousDayClosingBalance: 50_000,
      dailyLossLimit: 1_500,
      liveEquity: 49_999.9,
      currentNotional: 0,
      maxNotional: 100_000,
      operatorPaused: true,
      safetyHalt: true,
      accountLocked: true,
      feedHealthy: true,
      accountDataFresh: false,
      nettingConfirmed: true,
      brokerNetUnits: null
    }),
    execution: {
      isEnabled: () => true,
      executeIntent: async () => { throw new Error("unread broker must not trade"); },
      executeProtectiveCut: async () => ({ status: "PENDING" }),
      executeProtectiveFlatten: async () => ({ status: "PENDING" })
    },
    addEvent: async (level, kind, payload) => { events.push({ level, kind, payload }); }
  });
  await runtime.init();
  const result = await runtime.processTrade({
    source: "binance",
    symbol: "SOLUSDT",
    price: 95.5,
    tradeTime: "2026-08-26T16:05:00.000Z"
  });
  assert.equal(result.status, "ACCOUNT_DATA_UNAVAILABLE");
  assert.equal(result.reconciliation.unread, true);
  assert.equal(result.reconciliation.actual, null);
  assert.equal(events.some((event) => event.kind === "SOL_NET_RECONCILIATION_MISMATCH"), false);
  assert.equal(events.some((event) => event.kind === "SOL_BROKER_NET_UNAVAILABLE"), true);
});
