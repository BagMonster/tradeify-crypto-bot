/**
 * src/risk/riskSupervisor.js
 *
 * D-060 account ladder plus D-064 session harvest.
 * Harvest is enabled from config/instruments.json (sessionHarvestEnabled).
 */

import { harvestReason, setTrancheExitsPausedAll } from "./sessionHarvest.js";

const DEFAULT_HARVEST_FRESH_DATA_GRACE_MS = 5 * 60 * 1000;

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
  harvestStore = null,
  getCombinedDayPnlUsd = null,
  setSafetyHalt = async () => {},
  clearSafetyHaltIfReason = async () => false,
  getSafetyHaltState = async () => null,
  requestHaltWarning = null,
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
  if (!(fullFlattenUsd < dailyLossLimitUsd)) {
    throw new TypeError("fullFlattenUsd must be smaller than dailyLossLimitUsd");
  }

  const sessionHarvestEnabled = config.sessionHarvestEnabled === true;
  const sessionHarvestUsd = sessionHarvestEnabled
    ? positiveNumber("sessionHarvestUsd", config.sessionHarvestUsd)
    : Number(config.sessionHarvestUsd);
  const sessionHarvestThreshold = sessionHarvestEnabled ? sessionHarvestUsd : 0;
  const configuredFreshDataGrace = Number(config.sessionHarvestFreshDataGraceMs);
  const sessionHarvestFreshDataGraceMs = sessionHarvestEnabled && Number.isFinite(configuredFreshDataGrace)
    ? positiveNumber("sessionHarvestFreshDataGraceMs", configuredFreshDataGrace)
    : DEFAULT_HARVEST_FRESH_DATA_GRACE_MS;
  if (sessionHarvestEnabled && (!harvestStore || typeof harvestStore.get !== "function" || typeof harvestStore.save !== "function")) {
    throw new TypeError("enabled session harvest requires a durable harvestStore");
  }

  let dayKey = null;
  let flattenedToday = false;
  let harvestState = null;
  let cutsToday = 0;
  const brakedToday = new Set();
  let evaluating = false;
  let hasSuccessfulRead = false;
  let lastError = null;
  let unreadSinceMs = null;

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

  function applyTrancheExitPause(on) {
    setTrancheExitsPausedAll(instruments.map((book) => book.instrument), on);
    for (const book of instruments) {
      if (typeof book.setTrancheExitsPaused !== "function") continue;
      try {
        book.setTrancheExitsPaused(on === true);
      } catch {
        // optional instance gate
      }
    }
  }

  function rollover(nextDayKey) {
    dayKey = nextDayKey;
    flattenedToday = false;
    // Force the first evaluation of the new account day to read PostgreSQL.
    // This preserves an already-confirmed/pending harvest across a Railway restart.
    harvestState = null;
    cutsToday = 0;
    brakedToday.clear();
    unreadSinceMs = null;
    for (const book of instruments) applyEntryBrake(book, false);
    applyTrancheExitPause(false);
  }

  async function loadHarvest(nextDayKey) {
    if (!sessionHarvestEnabled) return Object.freeze({ dayKey: nextDayKey, status: "READY", triggerPnlUsd: null, confirmedAt: null, haltReason: null });
    if (harvestState?.dayKey !== nextDayKey) harvestState = await harvestStore.get(nextDayKey);
    return harvestState;
  }

  async function saveHarvest(input) {
    harvestState = sessionHarvestEnabled
      ? await harvestStore.save(input)
      : Object.freeze(input);
    return harvestState;
  }

  function harvestBlocksNormalActions() {
    return harvestState?.status === "PENDING" || harvestState?.status === "HALTED";
  }

  function applyHarvestGates() {
    const pause = harvestState?.status === "PENDING" || harvestState?.status === "CONFIRMED" || harvestState?.status === "HALTED";
    applyTrancheExitPause(pause);
    if (harvestBlocksNormalActions()) for (const book of instruments) applyEntryBrake(book, true);
  }

  async function haltHarvest({ incomingDayKey, combinedDayPnlUsd = null, reason, details = null }) {
    const prior = await loadHarvest(incomingDayKey);
    if (prior.status === "HALTED") {
      applyHarvestGates();
      return prior;
    }
    const halted = await saveHarvest({
      dayKey: incomingDayKey,
      status: "HALTED",
      triggerPnlUsd: prior.triggerPnlUsd ?? (Number.isFinite(combinedDayPnlUsd) ? combinedDayPnlUsd : null),
      confirmedAt: null,
      haltReason: reason
    });
    applyHarvestGates();
    await setSafetyHalt(reason);
    await addEvent("ERROR", "D064_HARVEST_HALTED", {
      dayKey: incomingDayKey,
      reason,
      ...(details ?? {})
    });
    notifications?.enqueue?.({ kind: "HARVEST_HALTED", eventKey: `D064-HALTED:${incomingDayKey.replaceAll("-", "")}`, reason });
    return halted;
  }

  async function runHarvest({ incomingDayKey, combined, readings }) {
    const prior = await loadHarvest(incomingDayKey);
    if (prior.status === "CONFIRMED") {
      applyHarvestGates();
      return Object.freeze({ action: "NONE", combinedDayPnlUsd: combined, harvest: prior });
    }
    if (prior.status === "HALTED") {
      applyHarvestGates();
      return Object.freeze({ action: "HARVEST_HALTED", combinedDayPnlUsd: combined, harvest: prior });
    }
    const pending = prior.status === "PENDING"
      ? prior
      : await saveHarvest({ dayKey: incomingDayKey, status: "PENDING", triggerPnlUsd: combined, confirmedAt: null, haltReason: null });
    applyHarvestGates();
    if (prior.status !== "PENDING") {
      await addEvent("WARN", "D064_HARVEST_PENDING", { dayKey: incomingDayKey, combinedDayPnlUsd: combined, threshold: sessionHarvestThreshold });
      notifications?.enqueue?.({ kind: "HARVEST_PENDING", eventKey: `D064-PENDING:${incomingDayKey.replaceAll("-", "")}`, combinedDayPnlUsd: combined, thresholdUsd: sessionHarvestThreshold });
    }
    const results = [];
    for (const reading of readings) {
      try {
        results.push({ instrument: reading.instrument, result: await reading.book.executeProtectiveFlatten({ reason: harvestReason(combined, sessionHarvestThreshold), dayKey: incomingDayKey, bypassSlippageCap: true }) });
      } catch (error) {
        results.push({ instrument: reading.instrument, result: { status: "THREW", reason: error?.message ?? "harvest flatten threw" } });
      }
    }
    const terminal = results.filter((r) => !["FILLED", "ALREADY_FLAT", "PENDING", "SUBMITTED", "CLAIMED"].includes(r.result?.status));
    const pendingResults = results.filter((r) => ["PENDING", "SUBMITTED", "CLAIMED"].includes(r.result?.status));
    if (terminal.length > 0) {
      const reason = `D-064 harvest could not confirm every book flat; owner review required`;
      const halted = await haltHarvest({
        incomingDayKey,
        combinedDayPnlUsd: combined,
        reason,
        details: { instruments: results.map((r) => ({ instrument: r.instrument, status: r.result?.status ?? "UNKNOWN" })) }
      });
      return Object.freeze({ action: "HARVEST_HALTED", combinedDayPnlUsd: combined, results: Object.freeze(results), harvest: halted });
    }
    if (pendingResults.length > 0) return Object.freeze({ action: "HARVEST_PENDING", combinedDayPnlUsd: combined, results: Object.freeze(results), harvest: pending });
    const confirmed = await saveHarvest({ dayKey: incomingDayKey, status: "CONFIRMED", triggerPnlUsd: pending.triggerPnlUsd, confirmedAt: new Date(now()).toISOString(), haltReason: null });
    applyHarvestGates();
    for (const book of instruments) if (!stickyBrake(book.instrument)) applyEntryBrake(book, false);
    await addEvent("WARN", "D064_HARVEST_CONFIRMED", { dayKey: incomingDayKey, combinedDayPnlUsd: combined, threshold: sessionHarvestThreshold });
    notifications?.enqueue?.({ kind: "HARVEST_CONFIRMED", eventKey: `D064-CONFIRMED:${incomingDayKey.replaceAll("-", "")}`, combinedDayPnlUsd: combined, thresholdUsd: sessionHarvestThreshold, confirmedAt: confirmed.confirmedAt });
    return Object.freeze({ action: "HARVEST_CONFIRMED", combinedDayPnlUsd: combined, results: Object.freeze(results), harvest: confirmed });
  }

  async function executeFullFlatten({ incomingDayKey, combined, readings }) {
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
    return Object.freeze({ action: "FLATTEN", combinedDayPnlUsd: combined, results: Object.freeze(results), allConfirmed: failed.length === 0 });
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
      if (incomingDayKey !== dayKey) {
        const priorKey = dayKey;
        rollover(incomingDayKey);
        if (sessionHarvestEnabled && priorKey !== null) notifications?.enqueue?.({ kind: "HARVEST_RESET", eventKey: `D064-RESET:${incomingDayKey.replaceAll("-", "")}`, dayKey: incomingDayKey });
      }

      const readings = readBooks();
      const unreadable = readings.filter((r) => r.readFailed);
      if (unreadable.length > 0) {
        const nowMs = now();
        if (unreadSinceMs === null) {
          unreadSinceMs = nowMs;
          if (sessionHarvestEnabled && hasSuccessfulRead) {
            await addEvent("WARN", "D064_FRESH_DATA_GRACE_STARTED", {
              dayKey: incomingDayKey,
              instruments: unreadable.map((r) => r.instrument),
              graceMs: sessionHarvestFreshDataGraceMs
            });
            notifications?.enqueue?.({
              kind: "HARVEST_FRESHNESS_GRACE",
              eventKey: `D064-FRESH-GRACE:${incomingDayKey.replaceAll("-", "")}:${nowMs}`,
              instruments: unreadable.map((r) => r.instrument),
              graceMs: sessionHarvestFreshDataGraceMs
            });
          }
        }
        for (const reading of readings) {
          applyEntryBrake(
            reading.book,
            sessionHarvestEnabled ? true : (stickyBrake(reading.instrument) || reading.readFailed)
          );
        }
        lastError = `Cannot read ${unreadable.map((r) => r.instrument).join(", ")}`;
        await addEvent("ERROR", "RISK_SUPERVISOR_ACCOUNT_DATA_UNAVAILABLE", {
          instruments: unreadable.map((r) => r.instrument)
        });
        // Keep ordinary strategy actions fail-closed while broker data is
        // unreadable, but do not turn a one-poll delay into a durable,
        // account-wide D-064 halt.  A fresh read inside the configured grace
        // window clears this automatically.  An initial cold worker remains
        // blocked without creating an irreversible halt until it has ever read
        // a usable snapshot.
        const graceExpired = nowMs - unreadSinceMs >= sessionHarvestFreshDataGraceMs;
        if (sessionHarvestEnabled && hasSuccessfulRead && graceExpired) {
          const reason = `D-064 harvest cannot verify fresh broker account data for ${unreadable.map((r) => r.instrument).join(", ")}`;
          const halted = await haltHarvest({
            incomingDayKey,
            reason,
            details: { instruments: unreadable.map((r) => ({ instrument: r.instrument, status: "ACCOUNT_DATA_UNAVAILABLE" })) }
          });
          return Object.freeze({ action: "HARVEST_HALTED", instruments: unreadable.map((r) => r.instrument), harvest: halted });
        }
        return Object.freeze({
          action: "ACCOUNT_DATA_UNAVAILABLE",
          instruments: unreadable.map((r) => r.instrument),
          graceRemainingMs: Math.max(0, sessionHarvestFreshDataGraceMs - (nowMs - unreadSinceMs))
        });
      }
      lastError = null;
      hasSuccessfulRead = true;
      unreadSinceMs = null;

      const suppliedCombined = typeof getCombinedDayPnlUsd === "function" ? Number(getCombinedDayPnlUsd()) : NaN;
      const combined = fixed2(Number.isFinite(suppliedCombined) ? suppliedCombined : readings.reduce((sum, r) => sum + r.dayPnlUsd, 0));
      await loadHarvest(incomingDayKey);
      applyHarvestGates();

      if (combined <= -fullFlattenUsd) {
        if (flattenedToday) return Object.freeze({ action: "ALREADY_FLATTENED", combinedDayPnlUsd: combined });
        if (typeof requestHaltWarning === "function") {
          const warning = await requestHaltWarning({
            key: `D060_ACCOUNT_FULL_FLATTEN:${incomingDayKey}`,
            reasonCode: "D060_ACCOUNT_FULL_FLATTEN",
            reason: `Account-day P&L is ${combined.toFixed(2)}, at or below the -${fullFlattenUsd.toFixed(2)} full-flatten threshold.`,
            correction: "Inspect /status and DXtrade. Send /pausehalt to defer the account flatten for another 25-minute warning cycle."
          });
          return Object.freeze({ action: "HALT_WARNING_PENDING", combinedDayPnlUsd: combined, warning });
        }
        return executeFullFlatten({ incomingDayKey, combined, readings });
      }

      if (harvestBlocksNormalActions()) return runHarvest({ incomingDayKey, combined, readings });

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

      if (sessionHarvestEnabled && combined >= sessionHarvestThreshold) return runHarvest({ incomingDayKey, combined, readings });

      return Object.freeze({ action: "NONE", combinedDayPnlUsd: combined });
    } finally {
      evaluating = false;
    }
  }

  async function recoverHarvest({ dayKey: incomingDayKey, booksVerified = false } = {}) {
    if (!sessionHarvestEnabled) return Object.freeze({ action: "HARVEST_DISABLED" });
    if (typeof incomingDayKey !== "string" || incomingDayKey === "") throw new TypeError("recoverHarvest requires a dayKey");
    if (booksVerified !== true) return Object.freeze({ action: "HARVEST_RECOVERY_REFUSED" });
    if (incomingDayKey !== dayKey) rollover(incomingDayKey);
    const prior = await loadHarvest(incomingDayKey);
    if (prior.status !== "HALTED") return Object.freeze({ action: "HARVEST_NOT_HALTED", harvest: prior });
    // A failed flatten or any other D-064 halt is manual-review only. This path
    // exists solely for the false initial-read halt that can occur while startup
    // snapshots are still cold.
    if (typeof prior.haltReason !== "string" || !prior.haltReason.startsWith("D-064 harvest cannot verify fresh broker account data for ")) {
      return Object.freeze({ action: "HARVEST_RECOVERY_REFUSED", harvest: prior });
    }
    const readings = readBooks();
    if (readings.some((reading) => reading.readFailed)) return Object.freeze({ action: "ACCOUNT_DATA_UNAVAILABLE", harvest: prior });
    let combined;
    try {
      const supplied = typeof getCombinedDayPnlUsd === "function" ? Number(getCombinedDayPnlUsd()) : NaN;
      combined = fixed2(Number.isFinite(supplied) ? supplied : readings.reduce((sum, reading) => sum + reading.dayPnlUsd, 0));
    } catch {
      return Object.freeze({ action: "ACCOUNT_DATA_UNAVAILABLE", harvest: prior });
    }
    const safety = await getSafetyHaltState();
    if (safety?.safety_halt === true) {
      // Compare and clear atomically: recovery cannot erase a newer, unrelated
      // safety halt that arrived after the owner requested this confirmation.
      if (safety.halt_reason !== prior.haltReason) return Object.freeze({ action: "HARVEST_RECOVERY_REFUSED", harvest: prior });
      const cleared = await clearSafetyHaltIfReason(prior.haltReason);
      if (!cleared) return Object.freeze({ action: "HARVEST_RECOVERY_REFUSED", harvest: prior });
    }
    await saveHarvest({ dayKey: incomingDayKey, status: "READY", triggerPnlUsd: null, confirmedAt: null, haltReason: null });
    applyHarvestGates();
    hasSuccessfulRead = true;
    return evaluate({ dayKey: incomingDayKey });
  }

  async function executeDeferredFullFlatten({ dayKey: incomingDayKey } = {}) {
    if (typeof incomingDayKey !== "string" || incomingDayKey === "") throw new TypeError("executeDeferredFullFlatten requires a dayKey");
    if (incomingDayKey !== dayKey) rollover(incomingDayKey);
    const readings = readBooks();
    if (readings.some((reading) => reading.readFailed)) return Object.freeze({ action: "NO_LONGER_REQUIRED" });
    const supplied = typeof getCombinedDayPnlUsd === "function" ? Number(getCombinedDayPnlUsd()) : NaN;
    const combined = fixed2(Number.isFinite(supplied) ? supplied : readings.reduce((sum, reading) => sum + reading.dayPnlUsd, 0));
    if (combined > -fullFlattenUsd) return Object.freeze({ action: "NO_LONGER_REQUIRED", combinedDayPnlUsd: combined });
    return executeFullFlatten({ incomingDayKey, combined, readings });
  }

  function getSnapshot() {
    const readings = readBooks();
    const suppliedCombined = typeof getCombinedDayPnlUsd === "function" ? Number(getCombinedDayPnlUsd()) : NaN;
    const dayPnlUsd = fixed2(Number.isFinite(suppliedCombined) ? suppliedCombined : readings.reduce((sum, r) => sum + r.dayPnlUsd, 0));
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
      harvest: harvestState,
      sessionHarvestEnabled,
      sessionHarvestUsd: sessionHarvestEnabled ? sessionHarvestThreshold : null,
      sessionHarvestFreshDataGraceMs: sessionHarvestEnabled ? sessionHarvestFreshDataGraceMs : null,
      freshDataGrace: unreadSinceMs === null
        ? null
        : Object.freeze({
          sinceMs: unreadSinceMs,
          remainingMs: Math.max(0, sessionHarvestFreshDataGraceMs - (now() - unreadSinceMs))
        }),
      harvestedToday: harvestState?.status === "CONFIRMED",
      trancheExitsPaused: ["PENDING", "CONFIRMED", "HALTED"].includes(harvestState?.status),
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

  return Object.freeze({ evaluate, recoverHarvest, executeDeferredFullFlatten, getSnapshot, allocateProportionalCut });
}
