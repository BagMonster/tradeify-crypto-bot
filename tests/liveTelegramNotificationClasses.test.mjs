import test from "node:test";
import assert from "node:assert/strict";
import { formatLiveTelegramNotification } from "../src/notifications/liveTelegramNotifications.js";

test("approved notification classes have distinct trade and safety presentation", () => {
  const lotClosed = formatLiveTelegramNotification({
    kind: "LOT_CLOSED",
    eventKey: "SOL-LOT-CLOSED:SOLGRID-9-BUY2-X4",
    ringTag: "BUY2",
    virtualSide: "BUY",
    lotId: "BUY2-V5",
    entryPrice: 91.25,
    originalQuantity: 0.12,
    finalFillPrice: 118.4,
    openedAt: "2026-08-24T10:00:00.000Z",
    closedAt: "2026-08-24T18:00:00.000Z"
  });
  assert.match(lotClosed.message, /^✅ SOL LOT FULLY CLOSED/m);
  assert.match(lotClosed.message, /Original quantity: 0\.12 SOL/);

  const heartbeat = formatLiveTelegramNotification({
    kind: "HEARTBEAT_CONFIRMED",
    eventKey: "SOL-HEARTBEAT:SOLHB-20260824-CLOSE",
    quantity: 0.01,
    openFillPrice: 93.83,
    closeFillPrice: 93.88,
    openedAt: "2026-08-24T10:00:00.000Z",
    closedAt: "2026-08-24T10:00:25.000Z"
  });
  assert.match(heartbeat.message, /^✅ SOL INACTIVITY HEARTBEAT COMPLETE/m);
  assert.match(heartbeat.message, /Ring state was not changed/);

  const account = formatLiveTelegramNotification({
    kind: "ACCOUNT_LOCKOUT",
    eventKey: "SOL-ACCOUNT-LOCK:20260824:FOREIGN_POSITION",
    reasonCode: "FOREIGN_POSITION"
  });
  assert.match(account.message, /^🚨 TRADEIFY ACCOUNT LOCKOUT/m);
  assert.match(account.message, /non-SOL position/);

  const runtimeHalt = formatLiveTelegramNotification({
    kind: "SAFETY_HALT",
    eventKey: "SOL-RUNTIME-HALT:20260824-15",
    reasonCode: "SOL_RUNTIME_ERROR"
  });
  assert.match(runtimeHalt.message, /^🚨 SOL SAFETY HALT — RUNTIME ERROR/m);
  assert.match(runtimeHalt.message, /Railway logs/);

  const protective = formatLiveTelegramNotification({
    kind: "PROTECTIVE_FLATTEN_CONFIRMED",
    eventKey: "SOL-PROTECTIVE-14",
    reason: "Daily-loss floor reached",
    quantity: 0.42,
    fillPrice: 88.5,
    filledAt: "2026-08-24T18:30:00.000Z"
  });
  assert.match(protective.message, /^🚨 PROTECTIVE FLATTEN CONFIRMED/m);
  assert.match(protective.message, /Daily-loss floor reached/);
  assert.match(protective.message, /Quantity closed: 0\.42 SOL/);
});

test("notification formatter rejects unsafe arbitrary text instead of echoing it", () => {
  assert.throws(() => formatLiveTelegramNotification({
    kind: "ENTRY_CONFIRMED",
    eventKey: "SOL-ENTRY:unsafe",
    ringTag: "BUY1",
    side: "BUY",
    fillPrice: 93.83,
    filledQuantity: 0.06,
    lotId: "BUY1-V1\nSESSION_TOKEN=secret",
    ma: 120,
    filledAt: "2026-08-24T15:00:00.000Z"
  }), /lotId is invalid/);

  assert.throws(() => formatLiveTelegramNotification({
    kind: "PROTECTIVE_FLATTEN_CONFIRMED",
    eventKey: "SOL-PROTECTIVE-99",
    reason: "arbitrary broker error body",
    quantity: 0.1,
    fillPrice: 90,
    filledAt: "2026-08-24T15:00:00.000Z"
  }), /protective reason is unsupported/);
});
