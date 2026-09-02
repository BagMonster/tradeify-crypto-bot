import pg from "pg";
import { createPostgresSolanaGridStateStore } from "./solanaGridState.js";
import { createPostgresRingGridStateStore } from "./ringGridState.js";

const { Pool } = pg;

const EXECUTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS solana_execution_orders (
  order_code TEXT PRIMARY KEY CHECK (LENGTH(order_code) BETWEEN 1 AND 64),
  strategy_id TEXT NOT NULL,
  instrument TEXT NOT NULL,
  state_version BIGINT NOT NULL CHECK (state_version >= 0),
  action_type TEXT NOT NULL,
  ring_tag TEXT,
  lot_id TEXT,
  tranche SMALLINT,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  requested_quantity NUMERIC(30,12) NOT NULL CHECK (requested_quantity > 0),
  status TEXT NOT NULL CHECK (status IN ('CLAIMED','SUBMITTED','PENDING','FILLED','REJECTED','CANCELED','EXPIRED','PARTIAL','FAILED')),
  broker_order_id TEXT,
  fill_price NUMERIC(30,12) CHECK (fill_price IS NULL OR fill_price > 0),
  filled_quantity NUMERIC(30,12) CHECK (filled_quantity IS NULL OR filled_quantity > 0),
  filled_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

const EXECUTION_ACTION_CONSTRAINT = `
ALTER TABLE solana_execution_orders DROP CONSTRAINT IF EXISTS solana_execution_orders_action_type_check;
ALTER TABLE solana_execution_orders ADD CONSTRAINT solana_execution_orders_action_type_check
CHECK (action_type IN ('ENTRY','EXIT','PROTECTIVE_FLAT','PROTECTIVE_CUT','HEARTBEAT_OPEN','HEARTBEAT_CLOSE','CANARY_OPEN','CANARY_CLOSE'))
`;

const TELEGRAM_NOTIFICATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS solana_telegram_notifications (
  event_key TEXT PRIMARY KEY CHECK (LENGTH(event_key) BETWEEN 1 AND 160),
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CLAIMED','SENT','FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

const TELEGRAM_KIND_CONSTRAINT = `
ALTER TABLE solana_telegram_notifications DROP CONSTRAINT IF EXISTS solana_telegram_notifications_kind_check;
ALTER TABLE solana_telegram_notifications ADD CONSTRAINT solana_telegram_notifications_kind_check
CHECK (kind IN (
  'ENTRY_CONFIRMED',
  'TRANCHE_EXIT_CONFIRMED',
  'LOT_CLOSED',
  'HEARTBEAT_CONFIRMED',
  'RECONCILIATION_MISMATCH',
  'ACCOUNT_LOCKOUT',
  'SAFETY_HALT',
  'PROTECTIVE_FLATTEN_CONFIRMED',
  'D049_PARTIAL_CUT',
  'D049_FULL_FLATTEN'
))
`;

const RISK_LADDER_SCHEMA = `
CREATE TABLE IF NOT EXISTS sol_risk_ladder_state (
  day_key TEXT PRIMARY KEY CHECK (day_key ~ '^\\d{4}-\\d{2}-\\d{2}$'),
  baseline_closed_balance_usd NUMERIC(18,6) NOT NULL CHECK (baseline_closed_balance_usd > 0),
  brake_engaged BOOLEAN NOT NULL DEFAULT FALSE,
  partial_cut_done BOOLEAN NOT NULL DEFAULT FALSE,
  flatten_done BOOLEAN NOT NULL DEFAULT FALSE,
  halted_for_day BOOLEAN NOT NULL DEFAULT FALSE,
  worst_drawdown_usd NUMERIC(18,6) NOT NULL DEFAULT 0 CHECK (worst_drawdown_usd <= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

function text(name, value, max = 128) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  const out = value.trim();
  if (out.length > max) throw new TypeError(`${name} is too long`);
  return out;
}

function positive(name, value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`${name} must be positive`);
  return n;
}

function finite(name, value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new TypeError(`${name} must be finite`);
  return n;
}

function version(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("stateVersion must be a non-negative safe integer");
  return value;
}

function dayKey(value) {
  const key = text("dayKey", value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new TypeError("dayKey is invalid");
  return key;
}

function normalizeOrder(row) {
  if (!row) return null;
  return Object.freeze({
    orderCode: String(row.order_code),
    strategyId: String(row.strategy_id),
    instrument: String(row.instrument),
    stateVersion: Number(row.state_version),
    actionType: String(row.action_type),
    ringTag: row.ring_tag == null ? null : String(row.ring_tag),
    lotId: row.lot_id == null ? null : String(row.lot_id),
    tranche: row.tranche == null ? null : Number(row.tranche),
    side: String(row.side),
    requestedQuantity: Number(row.requested_quantity),
    status: String(row.status),
    brokerOrderId: row.broker_order_id == null ? null : String(row.broker_order_id),
    fillPrice: row.fill_price == null ? null : Number(row.fill_price),
    filledQuantity: row.filled_quantity == null ? null : Number(row.filled_quantity),
    filledAt: row.filled_at == null ? null : new Date(row.filled_at).toISOString(),
    lastError: row.last_error ?? null
  });
}

function normalizeNotification(row, claimed = false) {
  if (!row) return null;
  return Object.freeze({
    eventKey: String(row.event_key),
    kind: String(row.kind),
    status: String(row.status),
    claimed
  });
}

function normalizeRiskLadder(row) {
  if (!row) return null;
  return Object.freeze({
    dayKey: String(row.day_key),
    baselineClosedBalanceUsd: Number(row.baseline_closed_balance_usd),
    brakeEngaged: row.brake_engaged === true,
    partialCutDone: row.partial_cut_done === true,
    flattenDone: row.flatten_done === true,
    haltedForDay: row.halted_for_day === true,
    worstDrawdownUsd: Number(row.worst_drawdown_usd)
  });
}

export function createSolanaPersistence(environment, { PoolClass = Pool } = {}) {
  const pool = new PoolClass({
    connectionString: environment.databaseUrl,
    ssl: environment.databaseSsl ? { rejectUnauthorized: false } : undefined,
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });
  const query = (sql, params = []) => pool.query(sql, params);
  const state = createPostgresSolanaGridStateStore({ query });

  function createStateStore(grid) {
    return createPostgresRingGridStateStore({ query, grid });
  }

  async function init() {
    await state.init();
    await query(EXECUTION_SCHEMA);
    await query(EXECUTION_ACTION_CONSTRAINT);
    await query(TELEGRAM_NOTIFICATION_SCHEMA);
    await query(TELEGRAM_KIND_CONSTRAINT);
    await query(RISK_LADDER_SCHEMA);
  }

  async function getOrder(orderCode) {
    const code = text("orderCode", orderCode, 64);
    const result = await query("SELECT * FROM solana_execution_orders WHERE order_code = $1", [code]);
    if (result.rowCount === 0) return null;
    if (result.rowCount !== 1) throw new Error("SOL execution lookup returned an invalid row count");
    return normalizeOrder(result.rows[0]);
  }

  async function claimOrder(input) {
    const code = text("orderCode", input.orderCode, 64);
    const strategyId = text("strategyId", input.strategyId, 128);
    const instrument = text("instrument", input.instrument, 64);
    const stateVersion = version(input.stateVersion);
    const actionType = text("actionType", input.actionType, 32);
    if (!["ENTRY","EXIT","PROTECTIVE_FLAT","PROTECTIVE_CUT","HEARTBEAT_OPEN","HEARTBEAT_CLOSE","CANARY_OPEN","CANARY_CLOSE"].includes(actionType)) {
      throw new TypeError("actionType is invalid");
    }
    const side = text("side", input.side, 8).toUpperCase();
    if (side !== "BUY" && side !== "SELL") throw new TypeError("side must be BUY or SELL");
    const quantity = positive("requestedQuantity", input.requestedQuantity);
    const ringTag = input.ringTag == null ? null : text("ringTag", input.ringTag, 16);
    const lotId = input.lotId == null ? null : text("lotId", input.lotId, 64);
    const tranche = input.tranche == null ? null : Number(input.tranche);
    if (tranche != null && (!Number.isInteger(tranche) || tranche < 1 || tranche > 4)) throw new TypeError("tranche is invalid");

    try {
      const result = await query(
        `INSERT INTO solana_execution_orders (
           order_code, strategy_id, instrument, state_version, action_type,
           ring_tag, lot_id, tranche, side, requested_quantity, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CLAIMED')
         RETURNING *`,
        [code, strategyId, instrument, stateVersion, actionType, ringTag, lotId, tranche, side, quantity]
      );
      return normalizeOrder(result.rows[0]);
    } catch (error) {
      if (error?.code === "23505") {
        const existing = await getOrder(code);
        if (!existing) throw error;
        return existing;
      }
      throw error;
    }
  }

  async function markSubmitted(orderCode, brokerOrderId = null) {
    const code = text("orderCode", orderCode, 64);
    const result = await query(
      `UPDATE solana_execution_orders
          SET status='SUBMITTED', broker_order_id=$2, last_error=NULL, updated_at=NOW()
        WHERE order_code=$1 AND status IN ('CLAIMED','SUBMITTED','PENDING')
        RETURNING *`,
      [code, brokerOrderId == null ? null : String(brokerOrderId)]
    );
    if (result.rowCount !== 1) throw new Error("SOL execution order could not be marked submitted");
    return normalizeOrder(result.rows[0]);
  }

  async function markStatus(orderCode, status, details = {}) {
    const code = text("orderCode", orderCode, 64);
    const next = text("status", status, 32).toUpperCase();
    if (!["CLAIMED","SUBMITTED","PENDING","FILLED","REJECTED","CANCELED","EXPIRED","PARTIAL","FAILED"].includes(next)) {
      throw new TypeError("status is invalid");
    }
    const fillPrice = details.fillPrice == null ? null : positive("fillPrice", details.fillPrice);
    const filledQuantity = details.filledQuantity == null ? null : positive("filledQuantity", details.filledQuantity);
    const filledAt = details.filledAt == null ? null : new Date(details.filledAt);
    if (filledAt && !Number.isFinite(filledAt.getTime())) throw new TypeError("filledAt is invalid");
    if (next === "FILLED" && (fillPrice == null || filledQuantity == null || filledAt == null)) {
      throw new TypeError("FILLED requires fillPrice, filledQuantity, and filledAt");
    }
    const lastError = details.lastError == null ? null : text("lastError", details.lastError, 300);
    const result = await query(
      `UPDATE solana_execution_orders
          SET status=$2,
              fill_price=COALESCE($3,fill_price),
              filled_quantity=COALESCE($4,filled_quantity),
              filled_at=COALESCE($5,filled_at),
              last_error=$6,
              updated_at=NOW()
        WHERE order_code=$1
        RETURNING *`,
      [code, next, fillPrice, filledQuantity, filledAt, lastError]
    );
    if (result.rowCount !== 1) throw new Error("SOL execution status update failed");
    return normalizeOrder(result.rows[0]);
  }

  async function getLatestFilledAt() {
    const result = await query(
      `SELECT MAX(filled_at) AS latest_filled_at
         FROM solana_execution_orders
        WHERE status = 'FILLED'`
    );
    if (result.rowCount !== 1) throw new Error("SOL latest-fill query returned an invalid row count");
    return result.rows[0].latest_filled_at == null ? null : new Date(result.rows[0].latest_filled_at).toISOString();
  }

  async function getLatestHeartbeatOpen() {
    const result = await query(
      `SELECT *
         FROM solana_execution_orders
        WHERE action_type = 'HEARTBEAT_OPEN'
        ORDER BY created_at DESC
        LIMIT 1`
    );
    if (result.rowCount === 0) return null;
    if (result.rowCount !== 1) throw new Error("SOL heartbeat lookup returned an invalid row count");
    return normalizeOrder(result.rows[0]);
  }

  async function getRiskLadderState(key) {
    const day = dayKey(key);
    const result = await query("SELECT * FROM sol_risk_ladder_state WHERE day_key=$1", [day]);
    if (result.rowCount === 0) return null;
    if (result.rowCount !== 1) throw new Error("SOL risk ladder lookup returned an invalid row count");
    return normalizeRiskLadder(result.rows[0]);
  }

  async function getLatestRiskLadderState() {
    const result = await query("SELECT * FROM sol_risk_ladder_state ORDER BY day_key DESC LIMIT 1");
    if (result.rowCount === 0) return null;
    if (result.rowCount !== 1) throw new Error("SOL latest risk ladder lookup returned an invalid row count");
    return normalizeRiskLadder(result.rows[0]);
  }

  async function saveRiskLadderState(input) {
    const day = dayKey(input.dayKey);
    const baseline = positive("baselineClosedBalanceUsd", input.baselineClosedBalanceUsd);
    const worst = Math.min(0, finite("worstDrawdownUsd", input.worstDrawdownUsd ?? 0));
    const result = await query(
      `INSERT INTO sol_risk_ladder_state (
         day_key, baseline_closed_balance_usd, brake_engaged, partial_cut_done,
         flatten_done, halted_for_day, worst_drawdown_usd, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (day_key) DO UPDATE SET
         baseline_closed_balance_usd=EXCLUDED.baseline_closed_balance_usd,
         brake_engaged=EXCLUDED.brake_engaged,
         partial_cut_done=EXCLUDED.partial_cut_done,
         flatten_done=EXCLUDED.flatten_done,
         halted_for_day=EXCLUDED.halted_for_day,
         worst_drawdown_usd=LEAST(sol_risk_ladder_state.worst_drawdown_usd, EXCLUDED.worst_drawdown_usd),
         updated_at=NOW()
       RETURNING *`,
      [
        day,
        baseline,
        input.brakeEngaged === true,
        input.partialCutDone === true,
        input.flattenDone === true,
        input.haltedForDay === true,
        worst
      ]
    );
    if (result.rowCount !== 1) throw new Error("SOL risk ladder state save failed");
    return normalizeRiskLadder(result.rows[0]);
  }

  async function claimTelegramNotification(input) {
    const eventKey = text("eventKey", input?.eventKey, 160);
    const kind = text("kind", input?.kind, 48).toUpperCase();
    const allowed = [
      "ENTRY_CONFIRMED",
      "TRANCHE_EXIT_CONFIRMED",
      "LOT_CLOSED",
      "HEARTBEAT_CONFIRMED",
      "RECONCILIATION_MISMATCH",
      "ACCOUNT_LOCKOUT",
      "SAFETY_HALT",
      "PROTECTIVE_FLATTEN_CONFIRMED",
      "D049_PARTIAL_CUT",
      "D049_FULL_FLATTEN"
    ];
    if (!allowed.includes(kind)) throw new TypeError("notification kind is invalid");

    const inserted = await query(
      `INSERT INTO solana_telegram_notifications (event_key, kind, status)
       VALUES ($1,$2,'CLAIMED')
       ON CONFLICT (event_key) DO NOTHING
       RETURNING *`,
      [eventKey, kind]
    );
    if (inserted.rowCount === 1) return normalizeNotification(inserted.rows[0], true);
    if (inserted.rowCount !== 0) throw new Error("SOL Telegram notification claim returned an invalid row count");

    const existing = await query(
      "SELECT * FROM solana_telegram_notifications WHERE event_key = $1",
      [eventKey]
    );
    if (existing.rowCount !== 1) throw new Error("SOL Telegram notification claim could not resolve existing row");
    const row = normalizeNotification(existing.rows[0], false);
    if (row.kind !== kind) throw new Error("Existing Telegram notification identity has a different kind");
    return row;
  }

  async function markTelegramNotificationSent(eventKey) {
    const key = text("eventKey", eventKey, 160);
    const result = await query(
      `UPDATE solana_telegram_notifications
          SET status='SENT', updated_at=NOW()
        WHERE event_key=$1 AND status='CLAIMED'
        RETURNING *`,
      [key]
    );
    if (result.rowCount !== 1) throw new Error("SOL Telegram notification could not be marked sent");
    return normalizeNotification(result.rows[0], false);
  }

  async function markTelegramNotificationFailed(eventKey) {
    const key = text("eventKey", eventKey, 160);
    const result = await query(
      `UPDATE solana_telegram_notifications
          SET status='FAILED', updated_at=NOW()
        WHERE event_key=$1 AND status='CLAIMED'
        RETURNING *`,
      [key]
    );
    if (result.rowCount === 0) return null;
    if (result.rowCount !== 1) throw new Error("SOL Telegram notification could not be marked failed");
    return normalizeNotification(result.rows[0], false);
  }

  async function close() {
    await pool.end();
  }

  return Object.freeze({
    init,
    state,
    createStateStore,
    getOrder,
    claimOrder,
    markSubmitted,
    markStatus,
    getLatestFilledAt,
    getLatestHeartbeatOpen,
    getRiskLadderState,
    getLatestRiskLadderState,
    saveRiskLadderState,
    claimTelegramNotification,
    markTelegramNotificationSent,
    markTelegramNotificationFailed,
    close
  });
}
