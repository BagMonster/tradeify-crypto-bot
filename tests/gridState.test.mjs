import test from "node:test";
import assert from "node:assert/strict";
import { createInitialGridState, applyConfirmedGridFill, evaluateGridIntent } from "../src/strategies/grid.js";
import { createPostgresGridStateStore, GridStateConflictError } from "../src/state/gridState.js";

function rowFromState(state, strategyId = "btc-progressive-reference-reset-grid-v1", instrument = "BTC/USD") {
  return {
    strategy_id: strategyId,
    instrument,
    state_version: String(state.version),
    reference_price: String(state.referencePrice),
    buy_count: state.buyCount,
    buy_ptr: state.buyPtr,
    sell_count: state.sellCount,
    sell_ptr: state.sellPtr,
    last_fill_at: state.lastFillAt,
    last_fill_side: state.lastFillSide,
    last_fill_price: state.lastFillPrice == null ? null : String(state.lastFillPrice)
  };
}

function migrationQuery(sql) {
  return sql.startsWith("ALTER TABLE") || sql.startsWith("UPDATE grid_state SET strategy_id") ||
    sql.startsWith("UPDATE grid_state SET instrument");
}

test("Postgres grid store initializes and loads a restart-safe state", async () => {
  let stored = null;
  const query = async (sql, params = []) => {
    if (sql.trimStart().startsWith("CREATE TABLE") || migrationQuery(sql)) return { rowCount: 0, rows: [] };
    if (sql.startsWith("INSERT INTO grid_state")) {
      if (!stored) {
        stored = rowFromState({
          version: params[2], referencePrice: params[3], buyCount: params[4], buyPtr: params[5],
          sellCount: params[6], sellPtr: params[7], lastFillAt: params[8], lastFillSide: params[9], lastFillPrice: params[10]
        }, params[0], params[1]);
      }
      return { rowCount: 1, rows: [] };
    }
    if (sql === "SELECT * FROM grid_state WHERE id = 1") {
      return { rowCount: stored ? 1 : 0, rows: stored ? [stored] : [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };

  const store = createPostgresGridStateStore({ query });
  await store.init();
  const state = await store.initializeIfMissing(createInitialGridState(70_000));
  assert.equal(state.referencePrice, 70_000);
  assert.equal(state.version, 0);
  assert.deepEqual(await store.load(), state);
});

test("a SOL strategy does not load a persisted BTC reference", async () => {
  const btcRow = rowFromState(createInitialGridState(70_000));
  const store = createPostgresGridStateStore({
    strategyId: "sol-statistical-grid-v1",
    instrument: "SOL/USD",
    query: async (sql) => {
      if (sql === "SELECT * FROM grid_state WHERE id = 1") return { rowCount: 1, rows: [btcRow] };
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  });
  assert.equal(await store.load(), null);
  assert.deepEqual(store.getIdentity(), { strategyId: "sol-statistical-grid-v1", instrument: "SOL/USD" });
});

test("Postgres grid store uses optimistic versioning to reject stale writers", async () => {
  const state = createInitialGridState(100);
  const intent = evaluateGridIntent(state, 96);
  const next = applyConfirmedGridFill(state, intent, { fillPrice: 95.9, filledAt: "2026-08-23T01:00:00.000Z" });
  const query = async (sql) => {
    if (sql.startsWith("UPDATE grid_state")) return { rowCount: 0, rows: [] };
    throw new Error("unexpected query");
  };
  const store = createPostgresGridStateStore({ query });
  await assert.rejects(store.save(0, next), GridStateConflictError);
});

test("grid transition reset explicitly removes the old asset reference", async () => {
  let deleted = false;
  const store = createPostgresGridStateStore({
    query: async (sql) => {
      if (sql === "DELETE FROM grid_state WHERE id = 1") {
        deleted = true;
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  });
  assert.equal(await store.clearForStrategyTransition(), true);
  assert.equal(deleted, true);
});
