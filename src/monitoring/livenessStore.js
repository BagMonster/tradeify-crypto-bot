/**
 * src/monitoring/livenessStore.js
 *
 * Bot side of the deadman switch: one Postgres row the bot keeps current, which a
 * separate watcher service (watchdog/deadman.mjs) reads.
 *
 * WHY. Every alert the bot sends assumes the bot is running. If the process dies,
 * hangs, or its price feeds stop, nothing tells anyone: the owner finds out from
 * /status or from a breach. A dead process cannot report its own death, so the
 * check that notices has to live outside it.
 *
 * WHAT IS RECORDED (one row, id = 1):
 *   last_evaluation_at  when a risk-supervisor evaluation last COMPLETED. evaluate()
 *                       runs on every Binance trade and returns BUSY if a previous
 *                       call is still running, so one hung evaluation silently turns
 *                       every later one into a no-op. Only completed evaluations
 *                       count, which makes a hang, a dead feed and a dead process all
 *                       show up the same way: this timestamp stops moving.
 *   written_at          when the bot last wrote this row. Fresh here but a stale
 *                       last_evaluation_at means "process alive, risk checks stopped".
 *   process_started_at  when this process started, so a restart loop is visible.
 *   evaluation_count    completed evaluations since start.
 *   feeds               per-book seconds since the last Binance trade, for the alert.
 *   profile             the account profile in use.
 *
 * Writing must never interfere with trading: callers catch and log failures.
 */

import pg from "pg";

const { Pool } = pg;

export function createLivenessStore({ databaseUrl, databaseSsl = false, PoolClass = Pool }) {
  if (typeof databaseUrl !== "string" || databaseUrl === "") throw new TypeError("databaseUrl is required");
  // One connection is plenty for a single upsert every 30 seconds, and keeps the
  // heartbeat from competing with the trading pools.
  const pool = new PoolClass({
    connectionString: databaseUrl,
    ssl: databaseSsl ? { rejectUnauthorized: false } : undefined,
    max: 1,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  async function init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_liveness (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        last_evaluation_at TIMESTAMPTZ,
        written_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        process_started_at TIMESTAMPTZ NOT NULL,
        evaluation_count BIGINT NOT NULL DEFAULT 0,
        feeds JSONB NOT NULL DEFAULT '{}'::jsonb,
        profile TEXT
      )
    `);
  }

  async function write({ lastEvaluationAtMs, processStartedAtMs, evaluationCount, feeds, profile }) {
    const lastEvaluation = Number.isFinite(lastEvaluationAtMs) ? new Date(lastEvaluationAtMs).toISOString() : null;
    await pool.query(
      `INSERT INTO bot_liveness (id, last_evaluation_at, written_at, process_started_at, evaluation_count, feeds, profile)
         VALUES (1, $1, NOW(), $2, $3, $4::jsonb, $5)
         ON CONFLICT (id) DO UPDATE SET
           last_evaluation_at = EXCLUDED.last_evaluation_at,
           written_at = NOW(),
           process_started_at = EXCLUDED.process_started_at,
           evaluation_count = EXCLUDED.evaluation_count,
           feeds = EXCLUDED.feeds,
           profile = EXCLUDED.profile`,
      [
        lastEvaluation,
        new Date(processStartedAtMs).toISOString(),
        Number.isSafeInteger(evaluationCount) ? evaluationCount : 0,
        JSON.stringify(feeds ?? {}),
        typeof profile === "string" ? profile.slice(0, 32) : null
      ]
    );
  }

  async function close() {
    await pool.end();
  }

  return Object.freeze({ init, write, close });
}

/**
 * Keeps the in-memory heartbeat and writes it on a timer. The timer only copies what
 * the evaluation path recorded; it never marks the bot healthy by itself, so a hung
 * evaluation still shows as stale even though this timer keeps firing.
 */
export function createLivenessHeartbeat({ store, profile = null, getFeeds = () => ({}), now = () => Date.now(), onWriteError = () => {} }) {
  const processStartedAtMs = now();
  let lastEvaluationAtMs = null;
  let evaluationCount = 0;
  let consecutiveWriteFailures = 0;

  // Call with the result of riskSupervisor.evaluate(). BUSY means the call did not
  // run (a previous one is still in progress), so it is not evidence of health.
  function noteEvaluation(result) {
    if (result?.action === "BUSY") return;
    lastEvaluationAtMs = now();
    evaluationCount += 1;
  }

  async function flush() {
    let feeds = {};
    try {
      feeds = getFeeds() ?? {};
    } catch {
      feeds = {};
    }
    try {
      await store.write({ lastEvaluationAtMs, processStartedAtMs, evaluationCount, feeds, profile });
      consecutiveWriteFailures = 0;
      return true;
    } catch (error) {
      consecutiveWriteFailures += 1;
      try { onWriteError(error, consecutiveWriteFailures); } catch {}
      return false;
    }
  }

  function snapshot() {
    return Object.freeze({ processStartedAtMs, lastEvaluationAtMs, evaluationCount, consecutiveWriteFailures });
  }

  return Object.freeze({ noteEvaluation, flush, snapshot });
}
