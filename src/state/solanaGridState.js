import { normalizeSolanaState } from "../strategies/solanaGrid.js";

export class SolanaGridStateConflictError extends Error {
  constructor(message = "SOL grid state changed before the update could be saved") {
    super(message);
    this.name = "SolanaGridStateConflictError";
  }
}

export const SOLANA_GRID_STATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS solana_grid_state (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  strategy_id TEXT NOT NULL,
  instrument TEXT NOT NULL,
  state_version BIGINT NOT NULL CHECK (state_version >= 0),
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

function requireQuery(query) {
  if (typeof query !== "function") throw new TypeError("query must be a function");
  return query;
}

export function createPostgresSolanaGridStateStore({ query }) {
  const run = requireQuery(query);

  async function init() {
    await run(SOLANA_GRID_STATE_SCHEMA_SQL);
  }

  async function load() {
    const result = await run("SELECT strategy_id, instrument, state_version, payload FROM solana_grid_state WHERE id = 1");
    if (!result || !Number.isInteger(result.rowCount)) throw new Error("SOL grid state query returned an invalid result");
    if (result.rowCount === 0) return null;
    if (result.rowCount !== 1) throw new Error("solana_grid_state must contain at most one row");
    const row = result.rows[0];
    const state = normalizeSolanaState(row.payload);
    if (String(row.strategy_id) !== state.strategyId || String(row.instrument) !== state.instrument) {
      throw new Error("SOL grid state database identity does not match payload identity");
    }
    if (Number(row.state_version) !== state.version) throw new Error("SOL grid state version does not match payload version");
    return state;
  }

  async function initializeIfMissing(state) {
    const normalized = normalizeSolanaState(state);
    await run(
      `INSERT INTO solana_grid_state (id, strategy_id, instrument, state_version, payload)
       VALUES (1, $1, $2, $3, $4::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [normalized.strategyId, normalized.instrument, normalized.version, JSON.stringify(normalized)]
    );
    const stored = await load();
    if (!stored) throw new Error("SOL grid state initialization failed");
    if (stored.strategyId !== normalized.strategyId || stored.instrument !== normalized.instrument) {
      throw new Error("Existing SOL grid state belongs to a different strategy or instrument");
    }
    return stored;
  }

  async function save(expectedVersion, nextState) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new TypeError("expectedVersion must be a non-negative safe integer");
    }
    const normalized = normalizeSolanaState(nextState);
    if (normalized.version !== expectedVersion + 1) throw new Error("next SOL grid state version must increment exactly once");
    const result = await run(
      `UPDATE solana_grid_state
          SET state_version = $1,
              payload = $2::jsonb,
              updated_at = NOW()
        WHERE id = 1
          AND strategy_id = $3
          AND instrument = $4
          AND state_version = $5
        RETURNING strategy_id, instrument, state_version, payload`,
      [normalized.version, JSON.stringify(normalized), normalized.strategyId, normalized.instrument, expectedVersion]
    );
    if (result?.rowCount !== 1) throw new SolanaGridStateConflictError();
    return normalizeSolanaState(result.rows[0].payload);
  }

  async function clear() {
    const result = await run("DELETE FROM solana_grid_state WHERE id = 1");
    if (!result || !Number.isInteger(result.rowCount) || result.rowCount > 1) {
      throw new Error("SOL grid state clear returned an invalid result");
    }
    return result.rowCount === 1;
  }

  return Object.freeze({ init, load, initializeIfMissing, save, clear });
}
