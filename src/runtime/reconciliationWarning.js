export const FILL_GRACE_MS = 25_000;
export const ALERT_INTERVAL_MS = 5 * 60_000;
export const HALT_AFTER_MS = 15 * 60_000;
export const ALERT_COUNT = 3;

/**
 * In-memory warning clock for a virtual-vs-broker net mismatch.
 *
 * A legal fill may look mismatched until DXtrade's snapshot catches up.
 * That case is handled separately by FILL_GRACE_MS in the runtime.
 * This helper only decides Telegram alerts and the delayed halt.
 *
 * Alerts fire at 0 / 5 / 10 minutes. Halt fires at 15 minutes if the
 * mismatch is still present. A matching tick clears the clock.
 */
export function nextReconciliationWarning(state, { now, mismatched }) {
  if (!Number.isFinite(now)) throw new TypeError("now must be a finite timestamp");
  if (mismatched !== true) {
    return Object.freeze({ state: null, action: "CLEAR", alertNumber: 0 });
  }
  if (!state || !Number.isFinite(state.firstAt)) {
    return Object.freeze({
      state: Object.freeze({ firstAt: now, lastAlertAt: now, alertsSent: 1 }),
      action: "ALERT",
      alertNumber: 1
    });
  }
  const elapsed = now - state.firstAt;
  if (elapsed >= HALT_AFTER_MS) {
    return Object.freeze({ state, action: "HALT", alertNumber: state.alertsSent });
  }
  if (state.alertsSent < ALERT_COUNT && (now - state.lastAlertAt) >= ALERT_INTERVAL_MS) {
    const alertsSent = state.alertsSent + 1;
    return Object.freeze({
      state: Object.freeze({ firstAt: state.firstAt, lastAlertAt: now, alertsSent }),
      action: "ALERT",
      alertNumber: alertsSent
    });
  }
  return Object.freeze({ state, action: "WAIT", alertNumber: state.alertsSent });
}

export function withinFillGrace({ lastFillAt, now }) {
  const lastFillMs = typeof lastFillAt === "string" ? Date.parse(lastFillAt) : Number(lastFillAt);
  const nowMs = typeof now === "string" ? Date.parse(now) : Number(now);
  if (!Number.isFinite(lastFillMs) || !Number.isFinite(nowMs)) return false;
  const ageMs = nowMs - lastFillMs;
  return ageMs >= 0 && ageMs < FILL_GRACE_MS;
}
