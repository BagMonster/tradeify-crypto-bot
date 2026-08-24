import pg from "pg";
import { createPostgresSolanaGridStateStore } from "./solanaGridState.js";

const { Pool } = pg;

const EXECUTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS solana_execution_orders (
  order_code TEXT PRIMARY KEY CHECK (LENGTH(order_code) BETWEEN 1 AND 64),
  strategy_id TEXT NOT NULL,
  instrument TEXT NOT NULL,
  state_version BIGINT NOT NULL CHECK (state_version >= 0),
  action_type TEXT NOT NULL CHECK (action_type IN ('ENTRY','EXIT','PROTECTIVE_FLAT','HEARTBEAT_OPEN','HEARTBEAT_CLOSE','CANARY_OPEN','CANARY_CLOSE')),
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

function version(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("stateVersion must be a non-negative safe integer");
  return value;
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

  async function init() {
    await state.init();
    await query(EXECUTION_SCHEMA);
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
    if (!["ENTRY","EXIT","PROTECTIVE_FLAT","HEARTBEAT_OPEN","HEARTBEAT_CLOSE","CANARY_OPEN","CANARY_CLOSE"].includes(actionType)) {
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

  async function close() {
    await pool.end();
  }

  return Object.freeze({ init, state, getOrder, claimOrder, markSubmitted, markStatus, close });
}
