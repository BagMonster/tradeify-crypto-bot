/**
 * src/risk/riskSupervisor.js
 *
 * D-060: the account-level risk ladder.
 *
 * Three rungs, evaluated in this order:
 *
 *   1. FULL FLATTEN   combined day P&L <= -fullFlattenUsd
 *   2. PARTIAL CUT    combined day P&L <= -partialCutUsd
 *   3. ENTRY BRAKE    per instrument on that instrument's own day P&L
 *
 * An unreadable book is not a flat book. Flatten and cut still wait until every
 * book can be read. Entries are different: only the unreadable book is paused,
 * and that pause is transient. It is not recorded as "braked today". When the
 * snapshot is readable again and that book has not lost -$entryBrakeUsd, entries
 * resume. A real -$300 brake, or a flatten, still holds until rollover.
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

export function allocateProportionalCut(instrumentLosses, partialCutFraction) {
  const losses = instrumentLosses.map((entry) => Object.freeze({
    instrument: entry.instrument,
    loss: Math.max(0, -Number(entry.unrealisedUsd ?? 0))
  }));
  const lossSum = losses.reduce((sum, entry) => sum + entry.loss, 0);
  if (lossSum <= 0) return Object.freeze([]);

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
  // D-063: an ordered ladder of cut tiers, deepest first. The legacy single
  // partialCutUsd/partialCutFraction pair remains the deepest tier, so an absent
  // cutTiers array reproduces the previous behaviour exactly.
  const cutTiers = Object.freeze(
    (Array.isArray(config.cutTiers) ? config.cutTiers : [])
      .map((tier, i) => {
        const thresholdUsd = Number(tier?.thresholdUsd);
        const fraction = Number(tier?.fraction);
        if (!Number.isFinite(thresholdUsd) || thresholdUsd <= 0) throw new TypeError(`cutTiers[${i}].thresholdUsd must be positive`);
        if (!(fraction > 0) || fraction > 1) throw new TypeError(`cutTiers[${i}].fraction must be between 0 and 1`);
        return Object.freeze({ thresholdUsd, fraction });
      })
      .concat([{ thresholdUsd: Number(config.partialCutUsd), fraction: Number(config.partialCutFraction) }])
      .sort((a, b) => b.thresholdUsd - a.thresholdUsd)
  );
  const partialCutFraction = Number(config.partialCutFraction);
  if (!(partialCutFraction > 0) || partialCutFraction > 1) {
    throw new TypeError("partialCutFraction must be between 0 and 1");
  }
  if (!(partialCutUsd < fullFlattenUsd)) {
    throw new TypeError("partialCutUsd must be smaller than fullFlattenUsd");
  }
  for (let i = 0; i < cutTiers.length - 1; i += 1) {
    if (!(cutTiers[i].thresholdUsd > cutTiers[i + 1].thresholdUsd)) {
      throw new TypeError("cutTiers thresholds must be strictly decreasing after the deepest tier");
    }
  }
  if (cutTiers[0].thresholdUsd >= fullFlattenUsd) {
    throw new TypeError("the deepest cut tier must trigger before the full flatten");
  }
  // No ordering is required between cut tiers and the entry brake: the brake is
  // measured on ONE instrument's day P&L, the cut on the COMBINED account. A shallow
  // tier firing before the brake is a valid and intended configuration.
  if (!(fullFlattenUsd < dailyLossLimitUsd)) {
    throw new TypeError("fullFlattenUsd must be smaller than dailyLossLimitUsd");
  }

  let dayKey = null;
  let flattenedToday = false;
  let cutsToday = 0;
  const brakedToday = new Set();
  let evaluating = false;
  let lastError = null;

  function stickyBrake(instrument) {
    return flattenedToday === true || brakedToday.has(instrument);
  }

  function applyEntryBrake(book, on) {
    try {
      book.setEntryBrake(on === true);
    } catch {
      // a book that cannot accept the flag stays in the last known state
    }
  }

  function rollover(nextDayKey) {
    dayKey = nextDayKey;
    flattenedToday = false;
    cutsToday = 0;
    brakedToday.clear();
    for (const book of instruments) applyEntryBrake(book, false);
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
      const unreadable = readings.filter((r) => r.readFailed);
      if (unreadable.length > 0) {
        for (const reading of readings) {
          applyEntryBrake(reading.book, stickyBrake(reading.instrument) || reading.readFailed);
        }
        lastError = `Cannot read ${unreadable.map((r) => r.instrument).join(", ")}`;
        await addEvent("ERROR", "RISK_SUPERVISOR_ACCOUNT_DATA_UNAVAILABLE", {
          instruments: unreadable.map((r) => r.instrument)
        });
        return Object.freeze({ action: "ACCOUNT_DATA_UNAVAILABLE", instruments: unreadable.map((r) => r.instrument) });
      }
      lastError = null;

      const combined = fixed2(readings.reduce((sum, r) => sum + r.dayPnlUsd, 0));

      if (combined <= -fullFlattenUsd) {
        if (flattenedToday) return Object.freeze({ action: "ALREADY_FLATTENED", combinedDayPnlUsd: combined });
        flattenedToday = true;
        const results = [];
        for (const reading of readings) {
          applyEntryBrake(reading.book, true);
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

      const activeTier = cutTiers.find((tier) => combined <= -tier.thresholdUsd) ?? null;
      if (activeTier) {
        const allocations = allocateProportionalCut(
          readings.map((r) => ({ instrument: r.instrument, unrealisedUsd: r.unrealisedUsd })),
          activeTier.fraction
        );
        if (allocations.length === 0) {
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
                  reason: `D-063 tier cut ${(activeTier.fraction * 100).toFixed(0)}% at ${combined.toFixed(2)} (threshold -${activeTier.thresholdUsd}, share ${(allocation.share * 100).toFixed(1)}%)`,
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
            threshold: -activeTier.thresholdUsd,
            tierFraction: activeTier.fraction,
            cutNumber: cutsToday,
            allocations: results.map((r) => ({ instrument: r.instrument, fraction: r.fraction, status: r.result?.status ?? "UNKNOWN" }))
          });
          return Object.freeze({ action: "CUT", combinedDayPnlUsd: combined, tier: activeTier, results: Object.freeze(results) });
        }
      }

      const newlyBraked = [];
      for (const reading of readings) {
        if (brakedToday.has(reading.instrument)) continue;
        if (reading.dayPnlUsd <= -entryBrakeUsd) {
          brakedToday.add(reading.instrument);
          applyEntryBrake(reading.book, true);
          newlyBraked.push(reading.instrument);
        }
      }

      for (const reading of readings) {
        if (!stickyBrake(reading.instrument)) applyEntryBrake(reading.book, false);
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
      cutTiers,
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
