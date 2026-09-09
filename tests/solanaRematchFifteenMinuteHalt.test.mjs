import test from "node:test";
import assert from "node:assert/strict";
import { createSolanaOwnerService } from "../src/solanaOwnerService.js";
import { isReconciliationHalt } from "../src/state/solanaRematch.js";
import { createInitialSolanaState, expectedNetUnits, normalizeSolanaState } from "../src/strategies/solanaGrid.js";

const INJ_FIFTEEN_MINUTE_HALT =
  "INJ/USD virtual-lot state does not reconcile to the DXtrade net position after 15 minutes; owner review required";

test("isReconciliationHalt accepts the live 15-minute instrument sentence and rejects nearby wording", () => {
  assert.equal(isReconciliationHalt(INJ_FIFTEEN_MINUTE_HALT), true);
  assert.equal(isReconciliationHalt(INJ_FIFTEEN_MINUTE_HALT, "INJ/USD"), true);
  assert.equal(isReconciliationHalt(INJ_FIFTEEN_MINUTE_HALT, "SOL/USD"), false);
  assert.equal(
    isReconciliationHalt("SOL virtual-lot state does not reconcile to the DXtrade net SOL position; owner review required"),
    true
  );
  assert.equal(
    isReconciliationHalt("SOL virtual-lot state does not reconcile to the DXtrade net SOL position; owner review required", "INJ/USD"),
    false
  );
  assert.equal(
    isReconciliationHalt("Protective flatten needs reconciliation-style owner review"),
    false
  );
  assert.equal(
    isReconciliationHalt("INJ/USD production runtime error; owner review required"),
    false
  );
});

function emptyState() {
  return normalizeSolanaState(createInitialSolanaState());
}

function serviceWithHalt(haltReason, positions = [], instrument = "INJ/USD") {
  let gridState = emptyState();
  const events = [];
  let challenge = { hash: null, salt: null, expiresAt: null };
  let halt = { safetyHalt: true, reason: haltReason };
  let operatorKilledState = true;
  const database = {
    async getState() {
      return {
        operator_killed: operatorKilledState,
        safety_halt: halt.safetyHalt,
        halt_reason: halt.reason,
        resume_code_hash: challenge.hash,
        resume_code_salt: challenge.salt,
        resume_code_expires_at: challenge.expiresAt
      };
    },
    async setResumeChallenge(hash, salt, expiresAt) { challenge = { hash, salt, expiresAt }; },
    async clearResumeChallenge() { challenge = { hash: null, salt: null, expiresAt: null }; },
    async clearSafetyHaltIfReason(reason) {
      if (halt.safetyHalt === true && halt.reason === reason) {
        halt = { safetyHalt: false, reason: null };
        return true;
      }
      return false;
    },
    async setOperatorKilled(killed) { operatorKilledState = killed === true; },
    async addEvent(level, type, payload) { events.push({ level, type, payload }); }
  };
  const service = createSolanaOwnerService({
    database,
    account: { startingBalance: 50000, maxLossOffset: 3000, dailyLossLimit: 1500 },
    strategy: { execution: { autoExecute: true }, strategyStatus: "production-live-approved", instruments: { [instrument]: { enabled: true } } },
    environment: { appMode: "live", autoExecute: true },
    instrument,
    persistence: { state: { async load() { return gridState; }, async save() { throw new Error("rematch must not rewrite virtual lots"); } } },
    maProvider: { getCurrent: async () => ({ ma: 81.3384, completedThrough: "2026-08-26" }) },
    execution: { isEnabled: () => true },
    dxtradeClient: { async login() {}, async getOpenPositions() { return { positions }; } },
    accountMonitor: {
      getSnapshot() {
        return {
          snapshot: {
            signedNetUnits: 0,
            signedNetByInstrument: { [instrument]: { netUnits: 0, ticketCount: 0 } },
            positionSource: "open-positions",
            positionsReadFailed: false,
            fetchedAtMs: Date.now()
          },
          healthy: true,
          fresh: true,
          ageMs: 8,
          error: null
        };
      }
    }
  });
  return {
    service,
    events,
    getHalt: () => halt,
    isPaused: () => operatorKilledState,
    getState: () => gridState,
    expectedNet: () => expectedNetUnits(gridState)
  };
}

test("requestRematch accepts the 15-minute INJ halt when both sides are already flat", async () => {
  const { service, events, expectedNet } = serviceWithHalt(INJ_FIFTEEN_MINUTE_HALT, []);
  const result = await service.requestRematch();
  assert.match(result.code, /^\d{6}$/);
  assert.match(result.message, /AUDITED BOOK REMATCH/);
  assert.match(result.message, /after 15 minutes/);
  assert.equal(expectedNet(), 0);
  assert.equal(events.at(-1).type, "SOL_REMATCH_REQUESTED");
});

test("confirmRematch clears the 15-minute halt without rewriting lots", async () => {
  const { service, getHalt, isPaused, expectedNet } = serviceWithHalt(INJ_FIFTEEN_MINUTE_HALT, []);
  const requested = await service.requestRematch();
  const message = await service.confirmRematch(requested.code);
  assert.match(message, /AUDITED BOOK REMATCH APPLIED/);
  assert.equal(getHalt().safetyHalt, false);
  assert.equal(isPaused(), false);
  assert.equal(expectedNet(), 0);
});

test("a clean book cannot clear another instrument's 15-minute reconciliation halt", async () => {
  const { service, getHalt, isPaused } = serviceWithHalt(INJ_FIFTEEN_MINUTE_HALT, [], "SOL/USD");
  const result = await service.requestRematch();
  assert.equal(result.code, null);
  assert.match(result.message, /ACTIVE HALT IS NOT A RECONCILIATION MISMATCH/);
  assert.equal(getHalt().safetyHalt, true);
  assert.equal(isPaused(), true);
});
