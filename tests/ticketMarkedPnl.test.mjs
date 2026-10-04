import assert from "node:assert/strict";
import test from "node:test";
import { ticketMarkedOpenPnlUsd } from "../src/risk/ticketMarkedPnl.js";

test("ticket-marked P&L keeps a losing short isolated to its own instrument", () => {
  const pnl = ticketMarkedOpenPnlUsd({
    markPrice: 0.80,
    tickets: [
      { quantity: -772.73, entryPrice: 0.7543 },
      { quantity: -530.61, entryPrice: 0.7320 }
    ]
  });
  assert.ok(pnl < -71 && pnl > -72, `expected the RUNE-style loss, got ${pnl}`);
});

test("ticket-marked P&L handles long and short tickets independently", () => {
  const pnl = ticketMarkedOpenPnlUsd({
    markPrice: 105,
    tickets: [
      { quantity: 2, entryPrice: 100 },
      { quantity: -3, entryPrice: 110 }
    ]
  });
  assert.equal(pnl, 25);
});

test("an open ticket without a broker entry price is unread rather than treated as flat", () => {
  assert.throws(
    () => ticketMarkedOpenPnlUsd({ markPrice: 100, tickets: [{ quantity: -1, entryPrice: null }] }),
    /entryPrice/
  );
});
