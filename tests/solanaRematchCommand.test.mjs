import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSolanaTradeifyService } from "../src/solanaTradeifyService.js";
import { createInitialSolanaState, expectedNetUnits, normalizeSolanaState } from "../src/strategies/solanaGrid.js";

function short2State() {
  const initial = createInitialSolanaState();
  return normalizeSolanaState({
    ...initial,
    version: 3,
    rings: initial.rings.map((ring) => (
      ring.tag === "SELL2"
        ? {
          ...ring,
          armed: false,
          lots: [{
            id: "SELL2-V2",
            side: "SELL",
            ringTag: "SELL2",
            entryPrice: 95.91,
            originalUnits: 0.44,
            remainingUnits: 0.44,
            done: 0,
            openedAt: "2026-08-26T15:59:10.937Z"
          }]
        }
        : ring
    )),
    lastFillAt: "2026-08-26T15:59:10.937Z",
    lastFillSide: "SELL",
    lastFillPrice: 95.91
  });
}

function makeService({ brokerPositions, hasOpenPosition = false } = {}) {
  let gridState = short2State();
  const events = [];
  let challenge = { hash: null, salt: null, expiresAt: null };
  let halt = { safetyHalt: true, reason: "virtual net -0.44 vs broker 0" };
  let operatorKilledState = true;
  let rematchHooks = 0;
  const database = {
    async getState() {
      return {
        has_open_position: hasOpenPosition,
        operator_killed: operatorKilledState,
        safety_halt: halt.safetyHalt,
        halt_reason: halt.reason,
        resume_code_hash: challenge.hash,
        resume_code_salt: challenge.salt,
        resume_code_expires_at: challenge.expiresAt
      };
    },
    async setResumeChallenge(hash, salt, expiresAt) {
      challenge = { hash, salt, expiresAt };
    },
    async clearResumeChallenge() {
      challenge = { hash: null, salt: null, expiresAt: null };
    },
    async clearSafetyHalt() {
      halt = { safetyHalt: false, reason: null };
      return true;
    },
    async setOperatorKilled(killed) {
      operatorKilledState = killed === true;
    },
    async addEvent(level, type, payload) {
      events.push({ level, type, payload });
    }
  };
  const persistence = {
    state: {
      async load() { return gridState; },
      async save() { throw new Error("rematch must not rewrite virtual lots"); }
    }
  };
  const service = createSolanaTradeifyService({
    database,
    account: { startingBalance: 50000, maxLossOffset: 3000, dailyLossLimit: 1500 },
    strategy: {
      execution: { autoExecute: true },
      strategyStatus: "production-live-approved",
      instruments: { "BTC/USD": { enabled: false }, "SOL/USD": { enabled: true } }
    },
    environment: { appMode: "live", autoExecute: true },
    persistence,
    maProvider: { getCurrent: async () => ({ ma: 81.3384, completedThrough: "2026-08-26" }) },
    execution: { isEnabled: () => true },
    dxtradeClient: {
      async login() {},
      async getOpenPositions() { return brokerPositions; }
    },
    onBooksRematched: async () => { rematchHooks += 1; }
  });
  return {
    service,
    events,
    getChallenge: () => challenge,
    getHalt: () => halt,
    getState: () => gridState,
    isPaused: () => operatorKilledState,
    rematchHooks: () => rematchHooks
  };
}

test("requestRematch refuses when a fresh DXtrade read is still flat", async () => {
  const { service, events, getState } = makeService({ brokerPositions: { positions: [] } });
  const result = await service.requestRematch();
  assert.equal(result.code, null);
  assert.match(result.message, /BOOKS STILL DISAGREE/);
  assert.match(result.message, /Fresh DXtrade net: 0.00/);
  assert.equal(expectedNetUnits(getState()), -0.44);
  assert.equal(events.some((event) => event.type === "SOL_REMATCH_REQUESTED"), false);
});

test("requestRematch issues a rematch-prefixed code when the 0.44 short matches", async () => {
  const { service, events, getState } = makeService({
    brokerPositions: { positions: [{ symbol: "SOL/USD", quantity: 0.44, side: "SELL", markPrice: 95.91 }] }
  });
  const result = await service.requestRematch();
  assert.match(result.code, /^\d{6}$/);
  assert.match(result.message, new RegExp(`/confirmrematch ${result.code}`));
  assert.match(result.message, /will NOT place a DXtrade order/);
  assert.equal(expectedNetUnits(getState()), -0.44);
  assert.equal(events.at(-1).type, "SOL_REMATCH_REQUESTED");
});

test("confirmRematch rejects a reconcile-style hash", async () => {
  const { service, getChallenge, getHalt, isPaused } = makeService({
    brokerPositions: { positions: [{ symbol: "SOL/USD", quantity: 0.44, side: "SELL" }] }
  });
  const requested = await service.requestRematch();
  const reconcileHash = createHash("sha256").update(`${getChallenge().salt}:reconcile:${requested.code}`).digest("hex");
  assert.notEqual(getChallenge().hash, reconcileHash);
  const wrong = await service.confirmRematch("000000");
  assert.match(wrong, /incorrect/);
  assert.equal(getHalt().safetyHalt, true);
  assert.equal(isPaused(), true);
});

test("confirmRematch keeps the SHORT2 lot, clears the halt, and lifts the pause", async () => {
  const { service, events, getHalt, getState, isPaused, rematchHooks } = makeService({
    brokerPositions: { positions: [{ symbol: "SOL/USD", quantity: 0.44, side: "SELL" }] }
  });
  const requested = await service.requestRematch();
  const message = await service.confirmRematch(requested.code);
  assert.match(message, /AUDITED BOOK REMATCH APPLIED/);
  assert.match(message, /Virtual lots: preserved/);
  assert.match(message, /Operator pause: lifted/);
  assert.equal(expectedNetUnits(getState()), -0.44);
  assert.equal(getState().rings.find((ring) => ring.tag === "SELL2").lots.length, 1);
  assert.equal(getHalt().safetyHalt, false);
  assert.equal(isPaused(), false);
  assert.equal(rematchHooks(), 1);
  assert.equal(events.some((event) => event.type === "SOL_BOOKS_REMATCHED"), true);
});
