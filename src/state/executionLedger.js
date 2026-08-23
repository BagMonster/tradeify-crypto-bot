const DEFAULT_INSTRUMENT = "BTC/USD";
const FINAL_STATUSES = new Set(["FILLED", "REJECTED", "CANCELED", "EXPIRED", "PARTIAL", "FAILED"]);
const ALL_STATUSES = new Set(["CLAIMED", "SUBMITTED", "PENDING", ...FINAL_STATUSES]);

export class ExecutionOrderConflictError extends Error {
  constructor(message = "Execution order already exists for this strategy, instrument, state, and level") {
    super(message);
    this.name = "ExecutionOrderConflictError";
  }
}

export const EXECUTION_LEDGER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS execution_orders (
  client_order_id TEXT PRIMARY KEY CHECK (LENGTH(client_order_id) BETWEEN 1 AND 64),
  strategy_id TEXT NOT NULL,
  instrument TEXT NOT NULL,
  state_version BIGINT NOT NULL CHECK (state_version >= 0),
  grid_tag TEXT NOT NULL CHECK (grid_tag ~ '^(BUY|SELL)[1-9][0-9]*$'),
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  requested_cash_quantity NUMERIC(30,12) NOT NULL CHECK (requested_cash_quantity > 0),
  status TEXT NOT NULL CHECK (status IN ('CLAIMED','SUBMITTED','PENDING','FILLED','REJECTED','CANCELED','EXPIRED','PARTIAL','FAILED')),
  broker_order_id TEXT,
  broker_update_order_id TEXT,
  fill_price NUMERIC(30,12) CHECK (fill_price IS NULL OR fill_price > 0),
  filled_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT execution_orders_strategy_instrument_state_tag_key
    UNIQUE (strategy_id, instrument, state_version, grid_tag),
  CHECK (
    (status = 'FILLED' AND fill_price IS NOT NULL AND filled_at IS NOT NULL)
    OR status <> 'FILLED'
  )
)`;

const EXECUTION_LEDGER_MIGRATION_SQL = Object.freeze([
  "ALTER TABLE execution_orders ADD COLUMN IF NOT EXISTS instrument TEXT",
  `UPDATE execution_orders SET instrument = '${DEFAULT_INSTRUMENT}' WHERE instrument IS NULL`,
  "ALTER TABLE execution_orders ALTER COLUMN instrument SET NOT NULL",
  "ALTER TABLE execution_orders DROP CONSTRAINT IF EXISTS execution_orders_state_version_grid_tag_key",
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = 'execution_orders_strategy_instrument_state_tag_key'
          AND conrelid = 'execution_orders'::regclass
     ) THEN
       ALTER TABLE execution_orders
         ADD CONSTRAINT execution_orders_strategy_instrument_state_tag_key
         UNIQUE (strategy_id, instrument, state_version, grid_tag);
     END IF;
   END $$`
]);

function requireQuery(query) {
  if (typeof query !== "function") throw new TypeError("query must be a function");
  return query;
}

function requiredText(name, value, maxLength = 128) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  const text = value.trim();
  if (text.length > maxLength) throw new TypeError(`${name} is too long`);
  return text;
}

function instrumentSymbol(value) {
  const instrument = requiredText("instrument", value, 64);
  if (!/^[A-Z0-9]+\/[A-Z0-9]+$/.test(instrument)) throw new TypeError("instrument must look like BASE/QUOTE");
  return instrument;
}

function positive(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return value;
}

function nonNegativeInteger(name, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function status(value) {
  const normalized = requiredText("execution status", value, 32).toUpperCase();
  if (!ALL_STATUSES.has(normalized)) throw new TypeError("execution status is invalid");
  return normalized;
}

function canonicalTime(name, value) {
  if (value == null) return null;
  const text = requiredText(name, value, 40);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new TypeError(`${name} must be a valid timestamp`);
  return new Date(ms).toISOString();
}

function normalizeRow(row) {
  if (!row) return null;
  return Object.freeze({
    clientOrderId: String(row.client_order_id),
    strategyId: String(row.strategy_id),
    instrument: row.instrument == null ? DEFAULT_INSTRUMENT : String(row.instrument),
    stateVersion: Number(row.state_version),
    gridTag: String(row.grid_tag),
    side: String(row.side),
    requestedCashQuantity: Number(row.requested_cash_quantity),
    status: String(row.status),
    brokerOrderId: row.broker_order_id == null ? null : String(row.broker_order_id),
    brokerUpdateOrderId: row.broker_update_order_id == null ? null : String(row.broker_update_order_id),
    fillPrice: row.fill_price == null ? null : Number(row.fill_price),
    filledAt: row.filled_at == null ? null : new Date(row.filled_at).toISOString(),
    lastError: row.last_error ?? null,
    createdAt: row.created_at == null ? null : new Date(row.created_at).toISOString(),
    submittedAt: row.submitted_at == null ? null : new Date(row.submitted_at).toISOString(),
    lastCheckedAt: row.last_checked_at == null ? null : new Date(row.last_checked_at).toISOString(),
    updatedAt: row.updated_at == null ? null : new Date(row.updated_at).toISOString()
  });
}

export function createExecutionLedger({ query }) {
  const run = requireQuery(query);

  async function init() {
    await run(EXECUTION_LEDGER_SCHEMA_SQL);
    for (const statement of EXECUTION_LEDGER_MIGRATION_SQL) await run(statement);
  }

  async function get(clientOrderId) {
    const id = requiredText("clientOrderId", clientOrderId, 64);
    const result = await run("SELECT * FROM execution_orders WHERE client_order_id = $1", [id]);
    if (result?.rowCount === 0) return null;
    if (result?.rowCount !== 1) throw new Error("execution order lookup returned an invalid row count");
    return normalizeRow(result.rows[0]);
  }

  async function claim({
    clientOrderId,
    strategyId,
    instrument = DEFAULT_INSTRUMENT,
    stateVersion,
    gridTag,
    side,
    requestedCashQuantity
  }) {
    const id = requiredText("clientOrderId", clientOrderId, 64);
    const strategy = requiredText("strategyId", strategyId, 128);
    const activeInstrument = instrumentSymbol(instrument);
    const version = nonNegativeInteger("stateVersion", stateVersion);
    const tag = requiredText("gridTag", gridTag, 16);
    if (!/^(BUY|SELL)[1-9][0-9]*$/.test(tag)) throw new TypeError("gridTag is invalid");
    const normalizedSide = requiredText("side", side, 8).toUpperCase();
    if (normalizedSide !== "BUY" && normalizedSide !== "SELL") throw new TypeError("side must be BUY or SELL");
    const cash = positive("requestedCashQuantity", requestedCashQuantity);

    try {
      const result = await run(
        `INSERT INTO execution_orders (
           client_order_id, strategy_id, instrument, state_version, grid_tag, side,
           requested_cash_quantity, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'CLAIMED')
         RETURNING *`,
        [id, strategy, activeInstrument, version, tag, normalizedSide, cash]
      );
      if (result?.rowCount !== 1) throw new Error("execution order claim did not return one row");
      return normalizeRow(result.rows[0]);
    } catch (error) {
      if (error?.code === "23505") throw new ExecutionOrderConflictError();
      throw error;
    }
  }

  async function markSubmitted(clientOrderId, { brokerOrderId = null, brokerUpdateOrderId = null } = {}) {
    const id = requiredText("clientOrderId", clientOrderId, 64);
    const result = await run(
      `UPDATE execution_orders
          SET status = 'SUBMITTED', broker_order_id = $2, broker_update_order_id = $3,
              submitted_at = COALESCE(submitted_at, NOW()), last_checked_at = NOW(),
              last_error = NULL, updated_at = NOW()
        WHERE client_order_id = $1 AND status IN ('CLAIMED','SUBMITTED','PENDING')
        RETURNING *`,
      [id, brokerOrderId == null ? null : String(brokerOrderId), brokerUpdateOrderId == null ? null : String(brokerUpdateOrderId)]
    );
    if (result?.rowCount !== 1) throw new Error("execution order could not be marked submitted");
    return normalizeRow(result.rows[0]);
  }

  async function markStatus(clientOrderId, nextStatus, details = {}) {
    const id = requiredText("clientOrderId", clientOrderId, 64);
    const next = status(nextStatus);
    const fillPrice = details.fillPrice == null ? null : positive("fillPrice", details.fillPrice);
    const filledAt = canonicalTime("filledAt", details.filledAt ?? null);
    if (next === "FILLED" && (fillPrice == null || filledAt == null)) {
      throw new TypeError("FILLED status requires fillPrice and filledAt");
    }
    const lastError = details.lastError == null ? null : requiredText("lastError", details.lastError, 300);
    const result = await run(
      `UPDATE execution_orders
          SET status = $2,
              fill_price = COALESCE($3, fill_price),
              filled_at = COALESCE($4, filled_at),
              last_error = $5,
              last_checked_at = NOW(),
              updated_at = NOW()
        WHERE client_order_id = $1
        RETURNING *`,
      [id, next, fillPrice, filledAt, lastError]
    );
    if (result?.rowCount !== 1) throw new Error("execution order status update failed");
    return normalizeRow(result.rows[0]);
  }

  async function listUnresolved(limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new TypeError("limit must be an integer from 1 to 500");
    const result = await run(
      `SELECT * FROM execution_orders
        WHERE status NOT IN ('FILLED','REJECTED','CANCELED','EXPIRED','PARTIAL','FAILED')
        ORDER BY created_at ASC
        LIMIT $1`,
      [limit]
    );
    if (!Array.isArray(result?.rows)) throw new Error("execution order list returned an invalid result");
    return Object.freeze(result.rows.map(normalizeRow));
  }

  return Object.freeze({ init, get, claim, markSubmitted, markStatus, listUnresolved, finalStatuses: FINAL_STATUSES });
}
