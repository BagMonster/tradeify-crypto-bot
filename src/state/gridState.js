import { normalizeGridState } from "../strategies/grid.js";

const DEFAULT_STRATEGY_ID = "btc-progressive-reference-reset-grid-v1";
const DEFAULT_INSTRUMENT = "BTC/USD";

export class GridStateConflictError extends Error {
  constructor(message = "Grid state changed before the update could be saved") {
    super(message);
    this.name = "GridStateConflictError";
  }
}

export const GRID_STATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS grid_state (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  strategy_id TEXT NOT NULL,
  instrument TEXT NOT NULL,
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

const GRID_STATE_MIGRATION_SQL = Object.freeze([
  "ALTER TABLE grid_state ADD COLUMN IF NOT EXISTS strategy_id TEXT",
  "ALTER TABLE grid_state ADD COLUMN IF NOT EXISTS instrument TEXT",
  `UPDATE grid_state SET strategy_id = '${DEFAULT_STRATEGY_ID}' WHERE strategy_id IS NULL`,
  `UPDATE grid_state SET instrument = '${DEFAULT_INSTRUMENT}' WHERE instrument IS NULL`,
  "ALTER TABLE grid_state ALTER COLUMN strategy_id SET NOT NULL",
  "ALTER TABLE grid_state ALTER COLUMN instrument SET NOT NULL"
]);

function requireQuery(query) {
  if (typeof query !== "function") throw new TypeError("query must be a function");
  return query;
}

function requiredText(name, value, maxLength = 128) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  const text = value.trim();
  if (text.length > maxLength) throw new TypeError(`${name} is too long`);
  return text;
}

function instrumentSymbol(value) {
  const instrument = requiredText("grid instrument", value, 64);
  if (!/^[A-Z0-9]+\/[A-Z0-9]+$/.test(instrument)) throw new TypeError("grid instrument must look like BASE/QUOTE");
  return instrument;
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

export function createPostgresGridStateStore({
  query,
  strategyId = DEFAULT_STRATEGY_ID,
  instrument = DEFAULT_INSTRUMENT
}) {
  const run = requireQuery(query);
  let activeStrategyId = requiredText("grid strategyId", strategyId, 128);
  let activeInstrument = instrumentSymbol(instrument);

  async function init() {
    await run(GRID_STATE_SCHEMA_SQL);
    for (const statement of GRID_STATE_MIGRATION_SQL) await run(statement);
  }

  function setIdentity({ strategyId: nextStrategyId, instrument: nextInstrument }) {
    activeStrategyId = requiredText("grid strategyId", nextStrategyId, 128);
    activeInstrument = instrumentSymbol(nextInstrument);
    return getIdentity();
  }

  async function load() {
    const result = await run("SELECT * FROM grid_state WHERE id = 1");
    if (!result || !Number.isInteger(result.rowCount)) {
      throw new Error("grid state query returned an invalid result");
    }
    if (result.rowCount === 0) return null;
    if (result.rowCount !== 1) throw new Error("grid_state must contain at most one active row");
    const row = result.rows[0];
    const storedStrategy = row.strategy_id == null ? DEFAULT_STRATEGY_ID : String(row.strategy_id);
    const storedInstrument = row.instrument == null ? DEFAULT_INSTRUMENT : String(row.instrument);
    if (storedStrategy !== activeStrategyId || storedInstrument !== activeInstrument) return null;
    return stateFromRow(row);
  }

  async function initializeIfMissing(state) {
    const params = stateParameters(state);
    await run(
      `INSERT INTO grid_state (
         id, strategy_id, instrument, state_version, reference_price, buy_count, buy_ptr,
         sell_count, sell_ptr, last_fill_at, last_fill_side, last_fill_price
       ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE
         SET strategy_id = EXCLUDED.strategy_id,
             instrument = EXCLUDED.instrument,
             state_version = EXCLUDED.state_version,
             reference_price = EXCLUDED.reference_price,
             buy_count = EXCLUDED.buy_count,
             buy_ptr = EXCLUDED.buy_ptr,
             sell_count = EXCLUDED.sell_count,
             sell_ptr = EXCLUDED.sell_ptr,
             last_fill_at = EXCLUDED.last_fill_at,
             last_fill_side = EXCLUDED.last_fill_side,
             last_fill_price = EXCLUDED.last_fill_price,
             updated_at = NOW()
       WHERE grid_state.strategy_id <> EXCLUDED.strategy_id
          OR grid_state.instrument <> EXCLUDED.instrument`,
      [activeStrategyId, activeInstrument, ...params]
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
        WHERE id = 1 AND strategy_id = $10 AND instrument = $11 AND state_version = $12
        RETURNING *`,
      [...params, activeStrategyId, activeInstrument, expectedVersion]
    );
    if (result?.rowCount !== 1) throw new GridStateConflictError();
    return stateFromRow(result.rows[0]);
  }

  async function clearForStrategyTransition() {
    const result = await run("DELETE FROM grid_state WHERE id = 1");
    if (!result || !Number.isInteger(result.rowCount) || result.rowCount > 1) {
      throw new Error("grid state transition reset returned an invalid result");
    }
    return result.rowCount === 1;
  }

  function getIdentity() {
    return Object.freeze({ strategyId: activeStrategyId, instrument: activeInstrument });
  }

  return Object.freeze({ init, setIdentity, load, initializeIfMissing, save, clearForStrategyTransition, getIdentity });
}
