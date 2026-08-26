import test from "node:test";
import assert from "node:assert/strict";
import { createSolanaTradeifyService } from "../src/solanaTradeifyService.js";
import { createInitialSolanaState } from "../src/strategies/solanaGrid.js";

test("captureLiveSnapshot publishes sanitized telemetry and never includes secrets", async () => {
  const saved = [];
  const service = createSolanaTradeifyService({
    database: {
      async getState() {
        return {
          feed_stale: false,
          has_open_position: false,
          operator_killed: true,
          safety_halt: false,
          halt_reason: null
        };
      }
    },
    account: { startingBalance: 50000, maxLossOffset: 2000, dailyLossLimit: 1500 },
    strategy: {
      execution: { autoExecute: false },
      strategyStatus: "production-live-approved",
      instruments: { "BTC/USD": { enabled: false }, "SOL/USD": { enabled: true } }
    },
    environment: { appMode: "live", autoExecute: false },
    persistence: {
      state: { async load() { return createInitialSolanaState(); } },
      async getLatestRiskLadderState() { return { dayKey: "2026-08-26", brakeEngaged: false, partialCutDone: false, flattenDone: false, haltedForDay: false }; }
    },
    maProvider: { getCurrent: async () => ({ ma: 100.5, completedThrough: "2026-08-25" }) },
    execution: { isEnabled: () => false },
    getLiveMarketSnapshot: () => ({ price: 94.2, tradeTime: "2026-08-26T16:00:00.000Z", stale: false }),
    getAccountStatus: () => ({ snapshot: { instrumentPosition: null, accountLocked: false }, fresh: true }),
    saveLiveSnapshot: async (snapshot) => { saved.push(snapshot); }
  });

  const snapshot = await service.captureLiveSnapshot();
  assert.equal(saved.length, 1);
  assert.equal(snapshot.virtualNetUnits, 0);
  assert.equal(snapshot.brokerNetUnits, 0);
  assert.equal(snapshot.mismatch, false);
  assert.equal(snapshot.operatorPaused, true);
  assert.equal(snapshot.ma, 100.5);
  assert.equal(JSON.stringify(snapshot).includes("postgres"), false);
});
