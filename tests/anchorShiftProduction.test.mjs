import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { createSolanaPersistence } from "../src/state/solanaPersistence.js";
import { createRingGrid } from "../src/strategies/ringGrid.js";
import { buildGridDefinition } from "../src/strategies/ringGridDefinition.js";
import { createSolanaRuntime } from "../src/runtime/solanaRuntime.js";
import { createAnchorShiftCoordinator } from "../src/risk/anchorShiftCoordinator.js";
import { createAnchorHistoryReconciliation } from "../src/runtime/anchorHistoryReconciliation.js";
import { formatAnchorHistory } from "../src/monitoring/anchorOwnerText.js";
import { createAnchorShiftRecovery } from "../src/runtime/anchorShiftRecovery.js";
import { createDxtradeAccountMonitor } from "../src/account/dxtradeAccountMonitor.js";
import { createLiveTelegramNotifications } from "../src/notifications/liveTelegramNotifications.js";
import { createSolanaOwnerService } from "../src/solanaOwnerService.js";
import { createMultiInstrumentOwnerService } from "../src/multiInstrumentOwnerService.js";
import { startTelegramBot } from "../src/telegramBot.js";
import { initialAnchorShiftState, trackExcursion } from "../src/strategies/anchorShift.js";

// PGlite runs the PostgreSQL engine locally: real constraints, PL/pgSQL triggers,
// BEGIN/COMMIT/ROLLBACK and the production SQL. It is not a SQL-pattern mock.
async function fixture(t, instruments = ["AAVE/USD", "RUNE/USD"], savedStates = {}) {
  const db = new PGlite();
  let tail = Promise.resolve();
  let loseCommitAck = false;
  async function acquire() {
    const prior = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await prior;
    return release;
  }
  async function query(sql, params = []) {
    if (typeof sql === "object") { params = sql.values; sql = sql.text; }
    const result = params.length ? await db.query(sql, params) : (await db.exec(sql)).at(-1);
    if (sql === "COMMIT" && loseCommitAck) { loseCommitAck = false; throw new Error("lost COMMIT acknowledgement"); }
    return { rows: result?.rows ?? [], rowCount: result?.rows?.length || result?.affectedRows || 0 };
  }
  class EnginePool {
    async query(sql, params = []) { const release = await acquire(); try { return await query(sql, params); } finally { release(); } }
    async connect() { const release = await acquire(); return { query, release }; }
    async end() { await db.close(); }
  }
  const persistence = createSolanaPersistence({ databaseUrl: "local-test-only" }, { PoolClass: EnginePool });
  t.after(() => persistence.close());
  await persistence.init();
  const sent = [];
  const notifications = createLiveTelegramNotifications({ persistence });
  let clock = 1_000;
  let orderCalls = 0;
  const runtimes = [];
  const configs = [];
  for (const instrument of instruments) {
    const coin = instrument.split("/")[0];
    const config = { instrument, marketSymbol: `${coin}USDT`, orderPrefix: coin, enabled: true, geometry: { maDays: 200, bandPct: 0.05, deadZoneBands: 0, activeLevelsPerSide: 2, growth: 1.2, innerLevels: 1, innerPositionsPerRing: 1, outerPositionsPerRing: 2, rearmBands: 0.5 }, sizing: { capUsd: 500, lotStep: 0.01, roundTripCostFloorPct: 0.001 }, tranches: { weights: [1, 2, 3, 4], denominator: 10 } };
    configs.push(config);
    const definition = buildGridDefinition(config);
    const grid = createRingGrid(definition);
    const anchorStore = persistence.createAnchorStore(instrument);
    await anchorStore.save(savedStates[instrument] ?? trackExcursion(initialAnchorShiftState(), { price: 120, anchor: 100, geometry: definition, occurredAt: new Date(clock).toISOString() }).state);
    const execution = { isEnabled: () => false, hasOrderInFlight: () => false, async executeIntent() { orderCalls += 1; throw new Error("NO ORDERS AUTHORIZED"); }, async executeProtectiveCut() { orderCalls += 1; }, async executeProtectiveFlatten() { orderCalls += 1; } };
    const runtime = createSolanaRuntime({ instrument, strategyId: definition.strategyId, gridDefinition: definition, stateStore: persistence.createStateStore(grid), anchorStore, maProvider: { async getCurrent() { return { ma: 100 }; } }, execution, notifications, getRiskSnapshot: async () => ({ signedNetReadOk: true, accountLocked: false, brokerNetUnits: 0, instrumentUnrealisedUsd: 0, instrumentDayPnlUsd: 0, instrumentExposureUsd: 0 }) });
    await runtime.init();
    runtimes.push(runtime);
  }
  let monitor;
  const coordinator = createAnchorShiftCoordinator({ getCurrentSnapshot: () => { const status = monitor.getSnapshot(); return status.healthy ? status.snapshot : null; }, books: runtimes.map((runtime, i) => ({ instrument: instruments[i], ...runtime })), notifications, now: () => clock });
  let recovery;
  let publishBlocked = false;
  monitor = createDxtradeAccountMonitor({
    client: { async login() {}, async getAccountMetrics() { return { metrics: [{ equity: 10_000, balance: 10_000, openPl: 0, dayClosedPl: 0, openPositionsCount: 0, positions: [] }] }; }, async getOpenPositions() { return { positions: [] }; } },
    instruments, startingBalance: 10_000, getPersistedPeakClosedBalance: async () => 10_000,
    onSnapshot: (snapshot) => publishBlocked ? new Promise(() => {}) : recovery.observe(snapshot), now: () => clock
  });
  let timerCallback = null;
  recovery = createAnchorShiftRecovery({ accountMonitor: monitor, coordinator, setTimer: (fn) => { timerCallback = fn; return { unref() {} }; }, clearTimer: () => { timerCallback = null; } });
  t.after(() => recovery.stop());
  let executionEnabled = false;
  const reconciliation = createAnchorHistoryReconciliation({ persistence, accountMonitor: monitor, coordinator,
    books: runtimes.map((r, i) => ({ instrument: instruments[i], ...r })),
    isExecutionEnabled: () => executionEnabled, now: () => clock });
  const service = createMultiInstrumentOwnerService({ instrumentConfigs: configs, reconcileAnchorHistory: reconciliation.run, recoverAnchors: recovery.recover, getAnchorRecoveryStatus: coordinator.getSnapshot, buildOwnerService: (cfg) => ({
    ...createSolanaOwnerService({ strategy: { instruments: { [cfg.instrument]: { enabled: true } } }, persistence,
      gridDefinition: buildGridDefinition(cfg), anchorRuntime: runtimes[instruments.indexOf(cfg.instrument)],
      maProvider: { async getCurrent() { return { ma: 100 }; } }, getLiveMarketSnapshot: () => ({ price: 100 }) }),
    inspectForRerun: async () => ({ ok: true, match: true, virtualNet: 0, brokerNet: 0, openLots: 0 }) }) });
  class Bot {
    handlers = [];
    onText(regex, fn) { this.handlers.push([regex, fn]); }
    on() {}
    async setMyCommands() {}
    async sendMessage(_chat, text) { sent.push(text); }
    async stopPolling() {}
  }
  const bot = await startTelegramBot({ environment: { telegramToken: "test", telegramAllowedUserId: 1 }, service, notifications, BotClass: Bot });
  t.after(() => bot.stopDevCompanionDelivery?.());
  async function command(text) {
    const [regex, handler] = bot.handlers.find(([regex]) => regex.test(text));
    await handler({ chat: { id: 1 }, from: { id: 1 } }, text.match(regex));
  }
  async function tick(at) {
    clock = at;
    await monitor.pollOnce();
    await monitor.flushPublish();
    if (timerCallback) { const fn = timerCallback; timerCallback = null; await fn(); }
    await recovery.confirm();
    await notifications.drain();
  }
  return { persistence, db, sent, runtimes, reconciliation, setExecution: (on) => { executionEnabled = on; }, coordinator, monitor, recovery, service, command, tick, setClock: (at) => { clock = at; }, orderCalls: () => orderCalls, blockPublication: () => { publishBlocked = true; }, loseCommitAck: () => { loseCommitAck = true; }, fireTimer: async () => { const fn = timerCallback; timerCallback = null; assert.ok(fn); return fn(); } };
}

test("production Telegram recovery → real monitor/watcher → D060 runtime → PostgreSQL state/history → success, with execution OFF", async (t) => {
  const f = await fixture(t);
  await f.command("/anchorrecover CONFIRM");
  assert.ok(f.sent.some((text) => text.includes("HOLD STARTED")));
  await f.tick(9_999);
  assert.equal(await f.persistence.countAnchorShiftHistory("AAVE/USD"), 0);
  await f.tick(10_000);
  await Promise.all([f.recovery.confirm(), f.recovery.confirm(), f.monitor.flushPublish()]);
  for (const instrument of ["AAVE/USD", "RUNE/USD"]) {
    const state = await f.persistence.loadAnchorState(instrument);
    const history = await f.persistence.listAnchorShiftHistory(instrument);
    assert.equal(history.length, 1);
    assert.equal(history[0].newMultiplier, state.multiplier);
    assert.equal(state.upperExtreme, null);
    assert.equal(history[0].shiftedAt, state.lastShiftAt);
    assert.equal(f.sent.filter((text) => text.includes(`${instrument} grid shifted`)).length, 1, JSON.stringify(f.sent));
  }
  assert.equal(f.coordinator.getSnapshot().pending, false);
  assert.equal(f.coordinator.getSnapshot().failure, null);
  assert.equal(f.orderCalls(), 0);
});

for (const table of ["ring_anchor_shift_state", "ring_anchor_shift_history"]) {
  test(`real PostgreSQL ${table} trigger failure rolls back both writes, preserves memory, stops retries and alerts`, async (t) => {
    const f = await fixture(t, ["AAVE/USD", "RUNE/USD", "SOL/USD"]);
    await f.db.exec(`CREATE FUNCTION reject_anchor_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.instrument = 'RUNE/USD' THEN RAISE EXCEPTION 'injected write rejection'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_anchor BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_anchor_write();`);
    await f.command("/anchorrecover CONFIRM");
    await f.tick(10_000);
    const rune = await f.persistence.loadAnchorState("RUNE/USD");
    assert.equal(rune.multiplier, 1);
    assert.equal(rune.upperExtreme, 120);
    assert.equal(f.runtimes[1].getAnchorState().multiplier, 1);
    assert.equal(await f.persistence.countAnchorShiftHistory("RUNE/USD"), 0);
    assert.equal(await f.persistence.countAnchorShiftHistory("AAVE/USD"), 1);
    assert.equal(f.coordinator.getSnapshot().pending, false);
    assert.equal(f.coordinator.getSnapshot().failure.rollbackConfirmed, true);
    await f.tick(12_000);
    assert.equal(f.sent.filter((text) => text.includes("ANCHOR SHIFT FAILED")).length, 1);
    const alert = f.sent.find((text) => text.includes("ANCHOR SHIFT FAILED"));
    assert.match(alert, /PERSISTENCE_FAILED/);
    assert.match(alert, /Completed: AAVE\/USD/);
    assert.match(alert, /Not attempted: SOL\/USD/);
    assert.equal(await f.persistence.countAnchorShiftHistory("SOL/USD"), 0);
    assert.doesNotMatch(alert, /injected|trigger|postgres/i);
    assert.match(await f.service.statusText(), /ANCHOR SHIFT FAILED/);
    assert.equal(f.orderCalls(), 0);
  });
}

test("validation rejects the historical multiplier mismatch before writing any state", async (t) => {
  const f = await fixture(t, ["AAVE/USD"]);
  const state = f.runtimes[0].getAnchorState();
  await assert.rejects(f.persistence.commitAnchorShift("AAVE/USD", { state, shiftedAt: new Date(1_000).toISOString(), side: "UPPER", extreme: 120, maNow: 100, oldMultiplier: 1, multiplier: 2 }), /newMultiplier/);
  assert.equal((await f.persistence.loadAnchorState("AAVE/USD")).multiplier, 1);
  assert.equal(await f.persistence.countAnchorShiftHistory("AAVE/USD"), 0);
});

test("ZEC with shifted state and absent history is preserved and never re-shifted by account recovery", async (t) => {
  const f = await fixture(t, ["ZEC/USD"]);
  await f.persistence.saveAnchorState("ZEC/USD", { ...initialAnchorShiftState(), multiplier: 1.801, lastShiftAt: "2026-10-07T10:40:59.200Z" });
  await f.runtimes[0].init();
  await f.command("/anchorrecover CONFIRM");
  assert.match(f.sent.at(-1), /not needed/);
  await f.tick(10_000);
  assert.equal((await f.persistence.loadAnchorState("ZEC/USD")).multiplier, 1.801);
  assert.equal(await f.persistence.countAnchorShiftHistory("ZEC/USD"), 0);
  assert.equal(f.orderCalls(), 0);
});

test("terminal failure alert bypasses unavailable database claims and a stalled regular delivery queue", async () => {
  let claims = 0; const sent = [];
  const notifications = createLiveTelegramNotifications({ persistence: { async claimTelegramNotification() { claims += 1; return new Promise(() => {}); }, async markTelegramNotificationSent() {}, async markTelegramNotificationFailed() {} }, addEvent: async () => { throw new Error("offline"); } });
  notifications.setSender(async (text) => { sent.push(text); });
  notifications.enqueue({ kind: "ANCHOR_SHIFT_HOLD_STARTED", eventKey: "hold:test", holdMs: 9000, instruments: ["AAVE/USD"] });
  await new Promise((resolve) => setImmediate(resolve));
  notifications.enqueue({ kind: "ANCHOR_SHIFT_FAILED", eventKey: "failure:test", instrument: "AAVE/USD", reason: "PERSISTENCE_FAILED", rollbackConfirmed: false, shifted: [], unprocessed: ["RUNE/USD"] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claims, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /ANCHOR SHIFT FAILED/);
  assert.match(sent[0], /Not attempted: RUNE\/USD/);
});

test("independent watcher finishes the hold while real monitor publication is stalled", async (t) => {
  const f = await fixture(t);
  await f.command("/anchorrecover CONFIRM");
  await f.monitor.flushPublish();
  f.blockPublication();
  f.setClock(10_000);
  await f.monitor.pollOnce();
  // Do not flush the deliberately stalled publisher. The same confirm() used
  // by the production timer must operate on latest, freshness-checked data.
  assert.equal((await f.fireTimer()).action, "SHIFTED");
  await f.persistence.countAnchorShiftHistory("AAVE/USD");
  for (const instrument of ["AAVE/USD", "RUNE/USD"]) assert.equal(await f.persistence.countAnchorShiftHistory(instrument), 1);
  assert.equal(f.orderCalls(), 0);
});

test("lost COMMIT acknowledgement requires owner review and never repeats a committed shift", async (t) => {
  const f = await fixture(t, ["AAVE/USD"]);
  f.loseCommitAck();
  await f.command("/anchorrecover CONFIRM");
  await f.tick(10_000);
  assert.equal(f.coordinator.getSnapshot().failure.rollbackConfirmed, false);
  assert.equal(await f.persistence.countAnchorShiftHistory("AAVE/USD"), 1);
  assert.notEqual((await f.persistence.loadAnchorState("AAVE/USD")).multiplier, 1);
  assert.equal(f.runtimes[0].getAnchorState().multiplier, 1);
  await f.command("/anchorrecover CONFIRM");
  await f.tick(12_000);
  assert.equal(await f.persistence.countAnchorShiftHistory("AAVE/USD"), 1);
  assert.ok(f.sent.some((text) => text.includes("Owner review of state and history")));
});

test("concurrent price processing cannot overwrite a committed anchor with an older excursion state", async (t) => {
  const f = await fixture(t, ["AAVE/USD"]);
  await f.command("/anchorrecover CONFIRM");
  f.setClock(10_000);
  await f.monitor.pollOnce();
  await Promise.all([
    f.recovery.confirm(),
    f.runtimes[0].processTrade({ source: "binance", symbol: "AAVEUSDT", price: 119, tradeTime: new Date(10_000).toISOString() })
  ]);
  await f.monitor.flushPublish();
  // Apply another serialized no-op to drain any coalesced excursion save.
  await f.runtimes[0].applyAnchorShift();
  const state = await f.persistence.loadAnchorState("AAVE/USD");
  assert.equal(state.multiplier, f.runtimes[0].getAnchorState().multiplier);
  assert.notEqual(state.multiplier, 1);
  assert.equal(state.upperExtreme, null);
  assert.equal(await f.persistence.countAnchorShiftHistory("AAVE/USD"), 1);
  assert.equal(f.orderCalls(), 0);
});

test("flatness lost between state/history writes and COMMIT rolls back the complete shift", async (t) => {
  const f = await fixture(t, ["AAVE/USD"]);
  const prior = await f.persistence.loadAnchorState("AAVE/USD");
  const next = { ...initialAnchorShiftState(), multiplier: 2, lastShiftAt: new Date(10_000).toISOString() };
  let validations = 0;
  await assert.rejects(f.persistence.commitAnchorShift("AAVE/USD", {
    state: next, shiftedAt: next.lastShiftAt, side: "UPPER", extreme: 220, maNow: 100, oldMultiplier: 1, newMultiplier: 2,
    validateFlat: () => ++validations === 1
  }), (error) => error.code === "ANCHOR_PERSISTENCE_FAILED" && error.rollbackConfirmed === true);
  assert.equal((await f.persistence.loadAnchorState("AAVE/USD")).multiplier, prior.multiplier);
  assert.equal(await f.persistence.countAnchorShiftHistory("AAVE/USD"), 0);
});

const legacyState = (multiplier, lastShiftAt) => ({ ...initialAnchorShiftState(), multiplier, lastShiftAt });
const legacyStates = {
  "ZEC/USD": legacyState(1.801012345678901, "2026-10-07T10:40:59.200Z"),
  "AAVE/USD": legacyState(1.197712345678901, "2026-10-07T11:42:15.734Z")
};

test("owner Telegram reconciliation previews persisted gaps, records factual audit only, and is idempotent", async (t) => {
  const f = await fixture(t, ["ZEC/USD", "AAVE/USD", "RUNE/USD"], legacyStates);
  const before = await f.db.query("SELECT * FROM ring_anchor_shift_state ORDER BY instrument");
  const memory = f.runtimes.map((r) => r.getAnchorState());
  await f.command("/anchorreconcile");
  assert.match(f.sent.at(-1), /PREVIEW/);
  assert.match(f.sent.at(-1), /ZEC\/USD/);
  assert.match(f.sent.at(-1), /AAVE\/USD/);
  assert.doesNotMatch(f.sent.at(-1), /RUNE\/USD/);
  assert.equal((await f.db.query("SELECT * FROM ring_anchor_shift_reconciliations")).rows.length, 0);
  await f.command("/anchorreconcile CONFIRM");
  assert.match(f.sent.at(-1), /ANCHOR HISTORY RECONCILED/);
  for (const instrument of ["ZEC/USD", "AAVE/USD"]) {
    const audit = await f.persistence.createAnchorStore(instrument).reconciliations();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].shiftedAt, legacyStates[instrument].lastShiftAt);
    assert.match(audit[0].savedMultiplier, /123456789/);
    assert.match(formatAnchorHistory(audit, instrument), /RECONCILED SAVED STATE/);
    assert.match(formatAnchorHistory(audit, instrument), /original side\/extreme\/MA\/old multiplier unknown/);
    assert.equal(await f.persistence.countAnchorShiftHistory(instrument), 0);
  }
  assert.deepEqual((await f.db.query("SELECT * FROM ring_anchor_shift_state ORDER BY instrument")).rows, before.rows);
  assert.deepEqual(f.runtimes.map((r) => r.getAnchorState()), memory);
  await f.command("/anchorhistory ZEC");
  assert.match(f.sent.at(-1), /RECONCILED SAVED STATE/);
  assert.doesNotMatch(f.sent.at(-1), /NaN/);
  await f.command("/anchors");
  assert.match(f.sent.at(-1), /shifts: 0.*reconciled saved states: 1/);
  assert.equal(f.runtimes[2].hasPendingAnchorExcursion(), true);
  assert.equal(f.orderCalls(), 0);
  await f.command("/anchorreconcile CONFIRM");
  assert.match(f.sent.at(-1), /No saved anchors/);
  assert.equal((await f.db.query("SELECT * FROM ring_anchor_shift_reconciliations")).rows.length, 2);
});

test("reconciliation refuses execution ON, active recovery, and runtime/saved-state mismatch", async (t) => {
  const f = await fixture(t, ["ZEC/USD", "RUNE/USD"], legacyStates);
  f.setExecution(true);
  await f.command("/anchorreconcile CONFIRM");
  assert.match(f.sent.at(-1), /REFUSED/);
  f.setExecution(false);
  await f.command("/anchorrecover CONFIRM");
  await f.command("/anchorreconcile CONFIRM");
  assert.match(f.sent.at(-1), /REFUSED/);
  assert.equal((await f.db.query("SELECT * FROM ring_anchor_shift_reconciliations")).rows.length, 0);
  const g = await fixture(t, ["ZEC/USD"], legacyStates);
  await g.db.query("UPDATE ring_anchor_shift_state SET multiplier=2 WHERE instrument='ZEC/USD'");
  await g.command("/anchorreconcile CONFIRM");
  assert.match(g.sent.at(-1), /REFUSED/);
});

test("PostgreSQL audit failure rolls back the whole reconciliation batch and reports a terminal failure", async (t) => {
  const f = await fixture(t, ["ZEC/USD", "AAVE/USD"], legacyStates);
  await f.db.exec(`CREATE FUNCTION reject_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.instrument = 'ZEC/USD' THEN RAISE EXCEPTION 'audit write rejected'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_reconciliation BEFORE INSERT ON ring_anchor_shift_reconciliations
      FOR EACH ROW EXECUTE FUNCTION reject_reconciliation();`);
  const before = (await f.db.query("SELECT * FROM ring_anchor_shift_state ORDER BY instrument")).rows;
  await f.command("/anchorreconcile CONFIRM");
  assert.match(f.sent.at(-1), /RECONCILIATION FAILED/);
  assert.doesNotMatch(f.sent.at(-1), /audit write rejected/);
  assert.equal((await f.db.query("SELECT * FROM ring_anchor_shift_reconciliations")).rows.length, 0);
  assert.deepEqual((await f.db.query("SELECT * FROM ring_anchor_shift_state ORDER BY instrument")).rows, before);
});

test("reconciliation checks state locks and safety again before COMMIT; ordinary shift history is excluded", async (t) => {
  const f = await fixture(t, ["ZEC/USD", "AAVE/USD"], legacyStates);
  const gaps = await f.persistence.inspectAnchorHistoryGaps(["ZEC/USD", "AAVE/USD"]);
  let checks = 0;
  await assert.rejects(f.persistence.reconcileAnchorHistory(gaps, () => ++checks === 1), /reconciliation failed/);
  assert.equal((await f.db.query("SELECT * FROM ring_anchor_shift_reconciliations")).rows.length, 0);
  await f.db.query("UPDATE ring_anchor_shift_state SET multiplier=2 WHERE instrument='ZEC/USD'");
  await assert.rejects(f.persistence.reconcileAnchorHistory(gaps, () => true), /reconciliation failed/);
  assert.equal((await f.db.query("SELECT * FROM ring_anchor_shift_reconciliations")).rows.length, 0);
  await f.persistence.appendAnchorShift({ instrument: "AAVE/USD", shiftedAt: legacyStates["AAVE/USD"].lastShiftAt,
    side: "UPPER", extreme: 120, maNow: 100, oldMultiplier: 1, newMultiplier: legacyStates["AAVE/USD"].multiplier });
  const remaining = await f.persistence.inspectAnchorHistoryGaps(["ZEC/USD", "AAVE/USD"]);
  assert.deepEqual(remaining.map((g) => g.instrument), ["ZEC/USD"]);
});

test("lost reconciliation COMMIT acknowledgement can be inspected and never duplicates audit records", async (t) => {
  const f = await fixture(t, ["ZEC/USD"], legacyStates);
  f.loseCommitAck();
  await f.command("/anchorreconcile CONFIRM");
  assert.match(f.sent.at(-1), /commit outcome may be uncertain/);
  await f.command("/anchorreconcile");
  assert.match(f.sent.at(-1), /No saved anchors/);
  assert.equal((await f.db.query("SELECT * FROM ring_anchor_shift_reconciliations")).rows.length, 1);
  assert.equal(f.orderCalls(), 0);
});

test("confirmation refuses stale, non-flat, unreadable, virtual-open, and in-flight account paths", async (t) => {
  const f = await fixture(t, ["ZEC/USD"], legacyStates);
  await f.monitor.pollOnce();
  const healthy = f.monitor.getSnapshot();
  const baseBook = { instrument: "ZEC/USD", ...f.runtimes[0] };
  for (const scenario of [
    { snapshot: { ...healthy.snapshot, fetchedAtMs: -10_000 } },
    { snapshot: { ...healthy.snapshot, fetchedAtMs: 2_000 } },
    { snapshot: { ...healthy.snapshot, openPositionsCount: 1 } },
    { snapshot: { ...healthy.snapshot, signedNetReadOk: false } },
    { snapshot: { ...healthy.snapshot, positionsReadFailed: true } },
    { book: { ...baseBook, hasVirtualLots: () => true } },
    { book: { ...baseBook, hasOrderInFlight: () => true } }
  ]) {
    const r = createAnchorHistoryReconciliation({ persistence: f.persistence,
      accountMonitor: { async pollOnce() {}, getSnapshot: () => ({ ...healthy, snapshot: scenario.snapshot ?? healthy.snapshot }) },
      coordinator: f.coordinator, books: [scenario.book ?? baseBook], isExecutionEnabled: () => false, now: () => 1_000 });
    assert.match(await r.run(true), /REFUSED/);
  }
  assert.equal((await f.db.query("SELECT * FROM ring_anchor_shift_reconciliations")).rows.length, 0);
  assert.equal(f.orderCalls(), 0);
});
