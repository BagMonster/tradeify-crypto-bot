const FINAL_STATUSES = new Set(["FILLED", "REJECTED", "CANCELED", "EXPIRED", "PARTIAL", "FAILED"]);
const ALL_STATUSES = new Set(["CLAIMED", "SUBMITTED", "PENDING", ...FINAL_STATUSES]);

export const PROTECTIVE_LEDGER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS protective_orders (
  client_order_id TEXT PRIMARY KEY CHECK (LENGTH(client_order_id) BETWEEN 1 AND 64),
  state_version BIGINT NOT NULL UNIQUE CHECK (state_version >= 0),
  position_code TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  requested_quantity NUMERIC(30,12) NOT NULL CHECK (requested_quantity > 0),
  reason TEXT NOT NULL,
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
  CHECK ((status = 'FILLED' AND fill_price IS NOT NULL AND filled_at IS NOT NULL) OR status <> 'FILLED')
)`;

function requireQuery(query) {
  if (typeof query !== "function") throw new TypeError("query must be a function");
  return query;
}

function text(name, value, maxLength = 300) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new TypeError(`${name} is too long`);
  return normalized;
}

function positive(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  return value;
}

function version(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("stateVersion must be a non-negative safe integer");
  return value;
}

function normalizedStatus(value) {
  const status = text("status", value, 32).toUpperCase();
  if (!ALL_STATUSES.has(status)) throw new TypeError("protective status is invalid");
  return status;
}

function time(value) {
  if (value == null) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError("filledAt must be a valid timestamp");
  return new Date(parsed).toISOString();
}

function rowToRecord(row) {
  if (!row) return null;
  return Object.freeze({
    clientOrderId: String(row.client_order_id),
    stateVersion: Number(row.state_version),
    positionCode: String(row.position_code),
    side: String(row.side),
    requestedQuantity: Number(row.requested_quantity),
    reason: String(row.reason),
    status: String(row.status),
    brokerOrderId: row.broker_order_id == null ? null : String(row.broker_order_id),
    brokerUpdateOrderId: row.broker_update_order_id == null ? null : String(row.broker_update_order_id),
    fillPrice: row.fill_price == null ? null : Number(row.fill_price),
    filledAt: row.filled_at == null ? null : new Date(row.filled_at).toISOString(),
    lastError: row.last_error ?? null
  });
}

export function createProtectiveLedger({ query }) {
  const run = requireQuery(query);

  async function init() {
    await run(PROTECTIVE_LEDGER_SCHEMA_SQL);
  }

  async function get(clientOrderId) {
    const id = text("clientOrderId", clientOrderId, 64);
    const result = await run("SELECT * FROM protective_orders WHERE client_order_id = $1", [id]);
    if (result?.rowCount === 0) return null;
    if (result?.rowCount !== 1) throw new Error("protective order lookup returned an invalid row count");
    return rowToRecord(result.rows[0]);
  }

  async function claim({ clientOrderId, stateVersion, positionCode, side, requestedQuantity, reason }) {
    const id = text("clientOrderId", clientOrderId, 64);
    const v = version(stateVersion);
    const code = text("positionCode", positionCode, 128);
    const normalizedSide = text("side", side, 8).toUpperCase();
    if (normalizedSide !== "BUY" && normalizedSide !== "SELL") throw new TypeError("side must be BUY or SELL");
    const quantity = positive("requestedQuantity", requestedQuantity);
    const why = text("reason", reason, 300);
    try {
      const result = await run(
        `INSERT INTO protective_orders (
           client_order_id, state_version, position_code, side, requested_quantity, reason, status
         ) VALUES ($1,$2,$3,$4,$5,$6,'CLAIMED') RETURNING *`,
        [id, v, code, normalizedSide, quantity, why]
      );
      if (result?.rowCount !== 1) throw new Error("protective order claim did not return one row");
      return rowToRecord(result.rows[0]);
    } catch (error) {
      if (error?.code === "23505") throw new Error("protective order already exists for this grid state");
      throw error;
    }
  }

  async function markSubmitted(clientOrderId, details = {}) {
    const id = text("clientOrderId", clientOrderId, 64);
    const result = await run(
      `UPDATE protective_orders
          SET status='SUBMITTED', broker_order_id=$2, broker_update_order_id=$3,
              submitted_at=COALESCE(submitted_at,NOW()), last_checked_at=NOW(),
              last_error=NULL, updated_at=NOW()
        WHERE client_order_id=$1 AND status IN ('CLAIMED','SUBMITTED','PENDING') RETURNING *`,
      [id, details.brokerOrderId == null ? null : String(details.brokerOrderId), details.brokerUpdateOrderId == null ? null : String(details.brokerUpdateOrderId)]
    );
    if (result?.rowCount !== 1) throw new Error("protective order could not be marked submitted");
    return rowToRecord(result.rows[0]);
  }

  async function markStatus(clientOrderId, nextStatus, details = {}) {
    const id = text("clientOrderId", clientOrderId, 64);
    const next = normalizedStatus(nextStatus);
    const fillPrice = details.fillPrice == null ? null : positive("fillPrice", details.fillPrice);
    const filledAt = time(details.filledAt ?? null);
    if (next === "FILLED" && (fillPrice == null || filledAt == null)) {
      throw new TypeError("FILLED protective order requires fillPrice and filledAt");
    }
    const lastError = details.lastError == null ? null : text("lastError", details.lastError, 300);
    const result = await run(
      `UPDATE protective_orders
          SET status=$2, fill_price=COALESCE($3,fill_price), filled_at=COALESCE($4,filled_at),
              last_error=$5, last_checked_at=NOW(), updated_at=NOW()
        WHERE client_order_id=$1 RETURNING *`,
      [id, next, fillPrice, filledAt, lastError]
    );
    if (result?.rowCount !== 1) throw new Error("protective order status update failed");
    return rowToRecord(result.rows[0]);
  }

  return Object.freeze({ init, get, claim, markSubmitted, markStatus, finalStatuses: FINAL_STATUSES });
}
