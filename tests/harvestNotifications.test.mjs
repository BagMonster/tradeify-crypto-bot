import test from "node:test";
import assert from "node:assert/strict";
import { formatLiveTelegramNotification } from "../src/notifications/liveTelegramNotifications.js";

test("D-064 harvest notifications are accepted and describe each operator state", () => {
  const pending = formatLiveTelegramNotification({ kind: "HARVEST_PENDING", eventKey: "D064-PENDING:20260909", combinedDayPnlUsd: 250, thresholdUsd: 250 });
  const confirmed = formatLiveTelegramNotification({ kind: "HARVEST_CONFIRMED", eventKey: "D064-CONFIRMED:20260909", combinedDayPnlUsd: 251.25, thresholdUsd: 250, confirmedAt: "2026-09-09T12:00:00.000Z" });
  const halted = formatLiveTelegramNotification({ kind: "HARVEST_HALTED", eventKey: "D064-HALTED:20260909", reason: "Broker flat confirmation failed" });
  const reset = formatLiveTelegramNotification({ kind: "HARVEST_RESET", eventKey: "D064-RESET:20260910", dayKey: "2026-09-10" });
  assert.match(pending.message, /PENDING/);
  assert.match(confirmed.message, /CONFIRMED/);
  assert.match(halted.message, /SAFETY HALT/);
  assert.match(reset.message, /RESET/);
});
