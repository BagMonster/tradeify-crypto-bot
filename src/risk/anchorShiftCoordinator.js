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
  async function cancel(reason) {
    if (!pending) return false;
    const prior = pending;
    pending = null;
    setEntryHold(false);
    await addEvent("INFO", "ANCHOR_SHIFT_CANCELLED", { reason, startedAt: new Date(prior.startedMs).toISOString() });
    return true;
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
    if (!pending && enteredFlat && hasExcursion()) {
      pending = { startedMs: now(), confirmations: 1 };
      setEntryHold(true);
      await addEvent("INFO", "ANCHOR_SHIFT_HOLD_STARTED", { holdMs, startedAt: new Date(pending.startedMs).toISOString() });
      return Object.freeze({ action: "HOLD_STARTED" });
    }
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

  return Object.freeze({ observe, getSnapshot: () => Object.freeze({ pending: pending !== null, holdStartedAtMs: pending?.startedMs ?? null, confirmations: pending?.confirmations ?? 0, holdMs }) });
}
