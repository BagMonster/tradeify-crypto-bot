// Account-level confirmation owns an entry-only hold. Protective operations
// remain independent. An application failure is terminal, never a timer retry.
export function createAnchorShiftCoordinator({ books, holdMs = 9_000, confirmationTimeoutMs = 30_000, freshAfterMs = 6_000, getCurrentSnapshot = null, now = () => Date.now(), addEvent = async () => {}, notifications = null }) {
  if (!Array.isArray(books) || books.length === 0) throw new TypeError("books are required");
  if (!Number.isFinite(holdMs) || holdMs < 1_000) throw new TypeError("holdMs is invalid");
  if (!Number.isFinite(confirmationTimeoutMs) || confirmationTimeoutMs <= holdMs) throw new TypeError("confirmationTimeoutMs is invalid");
  let wasFlat = false;
  let observedSnapshot = false;
  let pending = null;
  let failure = null;
  let operation = Promise.resolve();

  function hasExcursion() { return books.some((book) => book.hasPendingAnchorExcursion?.() === true); }
  function setEntryHold(on) { for (const book of books) book.setAnchorShiftHold?.(on); }
  function pendingInstruments() { return books.filter((book) => book.hasPendingAnchorExcursion?.() === true).map((book) => book.instrument); }
  function snapshotTime(snapshot) {
    const value = snapshot?.fetchedAtMs;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  function fresh(snapshot) {
    const at = snapshotTime(snapshot);
    return at !== null && at <= now() && now() - at <= freshAfterMs;
  }
  function healthyFlat(snapshot) {
    return fresh(snapshot) && snapshot?.accountLocked !== true && snapshot?.positionsReadFailed !== true && snapshot?.signedNetReadOk === true &&
      Number(snapshot?.openPositionsCount) === 0 && !books.some((book) => book.hasVirtualLots?.() === true || book.hasOrderInFlight?.() === true);
  }
  function currentFlat(snapshot) {
    return healthyFlat(getCurrentSnapshot ? getCurrentSnapshot() : snapshot);
  }
  function notify(kind, event) {
    try { notifications?.enqueue?.({ kind, eventKey: `${kind}:${event.startedAt}`, ...event }); } catch {}
  }
  function audit(level, kind, event) {
    // Audit storage cannot prevent a hold from reaching its terminal outcome.
    void Promise.resolve().then(() => addEvent(level, kind, event)).catch(() => undefined);
  }
  function cancel(reason) {
    if (!pending) return false;
    const prior = pending;
    pending = null;
    setEntryHold(false);
    const event = { reason, startedAt: new Date(prior.startedMs).toISOString(), instruments: pendingInstruments() };
    notify("ANCHOR_SHIFT_CANCELLED", event);
    audit("INFO", "ANCHOR_SHIFT_CANCELLED", event);
    return true;
  }
  function startHold(source, snapshot) {
    const firstSnapshotAtMs = snapshotTime(snapshot);
    pending = { startedMs: now(), confirmations: 1, source, firstSnapshotAtMs, lastSnapshotAtMs: firstSnapshotAtMs };
    setEntryHold(true);
    const instruments = pendingInstruments();
    const event = { source, holdMs, startedAt: new Date(pending.startedMs).toISOString(), instruments };
    notify("ANCHOR_SHIFT_HOLD_STARTED", event);
    audit("INFO", "ANCHOR_SHIFT_HOLD_STARTED", event);
    return Object.freeze({ action: "HOLD_STARTED", source, instruments: Object.freeze(instruments) });
  }
  function fail(error, instrument, shifted, unprocessed) {
    const prior = pending;
    pending = null;
    // Retain an explicit account-wide ENTRY-only failure block. A new owner
    // recovery may retry only when rollback is certain and fresh flatness holds.
    failure = Object.freeze({
      reason: error?.code === "ANCHOR_PERSISTENCE_FAILED" ? "PERSISTENCE_FAILED" : "APPLY_FAILED",
      instrument,
      rollbackConfirmed: error?.rollbackConfirmed === true,
      shifted: Object.freeze(shifted.map((row) => row.instrument)),
      unprocessed: Object.freeze(unprocessed),
      startedAt: new Date(prior.startedMs).toISOString()
    });
    setEntryHold(true);
    notify("ANCHOR_SHIFT_FAILED", failure);
    audit("ERROR", "ANCHOR_SHIFT_FAILED", failure);
    return Object.freeze({ action: "FAILED", failure });
  }
  async function observeSnapshot(snapshot) {
    if (failure) return Object.freeze({ action: "FAILED", failure });
    const flat = healthyFlat(snapshot);
    if (!observedSnapshot) {
      observedSnapshot = true;
      wasFlat = flat;
      return Object.freeze({ action: flat ? "INITIAL_FLAT" : "INITIAL_NOT_FLAT" });
    }
    if (!flat) {
      cancel(!fresh(snapshot) || snapshot?.accountLocked || snapshot?.positionsReadFailed || snapshot?.signedNetReadOk !== true ? "BROKER_UNHEALTHY_OR_LOCKED" : "ACCOUNT_NOT_FLAT");
      wasFlat = false;
      return Object.freeze({ action: "NOT_FLAT" });
    }
    const enteredFlat = !wasFlat;
    wasFlat = true;
    if (!pending && enteredFlat && hasExcursion()) return startHold("ACCOUNT_FLAT_TRANSITION", snapshot);
    if (!pending) return Object.freeze({ action: "FLAT_NO_EXCURSION" });
    if (now() - pending.startedMs >= confirmationTimeoutMs) {
      cancel("CONFIRMATION_TIMEOUT");
      return Object.freeze({ action: "CANCELLED", reason: "CONFIRMATION_TIMEOUT" });
    }
    const snapshotAtMs = snapshotTime(snapshot);
    if (snapshotAtMs <= pending.lastSnapshotAtMs) return Object.freeze({ action: "HOLDING", remainingMs: Math.max(0, holdMs - (now() - pending.startedMs)), awaitingFreshSnapshot: true });
    pending.lastSnapshotAtMs = snapshotAtMs;
    pending.confirmations += 1;
    if (now() - pending.startedMs < holdMs || pending.confirmations < 2) return Object.freeze({ action: "HOLDING", remainingMs: Math.max(0, holdMs - (now() - pending.startedMs)) });
    const shifted = [];
    const eligible = books.filter((book) => book.hasPendingAnchorExcursion?.() === true);
    for (let i = 0; i < eligible.length; i += 1) {
      const book = eligible[i];
      // Async persistence of a preceding book must not extend flatness proof
      // indefinitely or hide a virtual lot/order that appeared in the meantime.
      if (!currentFlat(snapshot)) {
        const error = new Error("flat confirmation expired during application");
        return fail(error, book.instrument, shifted, eligible.slice(i + 1).map((row) => row.instrument));
      }
      try {
        const result = await book.applyAnchorShift({ shiftedAt: new Date(now()).toISOString(), validateFlat: () => currentFlat(snapshot) });
        if (result?.shifted !== true) throw new Error("anchor shift was not applied");
        shifted.push(result);
      } catch (error) {
        return fail(error, book.instrument, shifted, eligible.slice(i + 1).map((row) => row.instrument));
      }
    }
    pending = null;
    setEntryHold(false);
    if (shifted.length > 0) audit("WARN", "ANCHOR_SHIFT_APPLIED", { instruments: shifted.map((row) => row.instrument) });
    return Object.freeze({ action: "SHIFTED", shifted: Object.freeze(shifted) });
  }
  async function beginVerifiedFlatRecoverySnapshot(snapshot) {
    if (!healthyFlat(snapshot)) return Object.freeze({ action: "RECOVERY_REFUSED" });
    if (failure?.rollbackConfirmed !== true && failure) return Object.freeze({ action: "FAILED", failure });
    if (!hasExcursion()) return Object.freeze({ action: "RECOVERY_NOT_NEEDED" });
    if (pending) return Object.freeze({ action: "HOLD_ALREADY_STARTED" });
    failure = null;
    observedSnapshot = true;
    wasFlat = true;
    return startHold("OWNER_VERIFIED_FLAT_RECOVERY", snapshot);
  }
  function serialize(task) {
    const result = operation.then(task, task);
    operation = result.catch(() => undefined);
    return result;
  }
  function observe(snapshot) { return serialize(() => observeSnapshot(snapshot)); }
  function beginVerifiedFlatRecovery(snapshot) { return serialize(() => beginVerifiedFlatRecoverySnapshot(snapshot)); }
  function abort() { return serialize(() => pending ? fail(null, pendingInstruments()[0] ?? books[0].instrument, [], pendingInstruments().slice(1)) : { action: "NO_HOLD" }); }
  return Object.freeze({ observe, beginVerifiedFlatRecovery, abort, getSnapshot: () => Object.freeze({ pending: pending !== null, failure, holdStartedAtMs: pending?.startedMs ?? null, confirmations: pending?.confirmations ?? 0, holdMs, source: pending?.source ?? null, firstSnapshotAtMs: pending?.firstSnapshotAtMs ?? null, lastSnapshotAtMs: pending?.lastSnapshotAtMs ?? null }) });
}
