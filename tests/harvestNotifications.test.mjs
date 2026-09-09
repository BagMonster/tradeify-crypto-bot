import test from "node:test";
import assert from "node:assert/strict";
import { formatLiveTelegramNotification } from "../src/notifications/liveTelegramNotifications.js";

test("D-064 harvest notifications are accepted and describe each operator state", () => {
  const pending = formatLiveTelegramNotification({ kind: "HARVEST_PENDING", eventKey: "D064-PENDING:20260909", combinedDayPnlUsd: 250, thresholdUsd: 250 });
  const confirmed = formatLiveTelegramNotification({ kind: "HARVEST_CONFIRMED", eventKey: "D064-CONFIRMED:20260909", combinedDayPnlUsd: 251.25, thresholdUsd: 250, confirmedAt: "2026-09-09T12:00:00.000Z" });
  const halted = formatLiveTelegramNotification({ kind: "HARVEST_HALTED", eventKey: "D064-HALTED:20260909", reason: "D-064 harvest cannot verify fresh broker account data for SOL/USD" });
  const grace = formatLiveTelegramNotification({ kind: "HARVEST_FRESHNESS_GRACE", eventKey: "D064-FRESH-GRACE:20260910:1", instruments: ["SOL/USD", "INJ/USD"], graceMs: 300000 });
  const reset = formatLiveTelegramNotification({ kind: "HARVEST_RESET", eventKey: "D064-RESET:20260910", dayKey: "2026-09-10" });
  assert.match(pending.message, /PENDING/);
  assert.match(confirmed.message, /CONFIRMED/);
  assert.match(halted.message, /SAFETY HALT/);
  assert.match(halted.message, /\/harvestrecover/);
  assert.match(grace.message, /5 minutes/);
  assert.match(grace.message, /do not use \/resume/);
  assert.match(reset.message, /RESET/);
});

test("non-harvest halt warning identifies the correction and the owner deferral command", () => {
  const warning = formatLiveTelegramNotification({
    kind: "HALT_WARNING",
    eventKey: "HALT-WARNING:RECON:1:20260909120000",
    reasonCode: "RECONCILIATION_MISMATCH",
    instrument: "INJ/USD",
    reason: "INJ virtual net does not match DXtrade net.",
    correction: "Wait for matching nets, then use /rematch INJ if the halt fires.",
    warningNumber: 1,
    warningCount: 5,
    haltAt: "2026-09-09T12:25:00.000Z"
  });
  assert.match(warning.message, /WARNING 1\/5/);
  assert.match(warning.message, /Trading is still running/);
  assert.match(warning.message, /\/pausehalt/);
});
