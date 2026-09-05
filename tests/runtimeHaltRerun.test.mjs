import test from "node:test";
import assert from "node:assert/strict";
import {
  createRuntimeHaltRerunHandlers,
  hasRuntimeErrorHalt,
  isRuntimeErrorHalt
} from "../src/state/runtimeHaltRerun.js";

const RUNTIME_REASON = "SOL/USD production runtime error; owner review required";

function matchingBooks() {
  return [
    { instrument: "SOL/USD", ok: true, match: true, virtualNet: -1.54, brokerNet: -1.54, openLots: 2 },
    { instrument: "DOGE/USD", ok: true, match: true, virtualNet: 60.52, brokerNet: 60.52, openLots: 1 }
  ];
}

function makeHandlers({
  safetyHalt = true,
  haltReason = RUNTIME_REASON,
  books = matchingBooks(),
  cleared = true
} = {}) {
  const events = [];
  let challenge = { hash: null, salt: null, expiresAt: null };
  let halt = { safetyHalt, reason: haltReason };
  let clearedHooks = 0;
  const database = {
    async getState() {
      return {
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
    async clearSafetyHaltIfReason(reason) {
      if (halt.safetyHalt === true && halt.reason === reason && cleared) {
        halt = { safetyHalt: false, reason: null };
        return true;
      }
      return false;
    },
    async addEvent(level, type, payload) {
      events.push({ level, type, payload });
    }
  };
  const handlers = createRuntimeHaltRerunHandlers({
    database,
    inspectBooks: async () => books,
    onRuntimeHaltCleared: async () => {
      clearedHooks += 1;
    }
  });
  return { handlers, events, getHalt: () => halt, getHooks: () => clearedHooks };
}

test("recognizes the live production runtime halt string", () => {
  assert.equal(isRuntimeErrorHalt(RUNTIME_REASON), true);
  assert.equal(isRuntimeErrorHalt("DOGE/USD production runtime error; owner review required"), true);
  assert.equal(hasRuntimeErrorHalt({ safety_halt: true, halt_reason: RUNTIME_REASON }), true);
  assert.equal(isRuntimeErrorHalt("SOL virtual-lot state does not reconcile to the DXtrade net SOL position; owner review required"), false);
});

test("refuses when there is no runtime halt", async () => {
  const { handlers } = makeHandlers({ safetyHalt: false, haltReason: null });
  const result = await handlers.requestRerun();
  assert.equal(result.code, null);
  assert.match(result.message, /NO RUNTIME HALT/);
});

test("refuses a reconciliation halt", async () => {
  const { handlers } = makeHandlers({
    haltReason: "SOL virtual-lot state does not reconcile to the DXtrade net SOL position; owner review required"
  });
  const result = await handlers.requestRerun();
  assert.equal(result.code, null);
  assert.match(result.message, /NOT A PRODUCTION RUNTIME ERROR/);
});

test("refuses when a book disagrees", async () => {
  const { handlers } = makeHandlers({
    books: [
      { instrument: "SOL/USD", ok: true, match: false, virtualNet: -1.54, brokerNet: 0, openLots: 2 },
      { instrument: "DOGE/USD", ok: true, match: true, virtualNet: 60.52, brokerNet: 60.52, openLots: 1 }
    ]
  });
  const result = await handlers.requestRerun();
  assert.equal(result.code, null);
  assert.match(result.message, /DOES NOT MATCH/);
});

test("issues a code when every book matches a runtime halt", async () => {
  const { handlers, events } = makeHandlers();
  const result = await handlers.requestRerun();
  assert.match(result.code, /^\d{6}$/);
  assert.match(result.message, /RUNTIME HALT RE-RUN/);
  assert.match(result.message, /\/confirmrerun /);
  assert.equal(events.at(-1).type, "RUNTIME_HALT_RERUN_REQUESTED");
});

test("confirm rejects a resume-shaped code and applies a real rerun code", async () => {
  const { handlers, getHalt, getHooks } = makeHandlers();
  const asked = await handlers.requestRerun();
  assert.match(await handlers.confirmRerun("000000"), /incorrect/);
  const applied = await handlers.confirmRerun(asked.code);
  assert.match(applied, /RUNTIME HALT RE-RUN APPLIED/);
  assert.equal(getHalt().safetyHalt, false);
  assert.equal(getHooks(), 1);
});
