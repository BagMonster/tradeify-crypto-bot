// Hybrid-mode absorption engine.
//
// Takes the verdicts from hybridReconciler and applies them to book state.
// Every dependency is injected so this can be exercised without a broker, a
// database or a clock.
//
// Safety properties this file is responsible for:
//
//  * Absorption never invents a price or a moving average. A book that cannot
//    supply a trustworthy MA does not adopt; it escalates instead.
//  * State is written with the optimistic-concurrency save the trading tick
//    already uses, so a concurrent write loses rather than corrupting. A lost
//    write leaves the watermark unmoved and the same divergence is re-detected
//    on the next pass.
//  * The watermark advances only after the state write succeeds. An absorption
//    that half-applies is therefore repeated, not skipped.

import { classifyBooks, summarize, VERDICT } from "./hybridReconciler.js";

export const ABSORB_RESULT = Object.freeze({
  APPLIED: "APPLIED",
  SKIPPED: "SKIPPED",
  CONFLICT: "CONFLICT",
  FAILED: "FAILED",
  ESCALATED: "ESCALATED"
});

function text(value) {
  return value === null || value === undefined ? "" : String(value);
}

function finite(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * Apply one book's ABSORB decision to its grid state.
 *
 * @param decision   a classifyBook result with verdict ABSORB
 * @param book       { grid, stateStore, movingAverage }
 */
export async function absorbBook(decision, book) {
  const instrument = decision.instrument;
  const grid = book?.grid;
  const store = book?.stateStore;
  if (!grid || !store || typeof store.load !== "function" || typeof store.save !== "function") {
    return Object.freeze({ instrument, result: ABSORB_RESULT.FAILED, reason: "book has no usable state store" });
  }

  let state;
  try {
    state = await store.load();
  } catch (error) {
    return Object.freeze({ instrument, result: ABSORB_RESULT.FAILED, reason: `state load failed: ${text(error?.message ?? error)}` });
  }
  if (!state) {
    return Object.freeze({ instrument, result: ABSORB_RESULT.FAILED, reason: "grid state missing" });
  }

  const expectedVersion = grid.normalizeState(state).version;

  // An OPEN needs a moving average to compute tranche targets. Refusing to
  // adopt without one is deliberate: a wrong MA silently produces wrong exit
  // prices on a real position.
  const needsMa = decision.fills.some((fill) => fill.effect === "OPEN");
  const ma = needsMa ? finite(await (typeof book.movingAverage === "function" ? book.movingAverage() : book.movingAverage)) : null;
  if (needsMa && ma === null) {
    return Object.freeze({
      instrument,
      result: ABSORB_RESULT.ESCALATED,
      reason: "cannot adopt a manual position without a trustworthy moving average"
    });
  }

  const applied = [];
  let next = state;
  try {
    for (const fill of decision.fills) {
      if (fill.effect === "CLOSE") {
        next = grid.reduceLotByPositionCode(next, fill.positionCode, fill.units);
        applied.push({ effect: "CLOSE", positionCode: fill.positionCode, units: fill.units });
        continue;
      }
      next = grid.adoptPosition(next, {
        positionCode: fill.positionCode,
        side: fill.side,
        entryPrice: fill.price,
        originalUnits: fill.units,
        remainingUnits: fill.units,
        openedAt: fill.filledAt,
        ma
      });
      applied.push({ effect: "OPEN", positionCode: fill.positionCode, units: fill.units, entryPrice: fill.price });
    }
  } catch (error) {
    return Object.freeze({
      instrument,
      result: ABSORB_RESULT.ESCALATED,
      reason: `absorption rejected by the strategy: ${text(error?.message ?? error)}`
    });
  }

  if (applied.length === 0) {
    return Object.freeze({ instrument, result: ABSORB_RESULT.SKIPPED, reason: "nothing to apply" });
  }

  try {
    await store.save(expectedVersion, next);
  } catch (error) {
    // A version conflict means the trading tick wrote first. The divergence is
    // still there and will be classified again on the next pass.
    return Object.freeze({
      instrument,
      result: ABSORB_RESULT.CONFLICT,
      reason: `state write lost a race: ${text(error?.message ?? error)}`
    });
  }

  return Object.freeze({
    instrument,
    result: ABSORB_RESULT.APPLIED,
    applied: Object.freeze(applied),
    watermark: decision.watermark,
    lastPositionCode: decision.fills.at(-1).positionCode
  });
}

/**
 * Run one full reconciliation pass across every book.
 *
 * @param deps.inspectBooks        () => rows
 * @param deps.recentOrders        () => payload.orders
 * @param deps.knownClientOrderIds () => Set
 * @param deps.loadWatermarks      () => { [instrument]: { absorbedThrough } }
 * @param deps.saveWatermark       ({ instrument, absorbedThrough, lastPositionCode })
 * @param deps.books               Map|object instrument -> { grid, stateStore, movingAverage }
 * @param deps.absorbEnabled       boolean; false runs detection only
 */
export async function runReconciliationPass(deps) {
  const rows = await deps.inspectBooks();
  const orders = await deps.recentOrders();
  const known = await deps.knownClientOrderIds();
  const stored = await deps.loadWatermarks();

  const watermarks = {};
  for (const [instrument, record] of Object.entries(stored ?? {})) {
    watermarks[instrument] = record?.absorbedThrough ?? null;
  }

  const decisions = classifyBooks(rows, orders, { knownClientOrderIds: known, watermarks });
  const report = summarize(decisions);

  const absorbed = [];
  const escalations = decisions.filter((d) => d.verdict === VERDICT.UNEXPLAINED || d.verdict === VERDICT.UNREAD)
    .map((d) => Object.freeze({ instrument: d.instrument, verdict: d.verdict, reason: d.reason, delta: d.delta }));

  if (deps.absorbEnabled !== false) {
    for (const decision of decisions) {
      if (decision.verdict !== VERDICT.ABSORB) continue;
      const book = deps.books instanceof Map ? deps.books.get(decision.instrument) : deps.books?.[decision.instrument];
      const outcome = await absorbBook(decision, book);
      absorbed.push(outcome);
      if (outcome.result === ABSORB_RESULT.APPLIED) {
        await deps.saveWatermark({
          instrument: outcome.instrument,
          absorbedThrough: outcome.watermark,
          lastPositionCode: outcome.lastPositionCode
        });
      } else if (outcome.result === ABSORB_RESULT.ESCALATED || outcome.result === ABSORB_RESULT.FAILED) {
        escalations.push(Object.freeze({
          instrument: outcome.instrument,
          verdict: "ABSORB_FAILED",
          reason: outcome.reason,
          delta: decision.delta
        }));
      }
    }
  }

  // Two or more books in trouble at once is not a coincidence worth trading
  // through, and the halt-warning store holds only one cycle.
  const severity = escalations.length >= 2 ? "ACCOUNT_HALT" : escalations.length === 1 ? "BOOK_WARNING" : "NONE";

  return Object.freeze({
    decisions,
    matched: report.matched,
    absorbed: Object.freeze(absorbed),
    escalations: Object.freeze(escalations),
    severity,
    accountWide: escalations.length >= 2
  });
}
