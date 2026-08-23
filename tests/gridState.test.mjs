import test from "node:test";
import assert from "node:assert/strict";
import { createInitialGridState, applyConfirmedGridFill, evaluateGridIntent } from "../src/strategies/grid.js";
import { createPostgresGridStateStore, GridStateConflictError } from "../src/state/gridState.js";

function rowFromState(state) {
  return {
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

test("Postgres grid store initializes and loads a restart-safe state", async () => {
  let stored = null;
  const query = async (sql, params = []) => {
    if (sql.trimStart().startsWith("CREATE TABLE")) return { rowCount: 0, rows: [] };
    if (sql.startsWith("INSERT INTO grid_state")) {
      if (!stored) {
        stored = rowFromState({
          version: params[0], referencePrice: params[1], buyCount: params[2], buyPtr: params[3],
          sellCount: params[4], sellPtr: params[5], lastFillAt: params[6], lastFillSide: params[7], lastFillPrice: params[8]
        });
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
