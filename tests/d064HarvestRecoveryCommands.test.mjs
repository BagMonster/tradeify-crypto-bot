import test from "node:test";
import assert from "node:assert/strict";
import { createMultiInstrumentOwnerService } from "../src/multiInstrumentOwnerService.js";

const D064_READ_HALT = "D-064 harvest cannot verify fresh broker account data for SOL/USD, DOGE/USD";

function databaseStub() {
  const state = {
    safety_halt: true,
    halt_reason: D064_READ_HALT,
    resume_code_hash: null,
    resume_code_salt: null,
    resume_code_expires_at: null
  };
  const events = [];
  return {
    state,
    events,
    async getState() { return { ...state }; },
    async setResumeChallenge(hash, salt, expiresAt) {
      state.resume_code_hash = hash;
      state.resume_code_salt = salt;
      state.resume_code_expires_at = expiresAt;
    },
    async clearResumeChallenge() {
      state.resume_code_hash = null;
      state.resume_code_salt = null;
      state.resume_code_expires_at = null;
    },
    async addEvent(level, type, payload) { events.push({ level, type, payload }); }
  };
}

function serviceFor({ rows, database, supervisor }) {
  return createMultiInstrumentOwnerService({
    database,
    riskSupervisor: supervisor,
    instrumentConfigs: [
      { enabled: true, instrument: "SOL/USD", orderPrefix: "SOL" },
      { enabled: true, instrument: "DOGE/USD", orderPrefix: "DOGE" }
    ],
    buildOwnerService: (cfg) => ({
      inspectForRerun: async () => rows.find((row) => row.instrument === cfg.instrument),
      statusText: async () => cfg.instrument,
      healthText: async () => cfg.instrument
    })
  });
}

function supervisorStub() {
  const snapshot = {
    dayKey: "2026-09-09",
    dayPnlUsd: 0,
    exposureUsd: 0,
    harvest: { status: "HALTED", haltReason: D064_READ_HALT },
    perInstrument: []
  };
  let recovery = null;
  return {
    get recovery() { return recovery; },
    getSnapshot: () => snapshot,
    recoverHarvest: async (input) => {
      recovery = input;
      snapshot.harvest = { status: "READY", haltReason: null };
      return { action: "NONE" };
    }
  };
}

test("D-064 command refuses recovery when any virtual book disagrees with broker", async () => {
  const database = databaseStub();
  const supervisor = supervisorStub();
  const service = serviceFor({
    database,
    supervisor,
    rows: [
      { instrument: "SOL/USD", ok: true, match: false, virtualNet: -5, brokerNet: 0, openLots: 4 },
      { instrument: "DOGE/USD", ok: true, match: true, virtualNet: 0, brokerNet: 0, openLots: 0 }
    ]
  });
  const result = await service.requestHarvestRecovery();
  assert.equal(result.code, null);
  assert.match(result.message, /BOOKS NOT RECONCILED/);
  assert.equal(database.state.resume_code_hash, null);
  assert.equal(supervisor.recovery, null);
});

test("D-064 command confirms only after all books match and keeps the operator pause untouched", async () => {
  const database = databaseStub();
  const supervisor = supervisorStub();
  const rows = [
    { instrument: "SOL/USD", ok: true, match: true, virtualNet: 0, brokerNet: 0, openLots: 0 },
    { instrument: "DOGE/USD", ok: true, match: true, virtualNet: 0, brokerNet: 0, openLots: 0 }
  ];
  const service = serviceFor({ database, supervisor, rows });
  const request = await service.requestHarvestRecovery();
  assert.match(request.code, /^\d{6}$/);
  const message = await service.confirmHarvestRecovery(request.code);
  assert.match(message, /D-064 recovery applied: NONE/);
  assert.equal(supervisor.recovery.booksVerified, true);
  assert.equal(database.state.resume_code_hash, null);
  assert.equal(database.events.some((event) => event.type === "D064_HARVEST_RECOVERY_APPLIED"), true);
});

test("verified startup recovery clears only the matching, reconciled D-064 freshness halt", async () => {
  const database = databaseStub();
  const supervisor = supervisorStub();
  const rows = [
    { instrument: "SOL/USD", ok: true, match: true, virtualNet: 0, brokerNet: 0, openLots: 0 },
    { instrument: "DOGE/USD", ok: true, match: true, virtualNet: 0, brokerNet: 0, openLots: 0 }
  ];
  const service = serviceFor({ database, supervisor, rows });
  const result = await service.recoverVerifiedD064AtStartup();
  assert.equal(result.action, "NONE");
  assert.equal(supervisor.recovery.booksVerified, true);
  assert.equal(database.events.some((event) => event.type === "D064_VERIFIED_STARTUP_RECOVERY"), true);
});

test("verified startup recovery refuses a different persisted safety halt", async () => {
  const database = databaseStub();
  database.state.halt_reason = "D-049 protective full flatten did not confirm flat";
  const supervisor = supervisorStub();
  const rows = [
    { instrument: "SOL/USD", ok: true, match: true, virtualNet: 0, brokerNet: 0, openLots: 0 },
    { instrument: "DOGE/USD", ok: true, match: true, virtualNet: 0, brokerNet: 0, openLots: 0 }
  ];
  const service = serviceFor({ database, supervisor, rows });
  const result = await service.recoverVerifiedD064AtStartup();
  assert.equal(result.action, "DIFFERENT_SAFETY_HALT");
  assert.equal(supervisor.recovery, null);
});
