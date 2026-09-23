import test from "node:test";
import assert from "node:assert/strict";
import { createSolanaQuantityAdapter } from "../src/execution/solanaQuantityAdapter.js";

// 2026-09-22. Every order the bot places goes through this adapter, and it had no
// tests. A bare `catch {}` around the submission threw away the broker's reason for
// refusing an order and left the row PENDING, so the ring polled an order that did
// not exist at DXtrade and could never resolve. Hours of "PENDING" with no
// explanation anywhere.

function harness({ place, reconcile = async () => ({ status: "PENDING" }) }) {
  const rows = new Map();
  const marks = [];
  const persistence = {
    async getOrder(code) { return rows.get(code) ?? null; },
    async claimOrder(input) {
      const row = {
        orderCode: input.orderCode, strategyId: input.strategyId, instrument: input.instrument,
        stateVersion: input.stateVersion, actionType: input.actionType, ringTag: input.ringTag ?? null,
        lotId: input.lotId ?? null, tranche: input.tranche ?? null, side: input.side,
        requestedQuantity: input.requestedQuantity, status: "CLAIMED", brokerOrderId: null, lastError: null
      };
      rows.set(input.orderCode, row);
      return row;
    },
    async markSubmitted(code, brokerOrderId) {
      const row = { ...rows.get(code), status: "SUBMITTED", brokerOrderId };
      rows.set(code, row);
      return row;
    },
    async markStatus(code, status, details = {}) {
      marks.push({ code, status, lastError: details.lastError ?? null });
      const row = { ...rows.get(code), status, lastError: details.lastError ?? rows.get(code)?.lastError ?? null };
      rows.set(code, row);
      return row;
    }
  };
  const adapter = createSolanaQuantityAdapter({
    client: { placeMarketQuantityOrder: place, reconcileQuantityOrder: reconcile },
    persistence,
    instrument: "INJ/USD",
    sleep: async () => {},
    confirmationTimeoutMs: 0
  });
  return { adapter, marks, rows };
}

const entry = () => ({
  orderCode: "INJGRID-70-SELL11-E", strategyId: "injgrid-ring-grid-v1", instrument: "INJ/USD",
  stateVersion: 70, actionType: "ENTRY", ringTag: "SELL11", side: "SELL", quantity: 67.28
});

function withConsoleError(run) {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(String(line));
  return run().finally(() => { console.error = original; }).then(() => lines);
}

test("a broker refusal is FAILED, not PENDING, and carries the broker's words", async () => {
  const refusal = Object.assign(new Error("Trading on your account is set to close only. Error code 703."), { status: 403 });
  const { adapter, marks } = harness({ place: async () => { throw refusal; } });
  let result;
  const logged = await withConsoleError(async () => { result = await adapter.place(entry()); });

  assert.equal(result.status, "FAILED", "a refused order must not be reported as still working");
  assert.equal(result.confirmed, false);
  assert.match(result.reason, /close only/);
  const mark = marks.find((m) => m.status === "FAILED");
  assert.ok(mark, "the ledger row is FAILED");
  assert.match(mark.lastError, /HTTP 403/);
  assert.match(mark.lastError, /close only/);
  assert.ok(logged.some((line) => /submission FAILED for INJGRID-70-SELL11-E/.test(line) && /close only/.test(line)),
    "the reason reaches the log, which nothing later overwrites");
});

test("a 5xx or timeout stays PENDING, because the order may really be working", async () => {
  for (const error of [Object.assign(new Error("Bad gateway"), { status: 502 }), new Error("The operation was aborted")]) {
    const { adapter, marks } = harness({ place: async () => { throw error; } });
    const result = await withConsoleError(async () => { await adapter.place(entry()); });
    assert.ok(result.some((line) => /submission FAILED/.test(line)));
    const mark = marks.find((m) => m.status === "PENDING");
    assert.ok(mark, "uncertain submissions stay PENDING for reconciliation");
    assert.match(mark.lastError, /uncertain/);
  }
});

test("a 429 is uncertain, not a refusal", async () => {
  const { adapter, marks } = harness({ place: async () => { throw Object.assign(new Error("Too many requests"), { status: 429 }); } });
  await withConsoleError(async () => { await adapter.place(entry()); });
  assert.equal(marks.find((m) => m.status === "FAILED"), undefined);
  assert.ok(marks.some((m) => m.status === "PENDING"));
});

test("a successful submission records the broker order id and does not log a failure", async () => {
  const { adapter, rows } = harness({
    place: async () => ({ orderId: 17783879 }),
    reconcile: async () => ({ status: "FILLED", fillPrice: 118.535, filledQuantity: 67.28, filledAt: "2026-09-22T23:27:27.887Z", orderCode: "INJGRID-70-SELL11-E" })
  });
  const logged = await withConsoleError(async () => { await adapter.place(entry()); });
  assert.deepEqual(logged, []);
  assert.equal(rows.get("INJGRID-70-SELL11-E").brokerOrderId, 17783879);
});
