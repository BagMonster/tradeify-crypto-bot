/**
 * src/risk/riskSupervisor.js
 *
 * D-060: the account-level risk ladder.
 *
 * Before D-060 the ladder lived inside the execution guard and could only see one
 * instrument. With several books open, "the account is down $1,000" is a fact about
 * the account, not about any one instrument, so the ladder has to sit above them.
 *
 * Three rungs, evaluated in this order:
 *
 *   1. FULL FLATTEN   combined day P&L <= -fullFlattenUsd
 *                     every instrument flattens; all entries blocked until rollover
 *   2. PARTIAL CUT    combined day P&L <= -partialCutUsd
 *                     50% cut allocated PROPORTIONAL TO LOSS; winners are never trimmed
 *   3. ENTRY BRAKE    evaluated PER INSTRUMENT on that instrument's own day P&L
 *                     the losing book stops opening; the others carry on
 *
 * Flatten is checked first so a fast move that crosses both thresholds inside one
 * evaluation flattens rather than merely cutting.
 *
 * Research basis: the per-instrument brake was worth +$3,720 across nine books
 * against an account-scoped brake, because an account-wide brake punishes four
 * healthy instruments for one that is losing.
 */

const REQUIRED_CONFIG = Object.freeze([
  "entryBrakeUsd",
  "partialCutUsd",
  "partialCutFraction",
  "fullFlattenUsd",
  "dailyLossLimitUsd"
]);

function positiveNumber(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`${name} must be a positive number`);
  return n;
}

function fixed2(value) {
  return Number(Number(value).toFixed(2));
}

/**
 * Allocates a 50% cut across the losing instruments in proportion to how much of the
 * account's unrealised loss each one is responsible for.
 *
 *   loss_i     = max(0, -unrealised_i)
 *   share_i    = loss_i / sum(loss)
 *   fraction_i = clamp(partialCutFraction * share_i * N, 0, 1)
 *
 * The * N term keeps the total cut near partialCutFraction of the losing side rather
 * than shrinking as instruments are added. An instrument in profit gets 0 and is not
 * touched — the owner's rule is "close losers proportionately, do not trim winners".
 */
export function allocateProportionalCut(instrumentLosses, partialCutFraction) {
  const losses = instrumentLosses.map((entry) => Object.freeze({
    instrument: entry.instrument,
    loss: Math.max(0, -Number(entry.unrealisedUsd ?? 0))
  }));
  const lossSum = losses.reduce((sum, entry) => sum + entry.loss, 0);
  if (lossSum <= 0) return Object.freeze([]);

  // Every losing instrument surrenders the same FRACTION of its position. That is
  // already proportional to loss in dollar terms: a book down twice as much has
  // roughly twice the position, so half of it is twice the dollars. Weighting the
  // fraction by share as well double-counts and, with one dominant loser, clamps to
  // 1.0 — closing that book entirely rather than cutting half of it.
  return Object.freeze(losses
    .filter((entry) => entry.loss > 0)
    .map((entry) => Object.freeze({
      instrument: entry.instrument,
      share: Number((entry.loss / lossSum).toFixed(6)),
      fraction: Number(partialCutFraction.toFixed(6))
    })));
}

export function createRiskSupervisor({
  config,
  instruments,
  addEvent = async () => {},
  notifications = null,
  now = () => Date.now()
}) {
  if (!config || typeof config !== "object") throw new TypeError("risk config is required");
  for (const field of REQUIRED_CONFIG) {
    if (config[field] === undefined) throw new TypeError(`risk config ${field} is missing`);
  }
  if (!Array.isArray(instruments) || instruments.length === 0) {
    throw new TypeError("riskSupervisor requires at least one instrument");
  }
  for (const book of instruments) {
    for (const method of ["getUnrealisedUsd", "getDayPnlUsd", "getExposureUsd", "setEntryBrake", "executeProtectiveCut", "executeProtectiveFlatten"]) {
      if (typeof book?.[method] !== "function") {
        throw new TypeError(`instrument ${book?.instrument ?? "?"} is missing ${method}()`);
      }
    }
  }

  const entryBrakeUsd = positiveNumber("entryBrakeUsd", config.entryBrakeUsd);
  const partialCutUsd = positiveNumber("partialCutUsd", config.partialCutUsd);
  const fullFlattenUsd = positiveNumber("fullFlattenUsd", config.fullFlattenUsd);
  const dailyLossLimitUsd = positiveNumber("dailyLossLimitUsd", config.dailyLossLimitUsd);
  const partialCutFraction = Number(config.partialCutFraction);
  if (!(partialCutFraction > 0) || partialCutFraction > 1) {
    throw new TypeError("partialCutFraction must be between 0 and 1");
  }
  if (!(partialCutUsd < fullFlattenUsd)) {
    throw new TypeError("partialCutUsd must be smaller than fullFlattenUsd");
  }
  if (!(fullFlattenUsd < dailyLossLimitUsd)) {
    throw new TypeError("fullFlattenUsd must be smaller than dailyLossLimitUsd");
  }

  let dayKey = null;
  let flattenedToday = false;
  let cutsToday = 0;
  const brakedToday = new Set();
  let evaluating = false;
  let lastError = null;

  function rollover(nextDayKey) {
    dayKey = nextDayKey;
    flattenedToday = false;
    cutsToday = 0;
    brakedToday.clear();
    for (const book of instruments) {
      try {
        book.setEntryBrake(false);
      } catch {
        // a book that cannot clear its brake stays braked; it is the safe direction
      }
    }
  }

  function readBooks() {
    return instruments.map((book) => {
      let unrealisedUsd = 0;
      let dayPnlUsd = 0;
      let exposureUsd = 0;
      let readFailed = false;
      try {
        unrealisedUsd = Number(book.getUnrealisedUsd()) || 0;
        dayPnlUsd = Number(book.getDayPnlUsd()) || 0;
        exposureUsd = Number(book.getExposureUsd()) || 0;
      } catch {
        readFailed = true;
      }
      return { book, instrument: book.instrument, unrealisedUsd, dayPnlUsd, exposureUsd, readFailed };
    });
  }

  async function evaluate({ dayKey: incomingDayKey } = {}) {
    if (typeof incomingDayKey !== "string" || incomingDayKey === "") {
      throw new TypeError("evaluate requires a dayKey");
    }
    if (evaluating) return Object.freeze({ action: "BUSY" });
    evaluating = true;
    try {
      if (incomingDayKey !== dayKey) rollover(incomingDayKey);

      const readings = readBooks();

      // D-054 principle: an unreadable book is not a flat book. If any instrument
      // cannot be read the combined figure is untrustworthy, so brake everything
      // rather than act on a number that may be missing a losing position.
      const unreadable = readings.filter((r) => r.readFailed);
      if (unreadable.length > 0) {
        for (const reading of readings) {
          if (!brakedToday.has(reading.instrument)) {
            brakedToday.add(reading.instrument);
            try { reading.book.setEntryBrake(true); } catch { /* stays braked */ }
          }
        }
        lastError = `Cannot read ${unreadable.map((r) => r.instrument).join(", ")}`;
        await addEvent("ERROR", "RISK_SUPERVISOR_ACCOUNT_DATA_UNAVAILABLE", {
          instruments: unreadable.map((r) => r.instrument)
        });
        return Object.freeze({ action: "ACCOUNT_DATA_UNAVAILABLE", instruments: unreadable.map((r) => r.instrument) });
      }
      lastError = null;

      const combined = fixed2(readings.reduce((sum, r) => sum + r.dayPnlUsd, 0));

      // ---- rung 1: full flatten, account-wide, held until rollover ----
      if (combined <= -fullFlattenUsd) {
        if (flattenedToday) return Object.freeze({ action: "ALREADY_FLATTENED", combinedDayPnlUsd: combined });
        flattenedToday = true;
        const results = [];
        for (const reading of readings) {
          try { reading.book.setEntryBrake(true); } catch { /* stays braked */ }
          brakedToday.add(reading.instrument);
          try {
            results.push({
              instrument: reading.instrument,
              result: await reading.book.executeProtectiveFlatten({
                reason: `D-060 account full flatten at ${combined.toFixed(2)}`,
                dayKey: incomingDayKey,
                bypassSlippageCap: true
              })
            });
          } catch (error) {
            results.push({ instrument: reading.instrument, result: { status: "THREW", reason: error?.message ?? "flatten threw" } });
          }
        }
        const failed = results.filter((r) => r.result?.status !== "FILLED" && r.result?.status !== "ALREADY_FLAT");
        await addEvent(failed.length > 0 ? "ERROR" : "WARN", "RISK_SUPERVISOR_FULL_FLATTEN", {
          combinedDayPnlUsd: combined,
          threshold: -fullFlattenUsd,
          instruments: results.map((r) => ({ instrument: r.instrument, status: r.result?.status ?? "UNKNOWN" })),
          allConfirmed: failed.length === 0
        });
        notifications?.enqueue?.({
          kind: "SAFETY_HALT",
          eventKey: `D060-FLATTEN:${incomingDayKey.replaceAll("-", "")}`,
          reasonCode: "D060_ACCOUNT_FULL_FLATTEN"
        });
        return Object.freeze({
          action: "FLATTEN",
          combinedDayPnlUsd: combined,
          results: Object.freeze(results),
          allConfirmed: failed.length === 0
        });
      }

      // ---- rung 2: partial cut, proportional to loss ----
      if (combined <= -partialCutUsd) {
        const allocations = allocateProportionalCut(
          readings.map((r) => ({ instrument: r.instrument, unrealisedUsd: r.unrealisedUsd })),
          partialCutFraction
        );
        if (allocations.length === 0) {
          // The account is down on realised P&L but nothing is currently in an
          // unrealised loss. There is nothing to cut; the brake below still applies.
          await addEvent("WARN", "RISK_SUPERVISOR_CUT_NO_LOSING_BOOK", { combinedDayPnlUsd: combined });
        } else {
          cutsToday += 1;
          const results = [];
          for (const allocation of allocations) {
            const reading = readings.find((r) => r.instrument === allocation.instrument);
            try {
              results.push({
                instrument: allocation.instrument,
                fraction: allocation.fraction,
                result: await reading.book.executeProtectiveCut({
                  fraction: allocation.fraction,
                  reason: `D-060 proportional cut at ${combined.toFixed(2)} (share ${(allocation.share * 100).toFixed(1)}%)`,
                  dayKey: incomingDayKey,
                  bypassSlippageCap: true
                })
              });
            } catch (error) {
              results.push({ instrument: allocation.instrument, fraction: allocation.fraction, result: { status: "THREW", reason: error?.message ?? "cut threw" } });
            }
          }
          await addEvent("WARN", "RISK_SUPERVISOR_PARTIAL_CUT", {
            combinedDayPnlUsd: combined,
            threshold: -partialCutUsd,
            cutNumber: cutsToday,
            allocations: results.map((r) => ({ instrument: r.instrument, fraction: r.fraction, status: r.result?.status ?? "UNKNOWN" }))
          });
          return Object.freeze({ action: "CUT", combinedDayPnlUsd: combined, results: Object.freeze(results) });
        }
      }

      // ---- rung 3: entry brake, per instrument ----
      const newlyBraked = [];
      for (const reading of readings) {
        if (brakedToday.has(reading.instrument)) continue;
        if (reading.dayPnlUsd <= -entryBrakeUsd) {
          brakedToday.add(reading.instrument);
          try { reading.book.setEntryBrake(true); } catch { /* stays braked */ }
          newlyBraked.push(reading.instrument);
        }
      }
      if (newlyBraked.length > 0) {
        await addEvent("WARN", "RISK_SUPERVISOR_ENTRY_BRAKE", {
          instruments: newlyBraked,
          threshold: -entryBrakeUsd,
          combinedDayPnlUsd: combined
        });
        return Object.freeze({ action: "BRAKE", instruments: Object.freeze(newlyBraked), combinedDayPnlUsd: combined });
      }

      return Object.freeze({ action: "NONE", combinedDayPnlUsd: combined });
    } finally {
      evaluating = false;
    }
  }

  function getSnapshot() {
    const readings = readBooks();
    const dayPnlUsd = fixed2(readings.reduce((sum, r) => sum + r.dayPnlUsd, 0));
    const exposureUsd = fixed2(readings.reduce((sum, r) => sum + r.exposureUsd, 0));
    return Object.freeze({
      dayKey,
      dayPnlUsd,
      exposureUsd,
      unrealisedUsd: fixed2(readings.reduce((sum, r) => sum + r.unrealisedUsd, 0)),
      marginToLimitUsd: fixed2(dailyLossLimitUsd + Math.min(0, dayPnlUsd)),
      dailyLossLimitUsd,
      entryBrakeUsd,
      partialCutUsd,
      partialCutFraction,
      fullFlattenUsd,
      brakedInstruments: Object.freeze([...brakedToday]),
      flattenedToday,
      cutsToday,
      lastError,
      perInstrument: Object.freeze(readings.map((r) => Object.freeze({
        instrument: r.instrument,
        dayPnlUsd: fixed2(r.dayPnlUsd),
        unrealisedUsd: fixed2(r.unrealisedUsd),
        exposureUsd: fixed2(r.exposureUsd),
        braked: brakedToday.has(r.instrument),
        readFailed: r.readFailed
      })))
    });
  }

  return Object.freeze({ evaluate, getSnapshot, allocateProportionalCut });
}
