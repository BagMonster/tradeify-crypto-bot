import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSolanaTradeifyService } from "../src/solanaTradeifyService.js";
import { createInitialSolanaState, expectedNetUnits, normalizeSolanaState } from "../src/strategies/solanaGrid.js";

function dirtyState() {
  const initial = createInitialSolanaState();
  return normalizeSolanaState({
    ...initial,
    version: 7,
    rings: initial.rings.map((ring) => (
      ring.tag === "SELL3"
        ? {
          ...ring,
          armed: false,
          lots: [{
            id: "SELL3-legacy",
            side: "SELL",
            ringTag: "SELL3",
            entryPrice: 100.535,
            originalUnits: 0.06,
            remainingUnits: 0.06,
            done: 0,
            openedAt: "2026-08-25T00:08:45.929Z"
          }]
        }
        : ring
    )),
    lastFillAt: "2026-08-25T00:08:45.929Z",
    lastFillSide: "SELL",
    lastFillPrice: 100.535
  });
}

function makeService({ hasOpenPosition = false, operatorKilled = true, safetyHalt = true } = {}) {
  let gridState = dirtyState();
  const events = [];
  let challenge = { hash: null, salt: null, expiresAt: null };
  let halt = { safetyHalt, reason: "virtual net -0.06 vs broker 0" };
  let operatorKilledState = operatorKilled;
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
    async addEvent(level, type, payload) {
      events.push({ level, type, payload });
    }
  };
  const persistence = {
    state: {
      async load() { return gridState; },
      async save(expectedVersion, next) {
        assert.equal(expectedVersion, gridState.version);
        assert.equal(next.version, expectedVersion + 1);
        gridState = next;
      }
    }
  };
  const service = createSolanaTradeifyService({
    database,
    account: { startingBalance: 50000, maxLossOffset: 2000, dailyLossLimit: 1500 },
    strategy: {
      execution: { autoExecute: false },
      strategyStatus: "production-live-approved",
      instruments: { "BTC/USD": { enabled: false }, "SOL/USD": { enabled: true } }
    },
    environment: { appMode: "live", autoExecute: false },
    persistence,
    maProvider: { getCurrent: async () => ({ ma: 100, completedThrough: "2026-08-25" }) },
    execution: { isEnabled: () => false }
  });
  return { service, events, getChallenge: () => challenge, getHalt: () => halt, getState: () => gridState };
}

test("requestReconcile refuses while the broker still shows an open SOL position", async () => {
  const { service, events } = makeService({ hasOpenPosition: true });
  const result = await service.requestReconcile();
  assert.equal(result.code, null);
  assert.match(result.message, /Flatten the broker first/);
  assert.equal(events.some((event) => event.type === "SOL_RECONCILE_REQUESTED"), false);
});

test("requestReconcile issues a 6-digit code and does not mutate virtual lots", async () => {
  const { service, events, getState } = makeService();
  const result = await service.requestReconcile();
  assert.match(result.code, /^\d{6}$/);
  assert.match(result.message, new RegExp(`/confirmreconcile ${result.code}`));
  assert.match(result.message, /will NOT place a DXtrade order/);
  assert.match(result.message, /will NOT remove the operator pause/);
  assert.equal(expectedNetUnits(getState()), -0.06);
  assert.equal(events.at(-1).type, "SOL_RECONCILE_REQUESTED");
});

test("confirmReconcile rejects a resume-style hash and the wrong code", async () => {
  const { service, getChallenge, events, getState } = makeService();
  const requested = await service.requestReconcile();
  const resumeHash = createHash("sha256").update(`${getChallenge().salt}:${requested.code}`).digest("hex");
  assert.notEqual(getChallenge().hash, resumeHash);

  const wrong = await service.confirmReconcile("000000");
  assert.match(wrong, /incorrect/);
  assert.equal(events.some((event) => event.type === "SOL_RECONCILE_CODE_REJECTED"), true);
  assert.equal(expectedNetUnits(getState()), -0.06);
});

test("confirmReconcile flattens virtual inventory, clears the halt, and leaves the operator pause", async () => {
  const { service, events, getHalt, getState } = makeService();
  const requested = await service.requestReconcile();
  const message = await service.confirmReconcile(requested.code);
  assert.match(message, /AUDITED VIRTUAL RECONCILE APPLIED/);
  assert.match(message, /Safety halt: cleared/);
  assert.match(message, /Operator pause: unchanged/);
  assert.equal(expectedNetUnits(getState()), 0);
  assert.equal(getState().rings.every((ring) => ring.armed === true && ring.lots.length === 0), true);
  assert.equal(getHalt().safetyHalt, false);
  assert.equal(events.some((event) => event.type === "SOL_VIRTUAL_RECONCILE_APPLIED"), true);
  assert.equal(events.some((event) => event.type === "OPERATOR_RESUME"), false);
});
