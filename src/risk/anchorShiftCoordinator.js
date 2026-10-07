// Account-level confirmation for anchor shifts.  It owns only a brief entry
// hold; risk, exits, harvest, and protective orders remain untouched.

export function createAnchorShiftCoordinator({ books, holdMs = 9_000, now = () => Date.now(), addEvent = async () => {}, notifications = null }) {
  if (!Array.isArray(books) || books.length === 0) throw new TypeError("books are required");
  if (!Number.isFinite(holdMs) || holdMs < 1_000) throw new TypeError("holdMs is invalid");
  let wasFlat = false;
  let observedSnapshot = false;
  let pending = null;

  function hasExcursion() { return books.some((book) => book.hasPendingAnchorExcursion?.() === true); }
  function setEntryHold(on) { for (const book of books) book.setAnchorShiftHold?.(on); }
  function virtualLots() { return books.filter((book) => book.hasVirtualLots?.() === true).map((book) => book.instrument); }
  function orderInFlight() { return books.some((book) => book.hasOrderInFlight?.() === true); }
  function healthyFlat(snapshot) {
    return snapshot?.accountLocked !== true && snapshot?.positionsReadFailed !== true && snapshot?.signedNetReadOk === true &&
      Number(snapshot?.openPositionsCount) === 0 && virtualLots().length === 0 && !orderInFlight();
  }
  function pendingInstruments() {
    return books.filter((book) => book.hasPendingAnchorExcursion?.() === true).map((book) => book.instrument);
  }
  function notify(kind, event) {
    try {
      notifications?.enqueue?.({
        kind,
        eventKey: `${kind}:${event.startedAt ?? new Date(now()).toISOString()}`,
        ...event
      });
    } catch {
      // Alert delivery must never delay or change the confirmed-flat safety flow.
    }
  }
  async function cancel(reason) {
    if (!pending) return false;
    const prior = pending;
    pending = null;
    setEntryHold(false);
    const event = { reason, startedAt: new Date(prior.startedMs).toISOString(), instruments: pendingInstruments() };
    await addEvent("INFO", "ANCHOR_SHIFT_CANCELLED", event);
    notify("ANCHOR_SHIFT_CANCELLED", event);
    return true;
  }
  async function startHold(source) {
    pending = { startedMs: now(), confirmations: 1, source };
    setEntryHold(true);
    const instruments = pendingInstruments();
    const event = { source, holdMs, startedAt: new Date(pending.startedMs).toISOString(), instruments };
    await addEvent("INFO", "ANCHOR_SHIFT_HOLD_STARTED", event);
    notify("ANCHOR_SHIFT_HOLD_STARTED", event);
    return Object.freeze({ action: "HOLD_STARTED", source, instruments: Object.freeze(instruments) });
  }

  async function observe(snapshot) {
    const flat = healthyFlat(snapshot);
    if (!observedSnapshot) {
      observedSnapshot = true;
      wasFlat = flat;
      return Object.freeze({ action: flat ? "INITIAL_FLAT" : "INITIAL_NOT_FLAT" });
    }
    if (!flat) {
      await cancel(snapshot?.accountLocked ? "BROKER_UNHEALTHY_OR_LOCKED" : "ACCOUNT_NOT_FLAT");
      wasFlat = false;
      return Object.freeze({ action: "NOT_FLAT" });
    }
    const enteredFlat = !wasFlat;
    wasFlat = true;
    if (!pending && enteredFlat && hasExcursion()) return startHold("ACCOUNT_FLAT_TRANSITION");
    if (!pending) return Object.freeze({ action: "FLAT_NO_EXCURSION" });
    pending.confirmations += 1;
    if (now() - pending.startedMs < holdMs || pending.confirmations < 2) return Object.freeze({ action: "HOLDING", remainingMs: Math.max(0, holdMs - (now() - pending.startedMs)) });
    const shifted = [];
    for (const book of books) {
      if (book.hasPendingAnchorExcursion?.() !== true) continue;
      const result = await book.applyAnchorShift?.({ shiftedAt: new Date(now()).toISOString() });
      if (result?.shifted === true) shifted.push(result);
    }
    pending = null;
    setEntryHold(false);
    if (shifted.length > 0) await addEvent("WARN", "ANCHOR_SHIFT_APPLIED", { instruments: shifted.map((row) => row.instrument) });
    return Object.freeze({ action: "SHIFTED", shifted: Object.freeze(shifted) });
  }

  // A deploy during a genuine broker-flat event cannot reconstruct the preceding
  // non-flat snapshot. This deliberately starts the same confirmation hold rather
  // than shifting immediately; only a fresh later monitor snapshot may complete it.
  async function beginVerifiedFlatRecovery(snapshot) {
    if (!healthyFlat(snapshot)) return Object.freeze({ action: "RECOVERY_REFUSED" });
    if (!hasExcursion()) return Object.freeze({ action: "RECOVERY_NOT_NEEDED" });
    if (pending) return Object.freeze({ action: "HOLD_ALREADY_STARTED" });
    observedSnapshot = true;
    wasFlat = true;
    return startHold("OWNER_VERIFIED_FLAT_RECOVERY");
  }

  return Object.freeze({ observe, beginVerifiedFlatRecovery, getSnapshot: () => Object.freeze({ pending: pending !== null, holdStartedAtMs: pending?.startedMs ?? null, confirmations: pending?.confirmations ?? 0, holdMs, source: pending?.source ?? null }) });
}
