const WARNING_INTERVAL_MS = 5 * 60 * 1000;
const WARNING_COUNT = 5;

function requiredText(name, value, max = 300) {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > max) {
    throw new TypeError(`${name} must be non-empty text`);
  }
  return value.trim();
}

function optionalText(name, value, max = 300) {
  return value == null ? null : requiredText(name, value, max);
}

function asDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("halt warning timestamp is invalid");
  return date;
}

function cycleFrom(input, nowMs) {
  const startedAt = new Date(nowMs);
  return Object.freeze({
    key: requiredText("halt warning key", input.key, 160),
    reasonCode: requiredText("halt warning reason code", input.reasonCode, 64),
    reason: requiredText("halt warning reason", input.reason, 300),
    instrument: optionalText("halt warning instrument", input.instrument, 32),
    correction: requiredText("halt warning correction", input.correction, 400),
    warningNumber: 1,
    startedAt: startedAt.toISOString(),
    nextWarningAt: new Date(nowMs + WARNING_INTERVAL_MS).toISOString(),
    haltAt: new Date(nowMs + WARNING_COUNT * WARNING_INTERVAL_MS).toISOString()
  });
}

function warningEvent(cycle) {
  return {
    kind: "HALT_WARNING",
    eventKey: `HALT-WARNING:${cycle.key}:${cycle.warningNumber}:${cycle.startedAt.replaceAll(/[-:.TZ]/g, "")}`,
    reasonCode: cycle.reasonCode,
    reason: cycle.reason,
    instrument: cycle.instrument,
    correction: cycle.correction,
    warningNumber: cycle.warningNumber,
    warningCount: WARNING_COUNT,
    haltAt: cycle.haltAt
  };
}

/**
 * Owner-controlled replacement for durable non-harvest safety halts.
 *
 * One account-wide warning cycle is persisted at a time.  The owner receives
 * warning 1 immediately, then warnings 2–5 at five-minute intervals.  The
 * hard stop is eligible only after the fifth five-minute interval (25 minutes
 * from warning 1).  /pausehalt restarts the same cycle at warning 1.
 */
export function createHaltWarningCycle({
  store,
  notifications = null,
  addEvent = async () => {},
  onDue = async () => ({ action: "HALT" }),
  now = () => Date.now()
}) {
  for (const method of ["get", "save", "clear"]) {
    if (typeof store?.[method] !== "function") throw new TypeError(`halt warning store.${method} is required`);
  }

  let busy = false;
  let cached = null;

  async function current() {
    cached = await store.get();
    return cached;
  }

  async function emitWarning(cycle, level = "WARN") {
    await addEvent(level, "HALT_WARNING", {
      key: cycle.key,
      reasonCode: cycle.reasonCode,
      instrument: cycle.instrument,
      warningNumber: cycle.warningNumber,
      warningCount: WARNING_COUNT,
      haltAt: cycle.haltAt
    });
    notifications?.enqueue?.(warningEvent(cycle));
  }

  async function request(input) {
    const existing = await current();
    if (existing) {
      if (existing.key === input.key) return Object.freeze({ action: "ALREADY_PENDING", cycle: existing });
      return Object.freeze({ action: "OTHER_HALT_PENDING", cycle: existing });
    }
    const cycle = cycleFrom(input, now());
    const saved = await store.save(cycle);
    cached = saved;
    await emitWarning(saved);
    return Object.freeze({ action: "WARNING_1", cycle: saved });
  }

  async function clear(key = null) {
    const existing = await current();
    if (!existing || (key !== null && existing.key !== key)) return false;
    await store.clear(existing.key);
    cached = null;
    await addEvent("INFO", "HALT_WARNING_CLEARED", { key: existing.key, reasonCode: existing.reasonCode });
    return true;
  }

  async function defer() {
    const existing = await current();
    if (!existing) return Object.freeze({ action: "NO_PENDING_HALT", cycle: null });
    const next = cycleFrom(existing, now());
    const saved = await store.save(next);
    cached = saved;
    await addEvent("WARN", "HALT_WARNING_DEFERRED", {
      key: saved.key,
      reasonCode: saved.reasonCode,
      instrument: saved.instrument,
      warningCount: WARNING_COUNT,
      haltAt: saved.haltAt
    });
    return Object.freeze({ action: "DEFERRED", cycle: saved });
  }

  async function advance() {
    if (busy) return Object.freeze({ action: "BUSY" });
    busy = true;
    try {
      const existing = await current();
      if (!existing) return Object.freeze({ action: "NONE" });
      const nowMs = now();
      if (nowMs >= asDate(existing.haltAt).getTime()) {
        const result = await onDue(existing);
        if (result?.action === "NO_LONGER_REQUIRED") {
          await store.clear(existing.key);
          cached = null;
          await addEvent("INFO", "HALT_WARNING_CLEARED", { key: existing.key, reasonCode: existing.reasonCode, reason: "condition recovered before stop" });
          return Object.freeze({ action: "CLEARED", cycle: existing });
        }
        await store.clear(existing.key);
        cached = null;
        await addEvent("ERROR", "HALT_WARNING_FIRED", { key: existing.key, reasonCode: existing.reasonCode, instrument: existing.instrument });
        return Object.freeze({ action: "HALTED", cycle: existing, result });
      }
      if (existing.warningNumber >= WARNING_COUNT || nowMs < asDate(existing.nextWarningAt).getTime()) {
        return Object.freeze({ action: "WAITING", cycle: existing });
      }
      const next = Object.freeze({
        ...existing,
        warningNumber: existing.warningNumber + 1,
        nextWarningAt: new Date(nowMs + WARNING_INTERVAL_MS).toISOString()
      });
      const saved = await store.save(next);
      cached = saved;
      await emitWarning(saved);
      return Object.freeze({ action: `WARNING_${saved.warningNumber}`, cycle: saved });
    } finally {
      busy = false;
    }
  }

  return Object.freeze({ request, clear, defer, advance, prime: current, snapshot: () => cached, warningIntervalMs: WARNING_INTERVAL_MS, warningCount: WARNING_COUNT });
}
