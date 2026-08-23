import { normalizeGridState } from "../strategies/grid.js";

export class GridStateConflictError extends Error {
  constructor(message = "Grid state changed before the update could be saved") {
    super(message);
    this.name = "GridStateConflictError";
  }
}

export const GRID_STATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS grid_state (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  state_version BIGINT NOT NULL CHECK (state_version >= 0),
  reference_price NUMERIC(30,12) NOT NULL CHECK (reference_price > 0),
  buy_count SMALLINT NOT NULL CHECK (buy_count BETWEEN 0 AND 3),
  buy_ptr SMALLINT NOT NULL CHECK (buy_ptr BETWEEN 0 AND 3),
  sell_count SMALLINT NOT NULL CHECK (sell_count BETWEEN 0 AND 3),
  sell_ptr SMALLINT NOT NULL CHECK (sell_ptr BETWEEN 0 AND 3),
  last_fill_at TIMESTAMPTZ,
  last_fill_side TEXT CHECK (last_fill_side IS NULL OR last_fill_side IN ('BUY','SELL','PROTECTIVE_FLAT')),
  last_fill_price NUMERIC(30,12) CHECK (last_fill_price IS NULL OR last_fill_price > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (buy_count = buy_ptr),
  CHECK (sell_count = sell_ptr),
  CHECK (
    (last_fill_at IS NULL AND last_fill_side IS NULL AND last_fill_price IS NULL)
    OR
    (last_fill_at IS NOT NULL AND last_fill_side IS NOT NULL AND last_fill_price IS NOT NULL)
  )
)`;

function requireQuery(query) {
  if (typeof query !== "function") throw new TypeError("query must be a function");
  return query;
}

function stateFromRow(row) {
  if (!row) return null;
  return normalizeGridState({
    version: Number(row.state_version),
    referencePrice: Number(row.reference_price),
    buyCount: Number(row.buy_count),
    buyPtr: Number(row.buy_ptr),
    sellCount: Number(row.sell_count),
    sellPtr: Number(row.sell_ptr),
    lastFillAt: row.last_fill_at == null ? null : new Date(row.last_fill_at).toISOString(),
    lastFillSide: row.last_fill_side ?? null,
    lastFillPrice: row.last_fill_price == null ? null : Number(row.last_fill_price)
  });
}

function stateParameters(state) {
  const normalized = normalizeGridState(state);
  return [
    normalized.version,
    normalized.referencePrice,
    normalized.buyCount,
    normalized.buyPtr,
    normalized.sellCount,
    normalized.sellPtr,
    normalized.lastFillAt,
    normalized.lastFillSide,
    normalized.lastFillPrice
  ];
}

export function createPostgresGridStateStore({ query }) {
  const run = requireQuery(query);

  async function init() {
    await run(GRID_STATE_SCHEMA_SQL);
  }

  async function load() {
    const result = await run("SELECT * FROM grid_state WHERE id = 1");
    if (!result || !Number.isInteger(result.rowCount)) {
      throw new Error("grid state query returned an invalid result");
    }
    if (result.rowCount === 0) return null;
    if (result.rowCount !== 1) throw new Error("grid_state must contain at most one active row");
    return stateFromRow(result.rows[0]);
  }

  async function initializeIfMissing(state) {
    const params = stateParameters(state);
    await run(
      `INSERT INTO grid_state (
         id, state_version, reference_price, buy_count, buy_ptr,
         sell_count, sell_ptr, last_fill_at, last_fill_side, last_fill_price
       ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      params
    );
    const stored = await load();
    if (!stored) throw new Error("grid state initialization failed");
    return stored;
  }

  async function save(expectedVersion, nextState) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new TypeError("expectedVersion must be a non-negative safe integer");
    }
    const normalized = normalizeGridState(nextState);
    if (normalized.version !== expectedVersion + 1) {
      throw new Error("next grid state version must increment exactly once");
    }
    const params = stateParameters(normalized);
    const result = await run(
      `UPDATE grid_state
          SET state_version = $1,
              reference_price = $2,
              buy_count = $3,
              buy_ptr = $4,
              sell_count = $5,
              sell_ptr = $6,
              last_fill_at = $7,
              last_fill_side = $8,
              last_fill_price = $9,
              updated_at = NOW()
        WHERE id = 1 AND state_version = $10
        RETURNING *`,
      [...params, expectedVersion]
    );
    if (result?.rowCount !== 1) throw new GridStateConflictError();
    return stateFromRow(result.rows[0]);
  }

  return Object.freeze({ init, load, initializeIfMissing, save });
}
