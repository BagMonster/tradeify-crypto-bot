import test from "node:test";
import assert from "node:assert/strict";
import {
  ExecutionOrderConflictError,
  createExecutionLedger
} from "../src/state/executionLedger.js";

function createFakeQuery() {
  const rows = new Map();
  return async function query(sql, params = []) {
    if (sql.includes("CREATE TABLE")) return { rowCount: 0, rows: [] };

    if (sql.startsWith("SELECT * FROM execution_orders WHERE client_order_id")) {
      const row = rows.get(params[0]);
      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    }

    if (sql.startsWith("INSERT INTO execution_orders")) {
      const [clientOrderId, strategyId, stateVersion, gridTag, side, requestedCashQuantity] = params;
      for (const row of rows.values()) {
        if (row.client_order_id === clientOrderId ||
            (Number(row.state_version) === stateVersion && row.grid_tag === gridTag)) {
          const error = new Error("duplicate key");
          error.code = "23505";
          throw error;
        }
      }
      const now = new Date("2026-08-23T09:00:00.000Z");
      const row = {
        client_order_id: clientOrderId,
        strategy_id: strategyId,
        state_version: stateVersion,
        grid_tag: gridTag,
        side,
        requested_cash_quantity: requestedCashQuantity,
        status: "CLAIMED",
        broker_order_id: null,
        broker_update_order_id: null,
        fill_price: null,
        filled_at: null,
        last_error: null,
        created_at: now,
        submitted_at: null,
        last_checked_at: null,
        updated_at: now
      };
      rows.set(clientOrderId, row);
      return { rowCount: 1, rows: [row] };
    }

    if (sql.includes("SET status = 'SUBMITTED'")) {
      const [clientOrderId, brokerOrderId, brokerUpdateOrderId] = params;
      const row = rows.get(clientOrderId);
      if (!row || !["CLAIMED", "SUBMITTED", "PENDING"].includes(row.status)) return { rowCount: 0, rows: [] };
      Object.assign(row, {
        status: "SUBMITTED",
        broker_order_id: brokerOrderId,
        broker_update_order_id: brokerUpdateOrderId,
        submitted_at: row.submitted_at ?? new Date("2026-08-23T09:01:00.000Z"),
        last_checked_at: new Date("2026-08-23T09:01:00.000Z"),
        last_error: null,
        updated_at: new Date("2026-08-23T09:01:00.000Z")
      });
      return { rowCount: 1, rows: [row] };
    }

    if (sql.includes("SET status = $2")) {
      const [clientOrderId, status, fillPrice, filledAt, lastError] = params;
      const row = rows.get(clientOrderId);
      if (!row) return { rowCount: 0, rows: [] };
      Object.assign(row, {
        status,
        fill_price: fillPrice ?? row.fill_price,
        filled_at: filledAt == null ? row.filled_at : new Date(filledAt),
        last_error: lastError,
        last_checked_at: new Date("2026-08-23T09:02:00.000Z"),
        updated_at: new Date("2026-08-23T09:02:00.000Z")
      });
      return { rowCount: 1, rows: [row] };
    }

    if (sql.startsWith("SELECT * FROM execution_orders") && sql.includes("status NOT IN")) {
      const limit = params[0];
      const unresolved = [...rows.values()]
        .filter((row) => !["FILLED", "REJECTED", "CANCELED", "EXPIRED", "PARTIAL", "FAILED"].includes(row.status))
        .slice(0, limit);
      return { rowCount: unresolved.length, rows: unresolved };
    }

    throw new Error(`Unexpected SQL in fake query: ${sql}`);
  };
}

const CLAIM = Object.freeze({
  clientOrderId: "GRID-0-BUY1",
  strategyId: "btc-progressive-reference-reset-grid-v1",
  stateVersion: 0,
  gridTag: "BUY1",
  side: "BUY",
  requestedCashQuantity: 250
});

test("ledger persists a unique claim for one grid state and level", async () => {
  const ledger = createExecutionLedger({ query: createFakeQuery() });
  await ledger.init();
  const claimed = await ledger.claim(CLAIM);
  assert.equal(claimed.status, "CLAIMED");
  assert.equal(claimed.requestedCashQuantity, 250);
  assert.equal((await ledger.get(CLAIM.clientOrderId)).gridTag, "BUY1");
});

test("duplicate state+grid level is rejected even with a different client id", async () => {
  const ledger = createExecutionLedger({ query: createFakeQuery() });
  await ledger.claim(CLAIM);
  await assert.rejects(
    ledger.claim({ ...CLAIM, clientOrderId: "GRID-0-BUY1-retry" }),
    ExecutionOrderConflictError
  );
});

test("submitted order keeps broker identifiers and remains unresolved", async () => {
  const ledger = createExecutionLedger({ query: createFakeQuery() });
  await ledger.claim(CLAIM);
  const submitted = await ledger.markSubmitted(CLAIM.clientOrderId, {
    brokerOrderId: 123,
    brokerUpdateOrderId: 456
  });
  assert.equal(submitted.status, "SUBMITTED");
  assert.equal(submitted.brokerOrderId, "123");
  assert.deepEqual((await ledger.listUnresolved()).map((row) => row.clientOrderId), [CLAIM.clientOrderId]);
});

test("FILLED requires price and time and removes order from unresolved list", async () => {
  const ledger = createExecutionLedger({ query: createFakeQuery() });
  await ledger.claim(CLAIM);
  await assert.rejects(ledger.markStatus(CLAIM.clientOrderId, "FILLED"), /requires fillPrice/i);
  const filled = await ledger.markStatus(CLAIM.clientOrderId, "FILLED", {
    fillPrice: 67_195.25,
    filledAt: "2026-08-23T09:03:00.000Z"
  });
  assert.equal(filled.status, "FILLED");
  assert.equal(filled.fillPrice, 67_195.25);
  assert.equal((await ledger.listUnresolved()).length, 0);
});

test("unknown execution status fails closed", async () => {
  const ledger = createExecutionLedger({ query: createFakeQuery() });
  await ledger.claim(CLAIM);
  await assert.rejects(ledger.markStatus(CLAIM.clientOrderId, "MAYBE"), /status is invalid/i);
});
