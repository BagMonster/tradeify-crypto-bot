/**
 * src/risk/riskSupervisor.js
 *
 * D-060 account ladder plus D-064 session harvest.
 * Harvest is enabled from config/instruments.json (sessionHarvestEnabled).
 *
 * 2026-09-21: the D-060 full flatten executes IMMEDIATELY at the threshold.
 * It previously sat behind a 25-minute owner halt-warning cycle, during which
 * neither the flatten nor the cut tiers ran (the flatten branch returns before
 * the tiers). Tradeify closes the account the moment intraday equity touches
 * the daily limit, and on the $10,000 account the flatten sits only $50 above
 * it, so a 25-minute wait is not survivable. Owner decision, 2026-09-21.
 * The owner is told after the fact by the SAFETY_HALT notification below.
 */

import { harvestReason, setTrancheExitsPausedAll } from "./sessionHarvest.js";

const DEFAULT_HARVEST_FRESH_DATA_GRACE_MS = 5 * 60 * 1000;
const DEFAULT_CUT_COOLDOWN_MS = 5 * 60 * 1000;
const HARVEST_FLAT_CONFIRMATION_HALT = "D-064 harvest could not confirm every book flat; owner review required";

// A protective flatten can be accepted by DXtrade before its follow-up read
// sees the empty book.  These outcomes are therefore not proof that the
// harvest failed; they mean the bot must remain fail-closed and try the
// idempotent flatten again on the next risk evaluation.  A definite execution
// failure (for example REJECTED, BLOCKED or THREW) is still a durable halt.
const HARVEST_RETRYABLE_FLATTEN_STATUSES = new Set([
  "PENDING", "SUBMITTED", "CLAIMED", "NOT_VERIFIED", "NOT_FLAT", "ACCOUNT_DATA_UNAVAILABLE"
]);

function isFreshDataHarvestHalt(reason) {
  return typeof reason === "string" && reason.startsWith("D-064 harvest cannot verify fresh broker account data for ");
}

function isFlatConfirmationHarvestHalt(reason) {
  return reason === HARVEST_FLAT_CONFIRMATION_HALT;
}

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

// Every book carrying an unrealised loss is cut, at the same fraction.
//
// There is deliberately no exemption for a book that is net positive on the
// day. An earlier revision gated on day P&L so a book that had banked realised
// profit could not be cut, and that produced an unbounded failure: if the
// exempt book's own unrealised loss exceeded the tier threshold on its own, the
// tier stayed breached forever while the only cuttable book was ground to dust
// paying for a loss it had not caused. Simulated at -$600 exempt against -$50
// cuttable, the innocent book lost 72% of its position in one hour and the tier
// never released. One rule for every book avoids that entirely.
//
// The flat fraction is already proportional in dollars: closing 10% of a book
// realises 10% of that book's unrealised loss, so a book that is -$400 down
// gives up four times the dollars of one that is -$100 down. `share` is
// reported for the logs and for /status, not used to size the cut.
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
      fraction: Number(partialCutFraction.toFixed(6)),
      unrealisedLossUsd: Number(entry.loss.toFixed(2))
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
  // requestHaltWarning is no longer used: the full flatten does not wait on a
  // warning cycle. index.mjs may still pass it; an unknown property is ignored.
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
  const configuredCutCooldownMs = Number(config.cutCooldownMs);
  const cutCooldownMs = Number.isFinite(configuredCutCooldownMs) && configuredCutCooldownMs >= 0
    ? configuredCutCooldownMs
    : DEFAULT_CUT_COOLDOWN_MS;
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
  // Deepest cut tier that has fired this account day (dollars; 0 = none), and
  // when the last cut fired.
  //
  // A cut tier used to re-fire on EVERY evaluation while combined day P&L stayed
  // below its threshold. Cutting a losing position cannot lift that figure — it
  // converts unrealised loss into realised loss at the same value — so the
  // trigger condition was the one thing cutting could never clear. Tier 1
  // compounded 10% per tick until the account was flat and the loss permanent.
  // On 2026-09-18 that turned a -$733 unrealised drawdown into -$841 realised
  // across 106 cuts in about two minutes, with no chance for price to recover.
  //
  // The cooldown restores the cadence the strategy was actually validated at.
  // portfolio-harvest-sim.mjs steps the same cut logic over 5-minute bars
  // (380,720 steps / 1,323 account days = 288 per day), so the backtest could
  // never cut more than twelve times an hour. The live runtime evaluates on every
  // Binance trade tick instead, which is roughly 250x faster — the logic matched
  // the test, the clock did not. The default below is 5 minutes so live matches
  // the tested cadence exactly.
  //
  // A DEEPER tier bypasses the cooldown: the account is falling faster than the
  // ladder planned for and the larger cut should not be delayed.
  let deepestCutTierFiredUsd = 0;
  let lastCutAtMs = null;
  const brakedToday = new Set();
  let evaluating = false;
  let hasSuccessfulRead = false;
  let lastError = null;
  let unreadSinceMs = null;

  // A protective cut that does not fill leaves the account unprotected. On
  // 2026-09-19 seventeen consecutive cuts returned ACCOUNT_DATA_UNAVAILABLE
  // over eighty minutes, the supervisor logged each one and rescheduled, and
  // nobody was told until the account had already breached. The ladder was
  // working perfectly and firing into a dead broker session.
  //
  // So: the moment a cut fails to fill, stop opening new positions and say so.
  // Entries are the one thing still fully under our control when execution is
  // broken, and the three entries opened at 16:05-16:13 that day took exposure
  // from $23k to $41k on a $49k account. Those are what made the loss fatal.
  //
  // The ladder keeps retrying on its normal cooldown, per the owner's choice:
  // if the session recovers the bot resumes on its own without intervention.
  let protectionFailing = false;
  let consecutiveFailedCuts = 0;
  let protectionFailingSinceMs = null;
  let lastProtectionFailureReason = null;

  function stickyBrake(instrument) {
    return flattenedToday === true || brakedToday.has(instrument) || protectionFailing === true;
  }

  function applyEntryBrake(book, on) {
    try {
      book.setEntryBrake(on === true);
    } catch {
      // a book that cannot accept the flag stays in the last known state
    }
  }

  /**
   * Record whether a protective cut actually closed anything, and react.
   *
   * Failure: brake entries on every book immediately and alert. We do not halt
   * or force a flatten - a flatten needs the same broker read that just failed,
   * so it would fail too, and halting would need manual release for what is
   * usually a transient session problem. Blocking entries is the action that is
   * always available and always correct: if the ladder cannot take risk off,
   * the bot must at minimum stop putting more on.
   *
   * Recovery: clear the brake for any book not braked for another reason, and
   * say so, so a silent recovery is as visible as the failure was.
   */
  async function recordProtectionOutcome({ filled, statuses, totalUnrealisedUsd, combined, readings }) {
    const failureStatuses = statuses.filter((s) => s.status !== "FILLED");

    if (filled === true) {
      consecutiveFailedCuts = 0;
      if (protectionFailing === true) {
        const outageMs = protectionFailingSinceMs === null ? null : now() - protectionFailingSinceMs;
        protectionFailing = false;
        protectionFailingSinceMs = null;
        lastProtectionFailureReason = null;
        for (const reading of readings) applyEntryBrake(reading.book, stickyBrake(reading.instrument));
        await addEvent("WARN", "RISK_SUPERVISOR_PROTECTION_RECOVERED", {
          outageMs,
          totalUnrealisedUsd,
          combinedDayPnlUsd: combined
        });
        notifications?.enqueue?.({
          kind: "PROTECTION_RECOVERED",
          eventKey: `PROT-OK:${now()}`,
          outageMs,
          totalUnrealisedUsd,
          combinedDayPnlUsd: combined
        });
      }
      return;
    }

    consecutiveFailedCuts += 1;
    const firstFailure = protectionFailing !== true;
    if (firstFailure) {
      protectionFailing = true;
      protectionFailingSinceMs = now();
    }
    lastProtectionFailureReason = failureStatuses[0]?.status ?? "UNKNOWN";

    // Brake every book, including ones that were fine a moment ago. The
    // execution path is shared, so a failure on one is a failure on all.
    for (const reading of readings) applyEntryBrake(reading.book, true);

    await addEvent("ERROR", "RISK_SUPERVISOR_PROTECTION_FAILED", {
      consecutiveFailedCuts,
      failureStatus: lastProtectionFailureReason,
      failingSinceMs: protectionFailingSinceMs,
      totalUnrealisedUsd,
      combinedDayPnlUsd: combined,
      entriesBlocked: true,
      allocations: statuses
    });

    // Tell the owner on the first failure, then keep nagging every third so a
    // long outage does not go quiet, without a message every five minutes.
    if (firstFailure || consecutiveFailedCuts % 3 === 0) {
      notifications?.enqueue?.({
        kind: "PROTECTION_FAILED",
        eventKey: `PROT-FAIL:${protectionFailingSinceMs}:${consecutiveFailedCuts}`,
        consecutiveFailedCuts,
        failureStatus: lastProtectionFailureReason,
        outageMs: protectionFailingSinceMs === null ? 0 : now() - protectionFailingSinceMs,
        totalUnrealisedUsd,
        combinedDayPnlUsd: combined
      });
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
    deepestCutTierFiredUsd = 0;
    lastCutAtMs = null;
    brakedToday.clear();
    unreadSinceMs = null;
    // protectionFailing deliberately survives the rollover. A broken broker
    // session does not heal at 22:00 UTC, and clearing the brake here would
    // silently re-arm entries into an execution path that still cannot cut.
    // It clears only when a cut actually fills again.
    for (const book of instruments) applyEntryBrake(book, protectionFailing === true);
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
    const terminal = results.filter((r) => {
      const status = r.result?.status;
      return status !== "FILLED" && status !== "ALREADY_FLAT" && !HARVEST_RETRYABLE_FLATTEN_STATUSES.has(status);
    });
    const pendingResults = results.filter((r) => HARVEST_RETRYABLE_FLATTEN_STATUSES.has(r.result?.status));
    if (terminal.length > 0) {
      const reason = HARVEST_FLAT_CONFIRMATION_HALT;
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
        // Immediate. No warning cycle, no deferral. See the file header.
        return executeFullFlatten({ incomingDayKey, combined, readings });
      }

      if (harvestBlocksNormalActions()) return runHarvest({ incomingDayKey, combined, readings });

      // The cut tiers read UNREALISED loss across all books, not combined day
      // P&L. The brake, the full flatten and the daily loss limit above keep
      // reading combined, because those rails exist to protect the Tradeify
      // daily limit, which counts realised money.
      //
      // The cut ladder is a different job: it reduces live exposure. Reading
      // combined made it read losses that were already closed, so a day that
      // had realised -$841 stayed pinned at the 20% tier with no open risk
      // left, and every fresh position that dipped was cut for a loss it had
      // nothing to do with. Worse, cutting could never clear the condition:
      // closing a position moves loss from unrealised to realised at the same
      // value, so combined did not improve and the tier never released. That
      // is the unbounded loop that took 95% of four books on 2026-09-18.
      //
      // Against unrealised the same cut is self-limiting. Closing 20% of a
      // book removes 20% of its unrealised loss, so -$620 becomes -$496, the
      // -$500 tier releases, and the ladder stops on its own. The cooldown
      // below is now a backstop rather than the only brake.
      const totalUnrealisedUsd = fixed2(readings.reduce((sum, r) => sum + r.unrealisedUsd, 0));

      // cutTiers is sorted deepest-first. A tier fires when it is breached AND
      // either it is deeper than anything fired so far (an escalation, which
      // bypasses the cooldown) or the cooldown since the last cut has elapsed.
      const cooldownRemainingMs = lastCutAtMs === null
        ? 0
        : Math.max(0, cutCooldownMs - (now() - lastCutAtMs));
      const activeTier = cutTiers.find((tier) => {
        if (totalUnrealisedUsd > -tier.thresholdUsd) return false;
        if (tier.thresholdUsd > deepestCutTierFiredUsd) return true;
        return cooldownRemainingMs === 0;
      }) ?? null;
      if (activeTier) {
        const allocations = allocateProportionalCut(
          readings.map((r) => ({ instrument: r.instrument, unrealisedUsd: r.unrealisedUsd })),
          activeTier.fraction
        );
        if (allocations.length === 0) {
          // The tier is breached but no book is carrying an unrealised loss.
          // Nothing is cut and the cooldown is NOT consumed, because no cut
          // happened.
          await addEvent("WARN", "RISK_SUPERVISOR_CUT_NO_LOSING_BOOK", {
            combinedDayPnlUsd: combined,
            totalUnrealisedUsd,
            threshold: -activeTier.thresholdUsd
          });
        } else {
          cutsToday += 1;
          deepestCutTierFiredUsd = Math.max(deepestCutTierFiredUsd, activeTier.thresholdUsd);
          lastCutAtMs = now();
          const results = [];
          for (const allocation of allocations) {
            const reading = readings.find((r) => r.instrument === allocation.instrument);
            try {
              results.push({
                instrument: allocation.instrument,
                fraction: allocation.fraction,
                result: await reading.book.executeProtectiveCut({
                  fraction: allocation.fraction,
                  reason: `D-063 tier cut ${(activeTier.fraction * 100).toFixed(0)}% at unrealised ${totalUnrealisedUsd.toFixed(2)} (threshold -${activeTier.thresholdUsd}, combined ${combined.toFixed(2)}, this book ${allocation.unrealisedLossUsd.toFixed(2)} = ${(allocation.share * 100).toFixed(1)}% of the loss)`,
                  dayKey: incomingDayKey,
                  bypassSlippageCap: true
                })
              });
            } catch (error) {
              results.push({ instrument: allocation.instrument, fraction: allocation.fraction, result: { status: "THREW", reason: error?.message ?? "cut threw" } });
            }
          }
          const statuses = results.map((r) => ({
            instrument: r.instrument,
            fraction: r.fraction,
            status: r.result?.status ?? "UNKNOWN"
          }));
          // A cut only counts as protection if something actually closed.
          const anyFilled = statuses.some((s) => s.status === "FILLED");
          await recordProtectionOutcome({
            filled: anyFilled,
            statuses,
            totalUnrealisedUsd,
            combined,
            readings
          });
          await addEvent("WARN", "RISK_SUPERVISOR_PARTIAL_CUT", {
            totalUnrealisedUsd,
            combinedDayPnlUsd: combined,
            threshold: -activeTier.thresholdUsd,
            tierFraction: activeTier.fraction,
            cutNumber: cutsToday,
            cutCooldownMs,
            nextCutEligibleAt: new Date(now() + cutCooldownMs).toISOString(),
            executed: anyFilled,
            consecutiveFailedCuts,
            allocations: statuses
          });
          return Object.freeze({
            action: anyFilled ? "CUT" : "CUT_FAILED",
            totalUnrealisedUsd,
            combinedDayPnlUsd: combined,
            tier: activeTier,
            executed: anyFilled,
            consecutiveFailedCuts,
            results: Object.freeze(results)
          });
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

  async function recoverHarvest({ dayKey: incomingDayKey, booksVerified = false, recoveryKind = "FRESH_DATA" } = {}) {
    if (!sessionHarvestEnabled) return Object.freeze({ action: "HARVEST_DISABLED" });
    if (typeof incomingDayKey !== "string" || incomingDayKey === "") throw new TypeError("recoverHarvest requires a dayKey");
    if (booksVerified !== true) return Object.freeze({ action: "HARVEST_RECOVERY_REFUSED" });
    if (recoveryKind !== "FRESH_DATA" && recoveryKind !== "VERIFIED_FLAT") {
      return Object.freeze({ action: "HARVEST_RECOVERY_REFUSED" });
    }
    if (incomingDayKey !== dayKey) rollover(incomingDayKey);
    const prior = await loadHarvest(incomingDayKey);
    if (prior.status !== "HALTED") return Object.freeze({ action: "HARVEST_NOT_HALTED", harvest: prior });
    const freshDataRecovery = recoveryKind === "FRESH_DATA" && isFreshDataHarvestHalt(prior.haltReason);
    const verifiedFlatRecovery = recoveryKind === "VERIFIED_FLAT" && isFlatConfirmationHarvestHalt(prior.haltReason);
    if (!freshDataRecovery && !verifiedFlatRecovery) {
      return Object.freeze({ action: "HARVEST_RECOVERY_REFUSED", harvest: prior });
    }
    const readings = readBooks();
    if (readings.some((reading) => reading.readFailed)) return Object.freeze({ action: "ACCOUNT_DATA_UNAVAILABLE", harvest: prior });
    const safety = await getSafetyHaltState();
    if (safety?.safety_halt === true) {
      // Compare and clear atomically: recovery cannot erase a newer, unrelated
      // safety halt that arrived after the owner requested this confirmation.
      if (safety.halt_reason !== prior.haltReason) return Object.freeze({ action: "HARVEST_RECOVERY_REFUSED", harvest: prior });
      const cleared = await clearSafetyHaltIfReason(prior.haltReason);
      if (!cleared) return Object.freeze({ action: "HARVEST_RECOVERY_REFUSED", harvest: prior });
    }
    if (verifiedFlatRecovery) {
      // The harvest has already flattened every book.  Do not reset to READY
      // and re-test today's P&L: realised P&L can fall below the threshold
      // between the flatten and this verification.  Confirm the original
      // harvest instead, retain its trigger, release only harvest entry brakes,
      // and keep ordinary tranche exits paused until the account-day reset.
      const confirmed = await saveHarvest({
        dayKey: incomingDayKey,
        status: "CONFIRMED",
        triggerPnlUsd: prior.triggerPnlUsd,
        confirmedAt: new Date(now()).toISOString(),
        haltReason: null
      });
      applyHarvestGates();
      for (const book of instruments) if (!stickyBrake(book.instrument)) applyEntryBrake(book, false);
      await addEvent("WARN", "D064_HARVEST_RECOVERED_CONFIRMED", {
        dayKey: incomingDayKey,
        triggerPnlUsd: prior.triggerPnlUsd,
        recoveryKind
      });
      notifications?.enqueue?.({
        kind: "HARVEST_CONFIRMED",
        eventKey: `D064-CONFIRMED:${incomingDayKey.replaceAll("-", "")}`,
        combinedDayPnlUsd: prior.triggerPnlUsd,
        thresholdUsd: sessionHarvestThreshold,
        confirmedAt: confirmed.confirmedAt
      });
      hasSuccessfulRead = true;
      return Object.freeze({ action: "HARVEST_CONFIRMED", harvest: confirmed });
    }

    let combined;
    try {
      const supplied = typeof getCombinedDayPnlUsd === "function" ? Number(getCombinedDayPnlUsd()) : NaN;
      combined = fixed2(Number.isFinite(supplied) ? supplied : readings.reduce((sum, reading) => sum + reading.dayPnlUsd, 0));
    } catch {
      return Object.freeze({ action: "ACCOUNT_DATA_UNAVAILABLE", harvest: prior });
    }
    await saveHarvest({ dayKey: incomingDayKey, status: "READY", triggerPnlUsd: null, confirmedAt: null, haltReason: null });
    applyHarvestGates();
    hasSuccessfulRead = true;
    return evaluate({ dayKey: incomingDayKey });
  }

  // Kept for halt-warning cycles persisted before 2026-09-21, which index.mjs's
  // onDue handler may still fire after a restart. New code never creates one.
  // executeFullFlatten() is idempotent within a day (flattenedToday).
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
      cutCooldownMs,
      deepestCutTierFiredUsd,
      // Whether the ladder can actually execute. This is the line that would
      // have made 2026-09-19 obvious from a single /status.
      protectionFailing,
      consecutiveFailedCuts,
      protectionFailingSinceMs,
      lastProtectionFailureReason,
      // The figure the cut tiers actually read. Shown next to combined so
      // /status makes it obvious which number is driving the ladder.
      totalUnrealisedUsd: fixed2(readings.reduce((sum, r) => sum + r.unrealisedUsd, 0)),
      cutCooldownRemainingMs: lastCutAtMs === null
        ? 0
        : Math.max(0, cutCooldownMs - (now() - lastCutAtMs)),
      lastError,
      perInstrument: Object.freeze(readings.map((r) => Object.freeze({
        instrument: r.instrument,
        dayPnlUsd: fixed2(r.dayPnlUsd),
        unrealisedUsd: fixed2(r.unrealisedUsd),
        exposureUsd: fixed2(r.exposureUsd),
        braked: brakedToday.has(r.instrument),
        // Whether this book would be cut if a tier fired right now.
        cuttable: r.unrealisedUsd < 0,
        readFailed: r.readFailed
      })))
    });
  }

  return Object.freeze({ evaluate, recoverHarvest, executeDeferredFullFlatten, getSnapshot, allocateProportionalCut });
}
