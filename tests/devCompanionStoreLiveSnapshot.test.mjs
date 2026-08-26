import test from "node:test";
import assert from "node:assert/strict";
import { createDevCompanionStore } from "../src/devCompanionStore.js";

class FakePool {
  constructor() {
    this.queries = [];
    this.snapshotRow = null;
  }

  async query(sql, params = []) {
    this.queries.push({ sql, params });
    if (/CREATE TABLE IF NOT EXISTS sol_companion_live_snapshot/i.test(sql)) {
      return { rowCount: 0, rows: [] };
    }
    if (/INSERT INTO sol_companion_live_snapshot/i.test(sql)) {
      this.snapshotRow = {
        payload: JSON.parse(params[0]),
        updated_at: "2026-08-26T16:00:00.000Z"
      };
      return { rowCount: 1, rows: [] };
    }
    if (/FROM sol_companion_live_snapshot/i.test(sql)) {
      if (!this.snapshotRow) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [this.snapshotRow] };
    }
    return { rowCount: 0, rows: [] };
  }

  async end() {}
}

test("store persists one sanitized live snapshot and reads it back", async () => {
  const pool = new FakePool();
  const store = createDevCompanionStore({
    databaseUrl: "postgres://unused",
    PoolClass: class {
      constructor() {
        return pool;
      }
    }
  });

  await store.init();
  assert.equal(pool.queries.some((item) => /sol_companion_live_snapshot/.test(item.sql)), true);

  const saved = await store.saveLiveSnapshot({
    capturedAt: "2026-08-26T16:00:00.000Z",
    virtualNetUnits: -0.06,
    brokerNetUnits: 0,
    occupiedRings: ["SELL3", "not-a-tag"],
    password: "nope"
  });
  assert.equal(saved.mismatch, true);
  assert.deepEqual(saved.occupiedRings, ["SELL3"]);
  assert.equal(Object.hasOwn(saved, "password"), false);

  const latest = await store.latestLiveSnapshot();
  assert.equal(latest.mismatch, true);
  assert.equal(latest.virtualNetUnits, -0.06);
  assert.deepEqual(latest.occupiedRings, ["SELL3"]);
});
