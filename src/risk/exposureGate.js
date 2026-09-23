/**
 * src/risk/exposureGate.js
 *
 * Account-wide exposure pool: one gate in front of every new entry, on every book.
 *
 * WHY. On 2026-09-19, with the broker session still healthy and every rule followed,
 * the bot opened three more shorts and exposure went $23,699 -> $41,079 on a $49,000
 * account. The per-book cap was $150,000 and no book had reached its entry brake, so
 * nothing refused. At $41k of exposure a 3.2% adverse move is $1,308, which is what
 * happened. The per-book cap sizes rings; it was never a risk limit. This is.
 *
 * THE RULE (owner's design, 2026-09-17 handoff Part 3.3):
 *   - SOFT ceiling: no new entries while account exposure is AT OR ABOVE it.
 *   - HARD ceiling: a single fill may never take exposure PAST it.
 * Exits, tranches, the brake, cuts, the flatten, harvest and one-sided books are not
 * touched. Only new entries are gated. Choking is intended: the books that are moving
 * fill the pool, and everything else waits.
 *
 * EXPOSURE is broker notional at market across all books (the same bookExposure()
 * figure riskSupervisor and /status use), plus entries this process has approved that
 * the broker snapshot does not show yet. On a market-wide move every book triggers in
 * the same minute, so without those reservations two books could both see room for the
 * last $100 and both fill.
 *
 * A reservation for a FILLED entry is released only once a broker snapshot fetched
 * after the fill is available, so the only possible error is counting an entry twice
 * (refusing more), never missing one. A reservation is released at once only when the
 * order provably never reached the broker.
 *
 * UNKNOWN IS NOT ZERO. If broker account data is unavailable or stale, entries are
 * refused.
 *
 * ALERTS. One EXPOSURE_GATE_CLOSED alert when entries are first refused at the soft
 * ceiling, a count of refusals while it stays closed, and one EXPOSURE_GATE_REOPENED
 * alert when an entry is allowed again below the soft ceiling. A fill that is refused
 * only because it would cross the hard ceiling is the design working (a smaller ring
 * may still fit), so it is logged and counted but does not page the owner.
 */

// A filled reservation is dropped after this long even if no newer broker snapshot has
// arrived. If the account monitor has stalled, exposure reads fail and entries are
// refused anyway, so this only bounds memory, never safety.
const DEFAULT_FILLED_RESERVATION_TTL_MS = 60_000;
// The broker snapshot must be fetched this long after a fill before it is trusted to
// include it.
const DEFAULT_SNAPSHOT_MARGIN_MS = 1_000;

// Statuses that mean NO exposure was opened, so the reservation is released at once.
// BLOCKED/ACCOUNT_DATA_UNAVAILABLE/DUPLICATE_BLOCKED/BELOW_LOT_STEP: the order was
// never sent. REJECTED/CANCELED/EXPIRED/FAILED: the broker refused it, which it
// states as a final status, so nothing can appear on the book later.
//
// 2026-09-22: REJECTED was missing here. Rejected entries were held for the full
// TTL waiting for a fill that could never arrive, so a retrying ring consumed the
// pool with failures: $2,100 of a $2,200 pool reserved against $0 of real exposure.
// PARTIAL stays out deliberately — part of it DID fill.
const NEVER_SENT = new Set([
  "BLOCKED", "ACCOUNT_DATA_UNAVAILABLE", "DUPLICATE_BLOCKED", "BELOW_LOT_STEP",
  "REJECTED", "CANCELED", "EXPIRED", "FAILED"
]);

function positive(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`${name} must be a positive number`);
  return n;
}

function fixed2(value) {
  return Number(Number(value).toFixed(2));
}

export function createExposureGate({
  softUsd,
  hardUsd,
  readExposure,
  notifications = null,
  addEvent = async () => {},
  now = () => Date.now(),
  filledReservationTtlMs = DEFAULT_FILLED_RESERVATION_TTL_MS,
  snapshotMarginMs = DEFAULT_SNAPSHOT_MARGIN_MS
}) {
  const soft = positive("softUsd", softUsd);
  const hard = positive("hardUsd", hardUsd);
  if (!(soft < hard)) throw new TypeError("softUsd must be below hardUsd");
  if (typeof readExposure !== "function") throw new TypeError("readExposure must be a function");
  if (typeof addEvent !== "function") throw new TypeError("addEvent must be a function");

  // id -> { instrument, notionalUsd, createdAtMs, filledAtMs|null }
  const reservations = new Map();
  let nextId = 1;

  let closed = null;            // { sinceMs, refusals, exposureUsd } while entries are refused at the soft ceiling
  let hardCrossRefusals = 0;    // lifetime count, for /status and logs
  let dataUnavailableRefusals = 0;

  function safeAudit(level, kind, payload) {
    try {
      const pending = addEvent(level, kind, payload);
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
    } catch {
      // Logging must never interfere with the entry decision.
    }
  }

  function safeEnqueue(event) {
    try {
      notifications?.enqueue?.(event);
    } catch {
      // Alerting must never interfere with the entry decision.
    }
  }

  function prune(snapshotAtMs) {
    const t = now();
    for (const [id, r] of reservations) {
      // Backstop: a ticket nobody settled is treated as filled at creation, so a
      // missed settle() can delay entries by one TTL but never choke the pool forever.
      if (r.filledAtMs === null && t - r.createdAtMs >= filledReservationTtlMs) r.filledAtMs = r.createdAtMs;
      if (r.filledAtMs === null) continue;
      const seenByBroker = Number.isFinite(snapshotAtMs) && snapshotAtMs >= r.filledAtMs + snapshotMarginMs;
      const expired = t - r.filledAtMs >= filledReservationTtlMs;
      if (seenByBroker || expired) reservations.delete(id);
    }
  }

  function reservedUsd() {
    let sum = 0;
    for (const r of reservations.values()) sum += r.notionalUsd;
    return sum;
  }

  /**
   * Decide one entry. Synchronous on purpose: the check and the reservation happen
   * in the same turn of the event loop, so two books cannot both claim the same room.
   *
   * Returns { allowed, reason, exposureUsd, ticket }. Pass the ticket to settle().
   */
  function requestEntry({ instrument, notionalUsd, orderCode = null }) {
    const notional = Number(notionalUsd);
    if (!Number.isFinite(notional) || notional <= 0) {
      return Object.freeze({ allowed: false, reason: "INVALID_NOTIONAL", exposureUsd: null, ticket: null });
    }

    let broker;
    try {
      broker = readExposure();
    } catch {
      broker = null;
    }
    const brokerUsd = Number(broker?.exposureUsd);
    if (!broker || !Number.isFinite(brokerUsd) || brokerUsd < 0) {
      dataUnavailableRefusals += 1;
      safeAudit("WARN", "EXPOSURE_GATE_REFUSED_DATA_UNAVAILABLE", { instrument, orderCode, notionalUsd: fixed2(notional) });
      return Object.freeze({ allowed: false, reason: "ACCOUNT_DATA_UNAVAILABLE", exposureUsd: null, ticket: null });
    }

    prune(Number(broker.observedAtMs));
    const exposure = brokerUsd + reservedUsd();

    if (exposure >= soft) {
      const firstRefusal = closed === null;
      if (firstRefusal) closed = { sinceMs: now(), refusals: 0, exposureUsd: exposure };
      closed.refusals += 1;
      safeAudit("WARN", "EXPOSURE_GATE_REFUSED_SOFT_CEILING", {
        instrument, orderCode,
        notionalUsd: fixed2(notional),
        exposureUsd: fixed2(exposure),
        softUsd: soft,
        refusalsThisEpisode: closed.refusals
      });
      if (firstRefusal) {
        safeEnqueue({
          kind: "EXPOSURE_GATE_CLOSED",
          eventKey: `EXPOSURE-CLOSED:${closed.sinceMs}`,
          exposureUsd: fixed2(exposure),
          softUsd: soft,
          hardUsd: hard,
          instrument,
          notionalUsd: fixed2(notional)
        });
      }
      return Object.freeze({ allowed: false, reason: "AT_SOFT_CEILING", exposureUsd: fixed2(exposure), ticket: null });
    }

    if (exposure + notional > hard) {
      hardCrossRefusals += 1;
      safeAudit("INFO", "EXPOSURE_GATE_REFUSED_WOULD_CROSS_HARD", {
        instrument, orderCode,
        notionalUsd: fixed2(notional),
        exposureUsd: fixed2(exposure),
        hardUsd: hard
      });
      return Object.freeze({ allowed: false, reason: "WOULD_CROSS_HARD_CEILING", exposureUsd: fixed2(exposure), ticket: null });
    }

    // Allowed. If the gate had been closed, this is the moment it reopened.
    if (closed !== null) {
      const episode = closed;
      closed = null;
      safeAudit("INFO", "EXPOSURE_GATE_REOPENED", {
        exposureUsd: fixed2(exposure),
        closedForMs: now() - episode.sinceMs,
        refusals: episode.refusals
      });
      safeEnqueue({
        kind: "EXPOSURE_GATE_REOPENED",
        eventKey: `EXPOSURE-REOPENED:${episode.sinceMs}`,
        exposureUsd: fixed2(exposure),
        softUsd: soft,
        closedForMs: now() - episode.sinceMs,
        refusals: episode.refusals
      });
    }

    const id = nextId;
    nextId += 1;
    reservations.set(id, { instrument, notionalUsd: notional, createdAtMs: now(), filledAtMs: null });
    return Object.freeze({ allowed: true, reason: "ALLOWED", exposureUsd: fixed2(exposure), ticket: id });
  }

  /**
   * Record what happened to an allowed entry. Must be called exactly once per
   * allowed ticket, including when placing the order throws.
   */
  function settle(ticket, { status } = {}) {
    const r = reservations.get(ticket);
    if (!r) return;
    if (NEVER_SENT.has(status)) {
      reservations.delete(ticket);
      return;
    }
    // FILLED, or anything that might have filled: hold it until the broker shows it.
    r.filledAtMs = now();
  }

  function getSnapshot() {
    // 2026-09-22. prune() used to run only inside requestEntry, so between entries
    // /status kept showing the reservation of an order that had already filled —
    // $103.68 of AVAX counted twice, once as broker exposure and once as "awaiting
    // broker confirmation", for minutes. The gate's own decisions were always correct
    // (it prunes before every one); only the display was stale. Pruning here with no
    // snapshot time releases on the TTL alone, which is the conservative direction.
    prune(NaN);
    return Object.freeze({
      softUsd: soft,
      hardUsd: hard,
      reservedUsd: fixed2(reservedUsd()),
      openReservations: reservations.size,
      closed: closed !== null,
      closedSinceMs: closed?.sinceMs ?? null,
      refusalsThisEpisode: closed?.refusals ?? 0,
      hardCrossRefusals,
      dataUnavailableRefusals
    });
  }

  return Object.freeze({ requestEntry, settle, getSnapshot });
}

function usd(value) {
  return `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * The /status line for the exposure pool.
 *
 * State is derived from the live numbers, not from whether an entry has been refused
 * yet: price moves alone can push exposure over the soft ceiling, and /status should
 * say FULL then too.
 *
 *   gate            the gate (or null when the active profile sets no pool)
 *   readExposure    the same function the gate uses; may throw when broker data is bad
 */
export function formatExposurePoolLine({ gate, readExposure, now = () => Date.now() }) {
  if (!gate) return "  exposure pool: not set in this account profile (new entries are not limited by account exposure)";
  const snap = gate.getSnapshot();
  let brokerUsd = null;
  try {
    const value = Number(readExposure?.()?.exposureUsd);
    brokerUsd = Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    brokerUsd = null;
  }
  const limits = `soft ${usd(snap.softUsd)} / hard ${usd(snap.hardUsd)}`;
  if (brokerUsd === null) {
    return `  exposure pool: UNKNOWN (broker account data unavailable) · ${limits} · new entries refused`;
  }
  const exposure = brokerUsd + snap.reservedUsd;
  const pending = snap.reservedUsd > 0 ? ` (incl. ${usd(snap.reservedUsd)} awaiting broker confirmation)` : "";
  const pct = Math.round((exposure / snap.softUsd) * 100);
  if (exposure >= snap.softUsd) {
    const since = snap.closed && Number.isFinite(snap.closedSinceMs)
      ? ` · paused ${Math.max(0, Math.round((now() - snap.closedSinceMs) / 60_000))}m, ${snap.refusalsThisEpisode} refused`
      : "";
    return `  exposure pool: ${usd(exposure)}${pending} of ${limits} · FULL, new entries refused${since}`;
  }
  const largest = Math.max(0, snap.hardUsd - exposure);
  return `  exposure pool: ${usd(exposure)}${pending} of ${limits} (${pct}%) · OPEN · largest entry that fits now: ${usd(largest)}`;
}
