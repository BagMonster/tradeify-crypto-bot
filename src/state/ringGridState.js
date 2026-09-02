export class RingGridStateConflictError extends Error {
  constructor(message = "Ring-grid state changed before the update could be saved") {
    super(message);
    this.name = "RingGridStateConflictError";
  }
}

export const RING_GRID_STATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ring_grid_state (
  strategy_id TEXT NOT NULL,
  instrument TEXT NOT NULL,
  state_version BIGINT NOT NULL CHECK (state_version >= 0),
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (strategy_id, instrument)
)`;

// This is additive and therefore reversible: the D-049 source row is retained in
// solana_grid_state and copied verbatim under the same logical identity. The new
// table can be dropped to roll back without destroying the original state.
export const COPY_LEGACY_SOL_STATE_SQL = `
INSERT INTO ring_grid_state (strategy_id, instrument, state_version, payload, updated_at)
SELECT strategy_id, instrument, state_version, payload, updated_at
  FROM solana_grid_state
 WHERE strategy_id = 'sol-outer-heavy-v1' AND instrument = 'SOL/USD'
ON CONFLICT (strategy_id, instrument) DO NOTHING`;

function requireText(name, value) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

export function createPostgresRingGridStateStore({ query, grid }) {
  if (typeof query !== "function") throw new TypeError("query must be a function");
  if (!grid || typeof grid.normalizeState !== "function" || !grid.definition) throw new TypeError("grid must be a ring-grid instance");
  const strategyId = requireText("grid strategyId", grid.definition.strategyId);
  const instrument = requireText("grid instrument", grid.definition.instrument);

  async function init() {
    await query(RING_GRID_STATE_SCHEMA_SQL);
    await query(COPY_LEGACY_SOL_STATE_SQL);
  }

  async function load() {
    const result = await query(
      "SELECT strategy_id, instrument, state_version, payload FROM ring_grid_state WHERE strategy_id = $1 AND instrument = $2",
      [strategyId, instrument]
    );
    if (!result || !Number.isInteger(result.rowCount)) throw new Error("ring-grid state query returned an invalid result");
    if (result.rowCount === 0) return null;
    if (result.rowCount !== 1) throw new Error("ring-grid state identity is not unique");
    const row = result.rows[0];
    const state = grid.normalizeState(row.payload);
    if (row.strategy_id !== strategyId || row.instrument !== instrument || Number(row.state_version) !== state.version) {
      throw new Error("ring-grid state database identity does not match payload identity");
    }
    return state;
  }

  async function initializeIfMissing(input) {
    const state = grid.normalizeState(input);
    await query(
      `INSERT INTO ring_grid_state (strategy_id, instrument, state_version, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (strategy_id, instrument) DO NOTHING`,
      [strategyId, instrument, state.version, JSON.stringify(state)]
    );
    const stored = await load();
    if (!stored) throw new Error("ring-grid state initialization failed");
    return stored;
  }

  async function save(expectedVersion, input) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new TypeError("expectedVersion must be a non-negative safe integer");
    const state = grid.normalizeState(input);
    if (state.version !== expectedVersion + 1) throw new Error("ring-grid state version must increment exactly once");
    const result = await query(
      `UPDATE ring_grid_state
          SET state_version = $1, payload = $2::jsonb, updated_at = NOW()
        WHERE strategy_id = $3 AND instrument = $4 AND state_version = $5
        RETURNING strategy_id, instrument, state_version, payload`,
      [state.version, JSON.stringify(state), strategyId, instrument, expectedVersion]
    );
    if (result?.rowCount !== 1) throw new RingGridStateConflictError();
    return grid.normalizeState(result.rows[0].payload);
  }

  async function clear() {
    const result = await query("DELETE FROM ring_grid_state WHERE strategy_id = $1 AND instrument = $2", [strategyId, instrument]);
    if (!result || !Number.isInteger(result.rowCount) || result.rowCount > 1) throw new Error("ring-grid state delete returned an invalid result");
    return result.rowCount === 1;
  }

  return Object.freeze({ init, load, initializeIfMissing, save, clear, getIdentity: () => Object.freeze({ strategyId, instrument }) });
}
