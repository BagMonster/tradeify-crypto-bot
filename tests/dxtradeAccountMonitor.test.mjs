import test from "node:test";
import assert from "node:assert/strict";
import {
  createDxtradeAccountMonitor,
  normalizeDxtradeAccountMetrics
} from "../src/account/dxtradeAccountMonitor.js";

function payload(overrides = {}) {
  return {
    metrics: [{
      account: "default:btc-account",
      version: 10,
      equity: 50_100,
      balance: 50_050,
      openPl: 50,
      dayClosedPl: 50,
      openPositionsCount: 1,
      positions: [{
        symbol: "BTC/USD",
        quantity: 0.01,
        markPrice: 67_000,
        openPl: 50,
        dayClosedPl: 50,
        avgOpenPrice: 62_000
      }],
      ...overrides
    }]
  };
}

test("live metrics derive account-day opening balance without waiting for a rollover", () => {
  const snapshot = normalizeDxtradeAccountMetrics(payload(), {
    startingBalance: 50_000,
    persistedPeakClosedBalance: 50_000,
    fetchedAtMs: Date.parse("2026-08-23T09:30:00.000Z")
  });
  assert.equal(snapshot.previousDayClosingBalance, 50_000);
  assert.equal(snapshot.peakClosedBalance, 50_050);
  assert.equal(snapshot.currentNotional, 670);
  assert.equal(snapshot.accountLocked, false);
});

test("a foreign or second position locks new grid actions", () => {
  const foreign = normalizeDxtradeAccountMetrics(payload({
    openPositionsCount: 1,
    positions: [{ symbol: "SOL/USD", quantity: 1, markPrice: 150, openPl: 0, dayClosedPl: 0, avgOpenPrice: 140 }]
  }), { startingBalance: 50_000, persistedPeakClosedBalance: 50_000, fetchedAtMs: 1 });
  assert.equal(foreign.accountLocked, true);
  assert.match(foreign.invariantError, /non-BTC/i);

  const two = normalizeDxtradeAccountMetrics(payload({
    openPositionsCount: 2,
    positions: [
      { symbol: "BTC/USD", quantity: 0.01, markPrice: 67_000, openPl: 0, dayClosedPl: 0, avgOpenPrice: 65_000 },
      { symbol: "BTC/USD", quantity: -0.005, markPrice: 67_000, openPl: 0, dayClosedPl: 0, avgOpenPrice: 68_000 }
    ]
  }), { startingBalance: 50_000, persistedPeakClosedBalance: 50_000, fetchedAtMs: 1 });
  assert.equal(two.accountLocked, true);
  assert.match(two.invariantError, /more than one/i);
});

test("monitor uses one metrics request with positions and reports freshness", async () => {
  let now = 1_000_000;
  let loginCalls = 0;
  let metricsCalls = 0;
  let saved;
  const monitor = createDxtradeAccountMonitor({
    client: {
      async login() { loginCalls += 1; },
      async getAccountMetrics(options) {
        metricsCalls += 1;
        assert.deepEqual(options, { includePositions: true });
        return payload();
      },
      async getOpenPositions() {
        return { positions: payload().metrics[0].positions };
      }
    },
    startingBalance: 50_000,
    getPersistedPeakClosedBalance: async () => 50_000,
    onSnapshot: async (snapshot) => { saved = snapshot; },
    pollIntervalMs: 1_000,
    freshAfterMs: 3_000,
    now: () => now
  });

  await monitor.pollOnce();
  assert.equal(loginCalls, 1);
  assert.equal(metricsCalls, 1);
  assert.equal(saved.equity, 50_100);
  assert.equal(monitor.getSnapshot().healthy, true);

  now += 3_001;
  assert.equal(monitor.getSnapshot().fresh, false);
  assert.equal(monitor.getSnapshot().healthy, false);
});

test("monitor errors fail freshness/health closed without exposing raw error outward", async () => {
  const monitor = createDxtradeAccountMonitor({
    client: {
      async login() { throw new Error("secret transport detail"); },
      async getAccountMetrics() { throw new Error("not reached"); },
      async getOpenPositions() { throw new Error("not reached"); }
    },
    startingBalance: 50_000,
    getPersistedPeakClosedBalance: async () => 50_000,
    onError: () => {},
    pollIntervalMs: 1_000,
    freshAfterMs: 3_000,
    now: () => 1_000_000
  });
  await monitor.pollOnce();
  const status = monitor.getSnapshot();
  assert.equal(status.healthy, false);
  assert.equal(status.error, "DXtrade account monitor error");
  assert.equal(JSON.stringify(status).includes("secret transport detail"), false);
});

test("a failed positions read does not treat metrics-flat as authoritative", async () => {
  const monitor = createDxtradeAccountMonitor({
    client: {
      async login() {},
      async getAccountMetrics() {
        return payload({ openPositionsCount: 0, positions: [], openPl: 0 });
      },
      async getOpenPositions() { throw new Error("positions endpoint down"); }
    },
    startingBalance: 50_000,
    getPersistedPeakClosedBalance: async () => 50_000,
    pollIntervalMs: 1_000,
    freshAfterMs: 3_000,
    now: () => 1_000_000
  });
  const snapshot = await monitor.pollOnce();
  assert.equal(snapshot.positionsReadFailed, true);
  assert.equal(snapshot.signedNetUnits, null);
  assert.equal(monitor.getSnapshot().healthy, false);
  assert.equal(monitor.getSnapshot().fresh, true);
});
