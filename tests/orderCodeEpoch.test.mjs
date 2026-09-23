import test from "node:test";
import assert from "node:assert/strict";
import { createRingExecutionGuard, accountOrderEpoch } from "../src/execution/ringExecutionGuard.js";

// 2026-09-22. Every entry on the new $10,000 account came back from DXtrade as
// "HTTP 409, code 100: Entity already exists at server". Client order codes are
// deterministic (PREFIX-GRID-<stateVersion>-<tag>-E), ring_grid_state was carried
// across the account switch so the state versions never moved, and DXtrade keeps
// those codes on ITS side for the login. Every code the bot could generate had
// already been used on the closed $50,000 account, and clearing our own database
// could not help. The epoch namespaces order codes by account.

test("the epoch is derived from the account code and is stable", () => {
  const a = accountOrderEpoch("TRADEIFY-10K-001");
  assert.match(a, /^[a-f0-9]{4}-$/);
  assert.equal(a, accountOrderEpoch("TRADEIFY-10K-001"), "the same account always gives the same epoch");
  assert.equal(a, accountOrderEpoch("  TRADEIFY-10K-001  "), "whitespace in a Railway variable changes nothing");
  assert.notEqual(a, accountOrderEpoch("TRADEIFY-50K-999"), "a different account gives a different epoch");
});

test("no account code means no epoch, so existing behaviour is unchanged", () => {
  for (const value of ["", "   ", null, undefined]) assert.equal(accountOrderEpoch(value), "");
});

function guard(orderCodeEpoch) {
  const placed = [];
  const g = createRingExecutionGuard({
    instrument: "INJ/USD",
    orderPrefix: "INJGRID",
    strategyId: "injgrid-ring-grid-v1",
    lotStep: 0.01,
    autoExecute: true,
    strategyAutoExecute: true,
    orderCodeEpoch,
    adapter: {
      async place(request) {
        placed.push(request.orderCode);
        return { confirmed: true, status: "FILLED", orderCode: request.orderCode, fillPrice: 4.5, filledQuantity: request.quantity, filledAt: "2026-09-22T23:00:00.000Z" };
      }
    },
    client: {
      async getOpenPositions() { return { positions: [] }; },
      async placePositionClose() { return {}; },
      async placePositionPartialClose() { return {}; },
      async reconcileQuantityOrder() { return { status: "PENDING" }; }
    },
    persistence: { async claimOrder() { return {}; }, async getOrder() { return null; } }
  });
  return { guard: g, placed };
}

const entry = () => ({ type: "ENTRY", stateVersion: 70, tag: "SELL11", ringTag: "SELL11", side: "SELL", quantity: 67.28 });

test("two accounts never generate the same order code for the same ring", async () => {
  const first = guard(accountOrderEpoch("OLD-50K"));
  const second = guard(accountOrderEpoch("NEW-10K"));
  await first.guard.executeIntent(entry());
  await second.guard.executeIntent(entry());
  assert.notEqual(first.placed[0], second.placed[0], "the same ring at the same state version must not reuse a code across accounts");
  for (const code of [first.placed[0], second.placed[0]]) {
    assert.match(code, /^INJGRIDGRID-[a-f0-9]{4}-70-SELL11-E$/);
    assert.ok(code.length <= 64, "DXtrade limits client order codes to 64 characters");
  }
});

test("without an epoch the code keeps its old shape", async () => {
  const { guard: g, placed } = guard("");
  await g.executeIntent(entry());
  assert.equal(placed[0], "INJGRIDGRID-70-SELL11-E");
});

test("a malformed epoch is refused at construction rather than sent to the broker", () => {
  for (const bad of ["ABCD-", "zz", "../", "toolongtobevalid-"]) {
    assert.throws(() => guard(bad), /orderCodeEpoch/);
  }
});
