import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { STATES, assess, decide, formatAge } from "../watchdog/deadmanLogic.mjs";
import { createLivenessHeartbeat, createLivenessStore } from "../src/monitoring/livenessStore.js";

// Deadman switch. The bot writes bot_liveness every 30 s (src/monitoring/livenessStore.js);
// a separate Railway service (watchdog/deadman.mjs) reads it every minute and pages the
// owner directly when it goes stale. These tests pin the decisions and the separation.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STALE = 5 * 60_000;
const REMIND = 30 * 60_000;
const NOW = Date.parse("2026-09-21T23:00:00.000Z");
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function row({ writtenAgo = 20_000, evaluatedAgo = 15_000, feeds = { "SOL/USD": 2, "INJ/USD": 1 } } = {}) {
  return {
    written_at: writtenAgo === null ? null : iso(writtenAgo),
    last_evaluation_at: evaluatedAgo === null ? null : iso(evaluatedAgo),
    feeds,
    profile: "10k"
  };
}

// ---- assess(): what state is the bot in? ------------------------------------------

test("a fresh heartbeat with a recent evaluation is healthy", () => {
  assert.equal(assess({ row: row(), nowMs: NOW, staleAfterMs: STALE }).state, STATES.HEALTHY);
});

test("no heartbeat written for longer than the threshold means the process is down", () => {
  const a = assess({ row: row({ writtenAgo: 6 * 60_000, evaluatedAgo: 6 * 60_000 }), nowMs: NOW, staleAfterMs: STALE });
  assert.equal(a.state, STATES.PROCESS_DOWN);
});

test("heartbeat still writing but no completed evaluation means risk checks stopped (a hang)", () => {
  // The write timer keeps firing even when an evaluation is hung; only the
  // evaluation timestamp stops moving.
  const a = assess({ row: row({ writtenAgo: 20_000, evaluatedAgo: 7 * 60_000 }), nowMs: NOW, staleAfterMs: STALE });
  assert.equal(a.state, STATES.EVALUATIONS_STOPPED);
});

test("dead price feeds are named in the evaluations-stopped alert", () => {
  const a = assess({
    row: row({ writtenAgo: 20_000, evaluatedAgo: 8 * 60_000, feeds: { "SOL/USD": 480, "INJ/USD": 470, "AVAX/USD": null } }),
    nowMs: NOW, staleAfterMs: STALE
  });
  const { send } = decide({ previous: null, assessment: a, nowMs: NOW, remindEveryMs: REMIND });
  assert.match(send, /RISK CHECKS HAVE STOPPED/);
  assert.match(send, /SOL\/USD 480s, INJ\/USD 470s, AVAX\/USD no trade yet/);
});

test("a missing row means the bot has never written a heartbeat", () => {
  assert.equal(assess({ row: null, nowMs: NOW, staleAfterMs: STALE }).state, STATES.NO_HEARTBEAT);
});

// ---- decide(): when to message the owner --------------------------------------------

test("healthy and nothing outstanding sends nothing", () => {
  const a = assess({ row: row(), nowMs: NOW, staleAfterMs: STALE });
  assert.equal(decide({ previous: null, assessment: a, nowMs: NOW, remindEveryMs: REMIND }).send, null);
});

test("an outage alerts once, stays quiet each minute, then reminds every 30 minutes", () => {
  const down = assess({ row: row({ writtenAgo: 6 * 60_000, evaluatedAgo: 6 * 60_000 }), nowMs: NOW, staleAfterMs: STALE });
  let r = decide({ previous: null, assessment: down, nowMs: NOW, remindEveryMs: REMIND });
  assert.match(r.send, /^🚨 DEADMAN: TRADING BOT IS SILENT/);
  assert.match(r.send, /No heartbeat for 6m/);
  let previous = r.next;
  for (let minute = 1; minute < 30; minute += 1) {
    r = decide({ previous, assessment: down, nowMs: NOW + minute * 60_000, remindEveryMs: REMIND });
    assert.equal(r.send, null, `minute ${minute} should be quiet`);
    previous = r.next;
  }
  r = decide({ previous, assessment: down, nowMs: NOW + 30 * 60_000, remindEveryMs: REMIND });
  assert.match(r.send, /^🚨 \(still\) DEADMAN: TRADING BOT IS SILENT/);
});

test("recovery after an alert sends one message with the whole outage length", () => {
  const down = assess({ row: row({ writtenAgo: 6 * 60_000, evaluatedAgo: 6 * 60_000 }), nowMs: NOW, staleAfterMs: STALE });
  const first = decide({ previous: null, assessment: down, nowMs: NOW, remindEveryMs: REMIND });
  const healthy = assess({ row: row(), nowMs: NOW, staleAfterMs: STALE });
  const back = decide({ previous: first.next, assessment: healthy, nowMs: NOW + 12 * 60_000, remindEveryMs: REMIND });
  assert.match(back.send, /BOT HEARTBEAT RESTORED/);
  assert.match(back.send, /after 12m of trouble/);
  const after = decide({ previous: back.next, assessment: healthy, nowMs: NOW + 13 * 60_000, remindEveryMs: REMIND });
  assert.equal(after.send, null);
});

test("a change in HOW the bot is unhealthy alerts again, and the outage clock keeps running", () => {
  const down = assess({ row: row({ writtenAgo: 6 * 60_000, evaluatedAgo: 6 * 60_000 }), nowMs: NOW, staleAfterMs: STALE });
  const a = decide({ previous: null, assessment: down, nowMs: NOW, remindEveryMs: REMIND });
  const stalled = assess({ row: row({ writtenAgo: 10_000, evaluatedAgo: 9 * 60_000 }), nowMs: NOW, staleAfterMs: STALE });
  const b = decide({ previous: a.next, assessment: stalled, nowMs: NOW + 4 * 60_000, remindEveryMs: REMIND });
  assert.match(b.send, /RISK CHECKS HAVE STOPPED/);
  assert.equal(b.next.sinceMs, NOW);
});

test("a watchdog database failure is reported as the watchdog's problem, not the bot's", () => {
  const r = decide({ previous: null, assessment: { state: STATES.WATCHDOG_DB_ERROR, failures: 3 }, nowMs: NOW, remindEveryMs: REMIND });
  assert.match(r.send, /WATCHDOG CANNOT READ POSTGRES/);
  assert.match(r.send, /3 checks in a row failed/);
});

test("ages read naturally", () => {
  assert.equal(formatAge(45_000), "45s");
  assert.equal(formatAge(6 * 60_000), "6m");
  assert.equal(formatAge(150 * 60_000), "2h 30m");
});

// ---- Bot side ------------------------------------------------------------------------

test("a BUSY evaluation is not evidence of health; completed ones are", async () => {
  const writes = [];
  let t = 1_000;
  const hb = createLivenessHeartbeat({ store: { write: async (w) => writes.push(w) }, profile: "10k", now: () => t });
  hb.noteEvaluation({ action: "BUSY" });
  await hb.flush();
  assert.equal(writes[0].lastEvaluationAtMs, null, "the write timer alone never marks the bot healthy");
  t = 5_000;
  hb.noteEvaluation({ action: "NONE" });
  hb.noteEvaluation({ action: "CUT" });
  await hb.flush();
  assert.equal(writes[1].lastEvaluationAtMs, 5_000);
  assert.equal(writes[1].evaluationCount, 2);
  assert.equal(writes[1].profile, "10k");
});

test("a failed heartbeat write is reported and never thrown into the trading path", async () => {
  const errors = [];
  const hb = createLivenessHeartbeat({
    store: { write: async () => { throw new Error("db down"); } },
    onWriteError: (error, n) => errors.push([error.message, n])
  });
  assert.equal(await hb.flush(), false);
  assert.equal(await hb.flush(), false);
  assert.deepEqual(errors, [["db down", 1], ["db down", 2]]);
});

test("the store creates its table and upserts one row", async () => {
  const queries = [];
  class FakePool {
    async query(sql, params) { queries.push({ sql, params }); return { rows: [] }; }
    async end() { queries.push({ sql: "END" }); }
  }
  const store = createLivenessStore({ databaseUrl: "postgres://x", PoolClass: FakePool });
  await store.init();
  await store.write({ lastEvaluationAtMs: NOW, processStartedAtMs: NOW - 60_000, evaluationCount: 7, feeds: { "SOL/USD": 1 }, profile: "10k" });
  await store.close();
  assert.match(queries[0].sql, /CREATE TABLE IF NOT EXISTS bot_liveness/);
  assert.match(queries[1].sql, /ON CONFLICT \(id\) DO UPDATE/);
  assert.deepEqual(queries[1].params, ["2026-09-21T23:00:00.000Z", "2026-09-21T22:59:00.000Z", 7, "{\"SOL/USD\":1}", "10k"]);
  assert.equal(queries[2].sql, "END");
});

// ---- Separation -------------------------------------------------------------------------

test("the watchdog imports nothing from the bot", async () => {
  // A watcher that shares code with what it watches can die the same way.
  for (const file of await readdir(path.join(ROOT, "watchdog"))) {
    if (!file.endsWith(".mjs") && !file.endsWith(".js")) continue;
    const text = await readFile(path.join(ROOT, "watchdog", file), "utf8");
    for (const [, spec] of text.matchAll(/from\s+"([^"]+)"/g)) {
      assert.ok(
        spec === "pg" || spec === "dotenv/config" || spec.startsWith("node:") || spec.startsWith("./"),
        `watchdog/${file} imports "${spec}"; the watchdog may only use pg, dotenv, node built-ins and its own files`
      );
    }
  }
});

test("the watchdog refuses to start without its required settings", () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, "watchdog", "deadman.mjs")], {
    cwd: path.join(ROOT, "watchdog"),
    env: { PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 10_000
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DATABASE_URL is required/);
});
