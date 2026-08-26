import test from "node:test";
import assert from "node:assert/strict";
import { createInitialSolanaState } from "../src/strategies/solanaGrid.js";
import { captureSolanaLiveSnapshot } from "../src/solanaLiveSnapshotCapture.js";

test("captureLiveSnapshot publishes sanitized telemetry and never includes secrets", async () => {
  const saved = [];
  const snapshot = await captureSolanaLiveSnapshot({
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
    persistence: {
      state: { async load() { return createInitialSolanaState(); } },
      async getLatestRiskLadderState() { return { dayKey: "2026-08-26", brakeEngaged: false, partialCutDone: false, flattenDone: false, haltedForDay: false }; }
    },
    maProvider: { getCurrent: async () => ({ ma: 100.5, completedThrough: "2026-08-25" }) },
    execution: { isEnabled: () => false },
    getLiveMarketSnapshot: () => ({ price: 94.2, tradeTime: "2026-08-26T16:00:00.000Z", stale: false }),
    getAccountStatus: () => ({ snapshot: { instrumentPosition: null, accountLocked: false }, fresh: true }),
    saveLiveSnapshot: async (row) => { saved.push(row); }
  });

  assert.equal(saved.length, 1);
  assert.equal(snapshot.virtualNetUnits, 0);
  assert.equal(snapshot.brokerNetUnits, 0);
  assert.equal(snapshot.mismatch, false);
  assert.equal(snapshot.operatorPaused, true);
  assert.equal(snapshot.ma, 100.5);
  assert.equal(JSON.stringify(snapshot).includes("postgres"), false);
});
