import test from "node:test";
import assert from "node:assert/strict";
import {
  createLiveTelegramNotifications,
  formatLiveTelegramNotification
} from "../src/notifications/liveTelegramNotifications.js";
import { createSolanaRuntime } from "../src/runtime/solanaRuntime.js";
import { createInitialSolanaState, expectedNetUnits } from "../src/strategies/solanaGrid.js";

function memoryNotificationPersistence() {
  const rows = new Map();
  return {
    rows,
    async claimTelegramNotification({ eventKey, kind }) {
      const existing = rows.get(eventKey);
      if (existing) return Object.freeze({ ...existing, claimed: false });
      const row = { eventKey, kind, status: "CLAIMED" };
      rows.set(eventKey, row);
      return Object.freeze({ ...row, claimed: true });
    },
    async markTelegramNotificationSent(eventKey) {
      const row = rows.get(eventKey);
      if (!row || row.status !== "CLAIMED") throw new Error("notification is not claimable");
      row.status = "SENT";
      return Object.freeze({ ...row, claimed: false });
    },
    async markTelegramNotificationFailed(eventKey) {
      const row = rows.get(eventKey);
      if (!row || row.status !== "CLAIMED") return null;
      row.status = "FAILED";
      return Object.freeze({ ...row, claimed: false });
    }
  };
}

function riskLadderStore() {
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

function entryEvent(overrides = {}) {
  return {
    kind: "ENTRY_CONFIRMED",
    eventKey: "SOL-ENTRY:SOLGRID-1-BUY10-E",
    ringTag: "BUY10",
    side: "BUY",
    fillPrice: 93.83,
    filledQuantity: 0.06,
    lotId: "BUY10-V1",
    ma: 120,
    filledAt: "2026-08-24T15:00:00.000Z",
    ...overrides
  };
}

function baseRisk(brokerNetUnits = 0, liveEquity = 50_000) {
  return {
    startingBalance: 50_000,
    maxLossOffset: 3_000,
    peakClosedBalance: 50_000,
    payoutTaken: false,
    previousDayClosingBalance: 50_000,
    dailyLossLimit: 1_500,
    liveEquity,
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

test("live notification formatting supports D-049 ring 10 and approved useful-middle detail", () => {
  const entry = formatLiveTelegramNotification(entryEvent());
  assert.match(entry.message, /🟢 SOL ENTRY CONFIRMED/);
  assert.match(entry.message, /Ring: BUY10/);
  assert.match(entry.message, /Fill: \$93\.83/);
  assert.match(entry.message, /Quantity: 0\.06 SOL/);
  assert.match(entry.message, /Virtual lot: BUY10-V1/);
  assert.match(entry.message, /Current 200-day MA: \$120\.00/);

  const exit = formatLiveTelegramNotification({
    kind: "TRANCHE_EXIT_CONFIRMED",
    eventKey: "SOL-TRANCHE:SOLGRID-2-SELL10-X1",
    ringTag: "SELL10",
    virtualSide: "SELL",
    lotId: "SELL10-V1",
    tranche: 1,
    fillPrice: 100.25,
    filledQuantity: 0.01,
    remainingQuantity: 0.05,
    ma: 120,
    target: 100.18,
    filledAt: "2026-08-24T16:00:00.000Z"
  });
  assert.match(exit.message, /💰 SOL TRANCHE EXIT CONFIRMED/);
  assert.match(exit.message, /Ring: SELL10/);
  assert.match(exit.message, /Tranche: 1\/4/);

  const safety = formatLiveTelegramNotification({
    kind: "RECONCILIATION_MISMATCH",
    eventKey: "SOL-RECON:8:0.42:0.38",
    stateVersion: 8,
    expectedVirtualNetUnits: 0.42,
    brokerNetUnits: 0.38
  });
  assert.match(safety.message, /🚨 SOL SAFETY HALT — RECONCILIATION MISMATCH/);
});

test("D-049 partial-cut and full-flatten notifications contain protective detail", () => {
  const cut = formatLiveTelegramNotification({
    kind: "D049_PARTIAL_CUT",
    eventKey: "SOL-D049-CUT:2026-08-24",
    drawdownUsd: -1004.22,
    fraction: 0.5,
    filledQuantity: 1.2,
    fillPrice: 82.15,
    lotsAffected: 4,
    filledAt: "2026-08-24T20:00:00.000Z"
  });
  assert.match(cut.message, /50% DE-RISK CUT CONFIRMED/);
  assert.match(cut.message, /−\$1004\.22/);
  assert.match(cut.message, /Virtual lots affected: 4/);

  const flat = formatLiveTelegramNotification({
    kind: "D049_FULL_FLATTEN",
    eventKey: "SOL-D049-FLAT:2026-08-24",
    drawdownUsd: -1260.45,
    fillPrice: 80.5,
    filledQuantity: 2.4,
    confirmedFlat: true,
    filledAt: "2026-08-24T20:01:00.000Z"
  });
  assert.match(flat.message, /DAILY FULL FLATTEN COMPLETE/);
  assert.match(flat.message, /Broker account: FLAT/);
  assert.match(flat.message, /next 22:00 UTC account-day rollover/);
});

test("durable notification identity suppresses duplicate delivery across notifier restarts", async () => {
  const persistence = memoryNotificationPersistence();
  const firstMessages = [];
  const first = createLiveTelegramNotifications({ persistence });
  first.setSender(async (message) => { firstMessages.push(message); });
  assert.equal((await first.notify(entryEvent())).status, "SENT");
  assert.equal(firstMessages.length, 1);

  const secondMessages = [];
  const second = createLiveTelegramNotifications({ persistence });
  second.setSender(async (message) => { secondMessages.push(message); });
  const result = await second.notify(entryEvent());
  assert.equal(result.status, "DUPLICATE_SUPPRESSED");
  assert.equal(secondMessages.length, 0);
  assert.equal(persistence.rows.get(entryEvent().eventKey).status, "SENT");
});

test("Telegram delivery failure is fail-safe and never automatically retries an uncertain identity", async () => {
  const persistence = memoryNotificationPersistence();
  let attempts = 0;
  const first = createLiveTelegramNotifications({ persistence });
  first.setSender(async () => {
    attempts += 1;
    throw new Error("transport detail that must not escape");
  });
  const failed = await first.notify(entryEvent());
  assert.equal(failed.status, "FAILED");
  assert.equal(attempts, 1);
  assert.equal(persistence.rows.get(entryEvent().eventKey).status, "FAILED");

  const second = createLiveTelegramNotifications({ persistence });
  second.setSender(async () => { attempts += 1; });
  const duplicate = await second.notify(entryEvent());
  assert.equal(duplicate.status, "DUPLICATE_SUPPRESSED");
  assert.equal(attempts, 1);
});

test("queued notifications preserve event order without blocking the trading caller", async () => {
  const persistence = memoryNotificationPersistence();
  const delivered = [];
  const notifications = createLiveTelegramNotifications({ persistence });
  notifications.setSender(async (message) => { delivered.push(message.split("\n")[0]); });

  assert.equal(notifications.enqueue(entryEvent()).status, "QUEUED");
  assert.equal(notifications.enqueue({
    kind: "LOT_CLOSED",
    eventKey: "SOL-LOT-CLOSED:SOLGRID-5-BUY10-X4",
    ringTag: "BUY10",
    virtualSide: "BUY",
    lotId: "BUY10-V1",
    entryPrice: 93.83,
    originalQuantity: 0.06,
    finalFillPrice: 120,
    openedAt: "2026-08-24T15:00:00.000Z",
    closedAt: "2026-08-24T17:00:00.000Z"
  }).status, "QUEUED");

  await notifications.drain();
  assert.deepEqual(delivered, ["🟢 SOL ENTRY CONFIRMED", "✅ SOL LOT FULLY CLOSED"]);
});

test("live runtime emits an entry notification only after the confirmed fill is durably saved", async () => {
  let state = createInitialSolanaState();
  let saved = false;
  const notifications = [];
  const store = {
    init: async () => {},
    load: async () => state,
    initializeIfMissing: async (candidate) => { if (!state) state = candidate; return state; },
    save: async (expectedVersion, next) => {
      assert.equal(state.version, expectedVersion);
      state = next;
      saved = true;
      return state;
    }
  };
  const execution = {
    isEnabled: () => true,
    executeProtectiveCut: async () => ({ status: "ALREADY_FLAT" }),
    executeProtectiveFlatten: async () => ({ status: "ALREADY_FLAT" }),
    executeIntent: async (intent) => ({
      status: "FILLED",
      confirmed: true,
      orderCode: `SOLGRID-${intent.stateVersion}-${intent.tag}-E`,
      fillPrice: 86.4,
      filledQuantity: intent.quantity,
      filledAt: "2026-08-24T15:00:30.000Z"
    })
  };
  const runtime = createSolanaRuntime({
    stateStore: store,
    riskLadderStore: riskLadderStore(),
    riskLadderConfig,
    maProvider: { getCurrent: async () => ({ ma: 100, completedThrough: "2026-08-24T00:00:00.000Z" }) },
    execution,
    minimumHoldSeconds: 25,
    getRiskSnapshot: async () => baseRisk(expectedNetUnits(state)),
    notifications: {
      enqueue(event) {
        assert.equal(saved, true);
        notifications.push(event);
        return { status: "QUEUED" };
      }
    }
  });
  await runtime.init();

  await runtime.processTrade({ source: "binance", symbol: "SOLUSDT", price: 90, tradeTime: "2026-08-24T15:00:00.000Z" });
  saved = false;
  await runtime.processTrade({ source: "binance", symbol: "SOLUSDT", price: 86.4, tradeTime: "2026-08-24T15:00:30.000Z" });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].kind, "ENTRY_CONFIRMED");
  assert.equal(notifications[0].ringTag, "BUY1");
  assert.equal(notifications[0].fillPrice, 86.4);
});

test("unconfirmed runtime order outcome never emits a fill notification", async () => {
  let state = createInitialSolanaState();
  const notifications = [];
  const store = {
    init: async () => {},
    load: async () => state,
    initializeIfMissing: async (candidate) => { if (!state) state = candidate; return state; },
    save: async (expectedVersion, next) => {
      assert.equal(state.version, expectedVersion);
      state = next;
      return state;
    }
  };
  const runtime = createSolanaRuntime({
    stateStore: store,
    riskLadderStore: riskLadderStore(),
    riskLadderConfig,
    maProvider: { getCurrent: async () => ({ ma: 100, completedThrough: "2026-08-24T00:00:00.000Z" }) },
    execution: {
      isEnabled: () => true,
      executeProtectiveCut: async () => ({ status: "ALREADY_FLAT" }),
      executeProtectiveFlatten: async () => ({ status: "ALREADY_FLAT" }),
      executeIntent: async () => ({ status: "PENDING", orderCode: "SOLGRID-0-BUY1-E" })
    },
    minimumHoldSeconds: 25,
    getRiskSnapshot: async () => baseRisk(expectedNetUnits(state)),
    notifications: { enqueue: (event) => { notifications.push(event); return { status: "QUEUED" }; } }
  });
  await runtime.init();
  await runtime.processTrade({ source: "binance", symbol: "SOLUSDT", price: 90, tradeTime: "2026-08-24T15:00:00.000Z" });
  const result = await runtime.processTrade({ source: "binance", symbol: "SOLUSDT", price: 86.4, tradeTime: "2026-08-24T15:00:30.000Z" });
  assert.equal(result.status, "ENTRY_PENDING");
  assert.equal(notifications.length, 0);
});
