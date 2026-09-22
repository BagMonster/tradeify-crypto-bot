/**
 * watchdog/deadman.mjs — the deadman watchdog. Runs as its OWN Railway service.
 *
 *   Start command:  npm run start:deadman
 *
 * Every minute it reads the bot_liveness row the trading bot writes every 30 seconds
 * (src/monitoring/livenessStore.js). If the bot has stopped writing, or has stopped
 * completing risk evaluations, it messages the owner on Telegram directly, not
 * through the bot, because the bot is the thing that has failed.
 *
 * It deliberately imports NOTHING from the bot: only `pg`, `fetch` and its own pure
 * logic. A watcher that shares code with what it watches can die the same way.
 * It only READS the database.
 *
 * Who watches the watcher: after every successful check it pings an external uptime
 * monitor (HEALTHCHECK_PING_URL, e.g. a free healthchecks.io check). If this service
 * dies, those pings stop and that monitor alerts the owner.
 *
 * Environment (same Railway variables the trading worker uses, plus two optional):
 *   DATABASE_URL, DATABASE_SSL           Postgres (read-only use)
 *   TELEGRAM_BOT_TOKEN                   the bot's token; sendMessage only, no polling
 *   TELEGRAM_ALLOWED_USER_ID             the owner's Telegram user id
 *   HEALTHCHECK_PING_URL                 optional, strongly recommended
 *   DEADMAN_STALE_AFTER_MS               optional, default 300000 (5 minutes)
 *   DEADMAN_REMIND_EVERY_MS              optional, default 1800000 (30 minutes)
 *   DEADMAN_POLL_MS                      optional, default 60000 (1 minute)
 */

import "dotenv/config";
import pg from "pg";
import { STATES, assess, decide } from "./deadmanLogic.mjs";

const { Pool } = pg;

function required(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    console.error(`DEADMAN: ${name} is required. Set it on the deadman Railway service.`);
    process.exit(1);
  }
  return value.trim();
}

function positiveMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 10_000) {
    console.error(`DEADMAN: ${name} must be a number of milliseconds >= 10000, found ${raw}.`);
    process.exit(1);
  }
  return n;
}

const DATABASE_URL = required("DATABASE_URL");
const DATABASE_SSL = process.env.DATABASE_SSL === "true";
const TELEGRAM_BOT_TOKEN = required("TELEGRAM_BOT_TOKEN");
const OWNER_CHAT_ID = required("TELEGRAM_ALLOWED_USER_ID");
const HEALTHCHECK_PING_URL = (process.env.HEALTHCHECK_PING_URL ?? "").trim() || null;
const STALE_AFTER_MS = positiveMs("DEADMAN_STALE_AFTER_MS", 5 * 60_000);
const REMIND_EVERY_MS = positiveMs("DEADMAN_REMIND_EVERY_MS", 30 * 60_000);
const POLL_MS = positiveMs("DEADMAN_POLL_MS", 60_000);
const DB_FAILURES_BEFORE_ALERT = 3;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  max: 1,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

async function sendTelegram(text) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: OWNER_CHAT_ID, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) console.error(`DEADMAN: Telegram sendMessage returned HTTP ${response.status}.`);
    return response.ok;
  } catch (error) {
    // Never log the URL: it contains the bot token.
    console.error(`DEADMAN: Telegram sendMessage failed: ${error?.name ?? "error"}.`);
    return false;
  }
}

async function pingHealthcheck() {
  if (!HEALTHCHECK_PING_URL) return;
  try {
    await fetch(HEALTHCHECK_PING_URL, { method: "GET", signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    console.error(`DEADMAN: healthcheck ping failed: ${error?.name ?? "error"}.`);
  }
}

async function readRow() {
  try {
    const result = await pool.query(
      "SELECT last_evaluation_at, written_at, process_started_at, evaluation_count, feeds, profile FROM bot_liveness WHERE id = 1"
    );
    const row = result.rows[0] ?? null;
    if (!row) return { ok: true, row: null };
    return {
      ok: true,
      row: {
        ...row,
        last_evaluation_at: row.last_evaluation_at ? new Date(row.last_evaluation_at).toISOString() : null,
        written_at: row.written_at ? new Date(row.written_at).toISOString() : null
      }
    };
  } catch (error) {
    // Table missing (bot never deployed with the heartbeat) reads as "no heartbeat".
    if (error?.code === "42P01") return { ok: true, row: null };
    return { ok: false, error };
  }
}

let previous = null;
let dbFailures = 0;
let busy = false;

async function checkOnce() {
  if (busy) return;
  busy = true;
  try {
    const nowMs = Date.now();
    const read = await readRow();
    let assessment;
    if (!read.ok) {
      dbFailures += 1;
      console.error(`DEADMAN: cannot read bot_liveness (${dbFailures} in a row): ${read.error?.message ?? "error"}`);
      if (dbFailures < DB_FAILURES_BEFORE_ALERT) return;
      assessment = { state: STATES.WATCHDOG_DB_ERROR, failures: dbFailures };
    } else {
      dbFailures = 0;
      assessment = assess({ row: read.row, nowMs, staleAfterMs: STALE_AFTER_MS });
      // Only a successful read proves this watchdog is doing its job.
      await pingHealthcheck();
    }

    const { send, next } = decide({ previous, assessment, nowMs, remindEveryMs: REMIND_EVERY_MS });
    if (send) {
      const delivered = await sendTelegram(send);
      // If Telegram failed, do not record the alert as sent: try again next minute.
      previous = delivered ? next : (previous ?? null);
      console.log(`DEADMAN: ${assessment.state} — alert ${delivered ? "sent" : "NOT delivered, will retry"}.`);
    } else {
      previous = next;
    }
  } finally {
    busy = false;
  }
}

console.log(
  `DEADMAN watchdog started: checking bot_liveness every ${Math.round(POLL_MS / 1000)}s, ` +
  `stale after ${Math.round(STALE_AFTER_MS / 60000)}m, reminders every ${Math.round(REMIND_EVERY_MS / 60000)}m, ` +
  `external monitor ${HEALTHCHECK_PING_URL ? "ON" : "NOT SET (set HEALTHCHECK_PING_URL so the watchdog itself is watched)"}.`
);

const timer = setInterval(() => void checkOnce(), POLL_MS);
void checkOnce();

async function shutdown(signal) {
  console.log(`DEADMAN: received ${signal}; stopping.`);
  clearInterval(timer);
  try { await pool.end(); } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
