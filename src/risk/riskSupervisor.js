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
import { buildProportionalRolloverHarvestPlan } from "./rolloverHarvest.js";
import { ACCOUNT_DAY_OFFSET_MS } from "./dailyRiskLadder.js";

const DEFAULT_HARVEST_FRESH_DATA_GRACE_MS = 5 * 60 * 1000;
// A shared DXtrade-read failure does not change trading behavior. It is only
// worth interrupting the owner after it has persisted long enough to need
// attention; brief provider flaps should remain entirely silent.
const DEFAULT_FRESHNESS_ALERT_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_CUT_COOLDOWN_MS = 15 * 60 * 1000;
// A pending harvest close may be accepted by DXtrade while its confirmation
// endpoint is rate-limited. Wait before retrying so a single harvest cannot
// turn into a storm of identical account-wide close attempts.
const DEFAULT_HARVEST_RETRY_MS = 30 * 1000;
const RATE_LIMIT_HARVEST_RETRY_MS = 60 * 1000;
const HARVEST_FLAT_CONFIRMATION_HALT = "D-064 harvest could not confirm every book flat; owner review required";
const D068_ROLLOVER_CONFIRMATION_HALT = "D-068 rollover harvest could not confirm its planned profit closes; owner review required";

// A protective flatten can be accepted by DXtrade before its follow-up read
// sees the empty book.  These outcomes are therefore not proof that the
// harvest failed; they mean the bot must remain fail-closed and try the
// idempotent flatten again on the next risk evaluation.  A definite execution
// failure (for example REJECTED, BLOCKED or THREW) is still a durable halt.
const HARVEST_RETRYABLE_FLATTEN_STATUSES = new Set([
  "PENDING", "SUBMITTED", "CLAIMED", "NOT_VERIFIED", "NOT_FLAT", "ACCOUNT_DATA_UNAVAILABLE"
]);

function isFreshDataHarvestHalt(reason) {
  return typeof reason === "string" && (
    reason.startsWith("D-064 harvest cannot verify fresh broker account data for ") ||
    reason === "D-068 cannot read and price every configured account ticket; owner review required"
  );
}

function isFlatConfirmationHarvestHalt(reason) {
  return reason === HARVEST_FLAT_CONFIRMATION_HALT;
}

function isUnverifiedRolloverHarvestHalt(harvest) {
  // Old D-068 rows persisted a local completed list, but that list records a
  // callback, not a broker receipt.  It is never sufficient to lock ordinary
  // exits.  Future real D-068 confirmations carry an explicit broker marker.
  return harvest?.haltReason === D068_ROLLOVER_CONFIRMATION_HALT &&
    harvest?.plan?.confirmation?.source !== "BROKER_CONFIRMED";
}

function isUnverifiedRolloverConfirmation(harvest) {
  return harvest?.status === "CONFIRMED" &&
    harvest?.mode === "ROLLOVER_PARTIAL" &&
    harvest?.plan?.confirmation?.source !== "BROKER_CONFIRMED";
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

function rolloverHarvestWaitRemainingMs(dayKey, delayMs, nowMs) {
  if (delayMs === 0) return 0;
  const midnightMs = Date.parse(`${dayKey}T00:00:00.000Z`);
  if (!Number.isFinite(midnightMs)) throw new TypeError("rollover harvest dayKey is invalid");
  return Math.max(0, midnightMs - ACCOUNT_DAY_OFFSET_MS + delayMs - nowMs);
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
  getExposurePoolSnapshot = null,
  onRolloverHarvestConfirmed = async () => {},
  freshnessEpisodeStore = null,
  entryBrakeStore = null,
  freshnessAlertAfterMs = DEFAULT_FRESHNESS_ALERT_AFTER_MS,
  freshnessRecoveredAfterMs = 60 * 1000,
  harvestRetryMs = DEFAULT_HARVEST_RETRY_MS,
  // requestHaltWarning is no longer used: the full flatten does not wait on a
  // warning cycle. index.mjs may still pass it; an unknown property is ignored.
  now = () => Date.now()
}) {
  if (!config || typeof config !== "object") throw new TypeError("risk config is required");
  if (freshnessEpisodeStore !== null && (typeof freshnessEpisodeStore?.get !== "function" || typeof freshnessEpisodeStore?.save !== "function")) {
    throw new TypeError("freshnessEpisodeStore must provide get() and save()");
  }
  if (entryBrakeStore !== null && (typeof entryBrakeStore?.get !== "function" || typeof entryBrakeStore?.save !== "function")) {
    throw new TypeError("entryBrakeStore must provide get() and save()");
  }
  if (!Number.isSafeInteger(freshnessRecoveredAfterMs) || freshnessRecoveredAfterMs < 0) {
    throw new TypeError("freshnessRecoveredAfterMs must be a non-negative whole number");
  }
  if (!Number.isSafeInteger(freshnessAlertAfterMs) || freshnessAlertAfterMs < 0) {
    throw new TypeError("freshnessAlertAfterMs must be a non-negative whole number");
  }
  if (!Number.isSafeInteger(harvestRetryMs) || harvestRetryMs < 1_000) {
    throw new TypeError("harvestRetryMs must be a whole number of at least 1000");
  }
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
  const rolloverHarvestDelayMinutes = config.rolloverHarvestDelayMinutes == null
    ? 0
    : Number(config.rolloverHarvestDelayMinutes);
  if (!Number.isSafeInteger(rolloverHarvestDelayMinutes) || rolloverHarvestDelayMinutes < 0 || rolloverHarvestDelayMinutes > 60) {
    throw new TypeError("rolloverHarvestDelayMinutes must be a whole number from 0 through 60");
  }
  const rolloverHarvestDelayMs = rolloverHarvestDelayMinutes * 60 * 1000;
  const configuredCutCooldownMs = Number(config.cutCooldownMs);
  const cutCooldownMs = Number.isFinite(configuredCutCooldownMs) && configuredCutCooldownMs >= 0
    ? configuredCutCooldownMs
    : DEFAULT_CUT_COOLDOWN_MS;
  const configuredFreshDataGrace = Number(config.sessionHarvestFreshDataGraceMs);
  const sessionHarvestFreshDataGraceMs = sessionHarvestEnabled && Number.isFinite(configuredFreshDataGrace)
    ? positiveNumber("sessionHarvestFreshDataGraceMs", configuredFreshDataGrace)
    : DEFAULT_HARVEST_FRESH_DATA_GRACE_MS;
  const exposurePoolHarvest = config.exposurePoolHarvest ?? null;

  function rolloverHarvestTarget() {
    const policy = exposurePoolHarvest;
    if (!policy || typeof getExposurePoolSnapshot !== "function") return Object.freeze({ thresholdUsd: sessionHarvestThreshold, phase: "STANDARD" });
    let snapshot;
    try {
      snapshot = getExposurePoolSnapshot();
    } catch {
      return Object.freeze({ thresholdUsd: sessionHarvestThreshold, phase: "STANDARD" });
    }
    const sinceMs = Number(snapshot?.closedSinceMs);
    if (snapshot?.closed !== true || !Number.isFinite(sinceMs)) return Object.freeze({ thresholdUsd: sessionHarvestThreshold, phase: "STANDARD" });
    const ageMs = Math.max(0, now() - sinceMs);
    const firstMs = Number(policy.firstAfterHours) * 60 * 60 * 1000;
    const secondMs = Number(policy.secondAfterHours) * 60 * 60 * 1000;
    if (ageMs >= secondMs) return Object.freeze({ thresholdUsd: fixed2(sessionHarvestThreshold * Number(policy.minimumFraction)), phase: "FULL_36H", ageMs });
    if (ageMs >= firstMs) return Object.freeze({ thresholdUsd: fixed2(sessionHarvestThreshold * Number(policy.firstFraction)), phase: "FULL_24H", ageMs });
    return Object.freeze({ thresholdUsd: sessionHarvestThreshold, phase: "STANDARD", ageMs });
  }
  if (sessionHarvestEnabled && (!harvestStore || typeof harvestStore.get !== "function" || typeof harvestStore.save !== "function")) {
    throw new TypeError("enabled session harvest requires a durable harvestStore");
  }

  let dayKey = null;
  let flattenedToday = false;
  let harvestState = null;
  let cutsToday = 0;
  // Partial cuts reduce risk that is still open, so their tiers read total
  // unrealised loss.  They must not read realised-plus-unrealised day P&L:
  // closing a loser only transfers its loss to realised P&L and can never clear
  // that trigger.  That regression repeatedly cut the book after the live loss
  // had already fallen to dust on 2026-09-29.
  //
  // One cooldown covers the ladder.  A newly deeper tier may act immediately,
  // while a shallower tier waits for the configured cadence.  Once a cut brings
  // the open loss above its tier threshold, the ladder clears on its own.
  let deepestCutTierFiredUsd = 0;
  let lastCutAtMs = null;
  const brakedToday = new Set();
  let evaluating = false;
  // This promise is shared by every caller in this worker. It supplements the
  // evaluation gate and makes the harvest operation itself single-flight.
  let harvestRunInFlight = null;
  let harvestRetryAtMs = null;
  let hasSuccessfulRead = false;
  let lastError = null;
  let unreadSinceMs = null;
  let freshnessEpisode = null;
  let entryBrakeState = null;

  function emptyFreshnessEpisode() {
    return Object.freeze({ episodeId: 0, status: "RESOLVED", startedAtMs: null, lastUnreadAtMs: null, freshSinceMs: null, alertedAtMs: null, instruments: Object.freeze([]) });
  }

  async function loadFreshnessEpisode() {
    if (freshnessEpisode !== null) return freshnessEpisode;
    freshnessEpisode = freshnessEpisodeStore === null ? emptyFreshnessEpisode() : await freshnessEpisodeStore.get();
    return freshnessEpisode;
  }

  async function saveFreshnessEpisode(next) {
    freshnessEpisode = freshnessEpisodeStore === null ? Object.freeze(next) : await freshnessEpisodeStore.save(next);
    return freshnessEpisode;
  }

  function normalizeEntryBrakeState(input, expectedDayKey) {
    const stateDayKey = typeof input?.dayKey === "string" ? input.dayKey : expectedDayKey;
    if (stateDayKey !== expectedDayKey) throw new Error("entry-brake state day key does not match the requested account day");
    const allowed = new Set(instruments.map((book) => book.instrument));
    const names = Array.isArray(input?.instruments) ? input.instruments : [];
    const unique = [...new Set(names)];
    if (unique.some((instrument) => typeof instrument !== "string" || !allowed.has(instrument))) {
      throw new Error("entry-brake state contains an unsupported instrument");
    }
    return Object.freeze({ dayKey: expectedDayKey, instruments: Object.freeze(unique) });
  }

  async function loadEntryBrakes(incomingDayKey) {
    if (entryBrakeState?.dayKey === incomingDayKey) return entryBrakeState;
    const stored = entryBrakeStore === null
      ? { dayKey: incomingDayKey, instruments: [] }
      : await entryBrakeStore.get(incomingDayKey);
    entryBrakeState = normalizeEntryBrakeState(stored, incomingDayKey);
    brakedToday.clear();
    for (const instrument of entryBrakeState.instruments) brakedToday.add(instrument);
    return entryBrakeState;
  }

  async function saveEntryBrakes(incomingDayKey) {
    const proposed = { dayKey: incomingDayKey, instruments: [...brakedToday] };
    const saved = entryBrakeStore === null ? proposed : await entryBrakeStore.save(proposed);
    entryBrakeState = normalizeEntryBrakeState(saved, incomingDayKey);
    brakedToday.clear();
    for (const instrument of entryBrakeState.instruments) brakedToday.add(instrument);
    return entryBrakeState;
  }

  async function noteFreshnessOutage(nowMs, instruments) {
    const prior = await loadFreshnessEpisode();
    if (prior.status === "ACTIVE") {
      return Object.freeze({ started: false, episode: await saveFreshnessEpisode({ ...prior, lastUnreadAtMs: nowMs, freshSinceMs: null, instruments }) });
    }
    const episode = await saveFreshnessEpisode({
      episodeId: Number(prior.episodeId ?? 0) + 1,
      status: "ACTIVE",
      startedAtMs: nowMs,
      lastUnreadAtMs: nowMs,
      freshSinceMs: null,
      alertedAtMs: null,
      instruments
    });
    return Object.freeze({ started: true, episode });
  }

  async function noteFreshnessOutageAlert(nowMs) {
    const prior = await loadFreshnessEpisode();
    if (prior.status !== "ACTIVE" || prior.alertedAtMs != null || !Number.isFinite(prior.startedAtMs)) {
      return Object.freeze({ alerted: false, episode: prior });
    }
    if (nowMs - prior.startedAtMs < freshnessAlertAfterMs) {
      return Object.freeze({ alerted: false, episode: prior });
    }
    const episode = await saveFreshnessEpisode({ ...prior, alertedAtMs: nowMs });
    return Object.freeze({ alerted: true, episode });
  }

  async function noteFreshnessRead(nowMs) {
    const prior = await loadFreshnessEpisode();
    if (prior.status !== "ACTIVE") return Object.freeze({ restored: false, episode: prior });
    if (prior.freshSinceMs === null) {
      return Object.freeze({ restored: false, episode: await saveFreshnessEpisode({ ...prior, freshSinceMs: nowMs }) });
    }
    if (nowMs - prior.freshSinceMs < freshnessRecoveredAfterMs) return Object.freeze({ restored: false, episode: prior });
    const episode = await saveFreshnessEpisode({ ...prior, status: "RESOLVED", freshSinceMs: null });
    return Object.freeze({ restored: true, episode });
  }

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
    harvestRetryAtMs = null;
    entryBrakeState = null;
    // protectionFailing deliberately survives the rollover. A broken broker
    // session does not heal at 22:00 UTC, and clearing the brake here would
    // silently re-arm entries into an execution path that still cannot cut.
    // It clears only when a cut actually fills again.
    for (const book of instruments) applyEntryBrake(book, protectionFailing === true);
    applyTrancheExitPause(false);
  }

  async function loadHarvest(nextDayKey) {
    if (!sessionHarvestEnabled) return Object.freeze({ dayKey: nextDayKey, status: "READY", mode: "FULL", plan: null, triggerPnlUsd: null, confirmedAt: null, haltReason: null });
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
      mode: prior.mode ?? "FULL",
      plan: prior.plan ?? null,
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
    notifications?.enqueue?.({ kind: "HARVEST_HALTED", mode: prior.mode ?? "FULL", eventKey: `D064-HALTED:${incomingDayKey.replaceAll("-", "")}`, reason });
    return halted;
  }

  async function runFullHarvest({ incomingDayKey, combined, readings }) {
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
      : await saveHarvest({ dayKey: incomingDayKey, status: "PENDING", mode: "FULL", plan: null, triggerPnlUsd: combined, confirmedAt: null, haltReason: null });
    applyHarvestGates();
    if (prior.status !== "PENDING") {
      await addEvent("WARN", "D064_HARVEST_PENDING", { dayKey: incomingDayKey, combinedDayPnlUsd: combined, threshold: sessionHarvestThreshold });
      notifications?.enqueue?.({ kind: "HARVEST_PENDING", eventKey: `D064-PENDING:${incomingDayKey.replaceAll("-", "")}`, combinedDayPnlUsd: combined, thresholdUsd: sessionHarvestThreshold });
    }
    const results = [];
    for (const reading of readings) {
      let result;
      try {
        result = await reading.book.executeProtectiveFlatten({
          reason: harvestReason(combined, sessionHarvestThreshold),
          dayKey: incomingDayKey,
          bypassSlippageCap: true
        });
      } catch (error) {
        result = { status: "THREW", reason: error?.message ?? "harvest flatten threw" };
      }
      results.push({ instrument: reading.instrument, result });
      // A broker read or confirmation is pending. Do not probe every remaining
      // book in the same pass; the next single-flight retry resumes safely.
      if (HARVEST_RETRYABLE_FLATTEN_STATUSES.has(result?.status)) break;
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
    const confirmed = await saveHarvest({ dayKey: incomingDayKey, status: "CONFIRMED", mode: "FULL", plan: null, triggerPnlUsd: pending.triggerPnlUsd, confirmedAt: new Date(now()).toISOString(), haltReason: null });
    applyHarvestGates();
    for (const book of instruments) if (!stickyBrake(book.instrument)) applyEntryBrake(book, false);
    await addEvent("WARN", "D064_HARVEST_CONFIRMED", { dayKey: incomingDayKey, combinedDayPnlUsd: combined, threshold: sessionHarvestThreshold });
    notifications?.enqueue?.({ kind: "HARVEST_CONFIRMED", eventKey: `D064-CONFIRMED:${incomingDayKey.replaceAll("-", "")}`, combinedDayPnlUsd: combined, thresholdUsd: sessionHarvestThreshold, confirmedAt: confirmed.confirmedAt });
    return Object.freeze({ action: "HARVEST_CONFIRMED", combinedDayPnlUsd: combined, results: Object.freeze(results), harvest: confirmed });
  }

  async function buildRolloverPlan(incomingDayKey, thresholdUsd) {
    const candidates = [];
    for (const book of instruments) {
      // Older test/maintenance callers that have no D-068 provider opt out of
      // this feature entirely; live configured books always provide it.
      if (typeof book.getRolloverHarvestCandidates !== "function") return null;
      const rows = await book.getRolloverHarvestCandidates({ dayKey: incomingDayKey });
      // Binance has not necessarily emitted its first live tick when Railway
      // starts. Do not omit that book or turn the normal warm-up into a
      // durable halt: defer the all-account calculation until every mark is
      // available, then retry on the next risk evaluation.
      if (rows === null) return null;
      if (!Array.isArray(rows)) throw new Error(`${book.instrument} returned invalid rollover harvest candidates`);
      candidates.push(...rows);
    }
    const plan = buildProportionalRolloverHarvestPlan({
      dayKey: incomingDayKey,
      thresholdUsd,
      candidates
    });
    return plan.allocations.length > 0 ? plan : null;
  }

  function rolloverPlanEntries(plan) {
    return Array.isArray(plan?.allocations) ? plan.allocations : [];
  }

  async function runRolloverHarvest({ incomingDayKey, combined, readings }) {
    const prior = await loadHarvest(incomingDayKey);
    if (prior.status === "CONFIRMED") {
      applyHarvestGates();
      return Object.freeze({ action: "NONE", combinedDayPnlUsd: combined, harvest: prior });
    }
    if (prior.status === "HALTED") {
      applyHarvestGates();
      return Object.freeze({ action: "HARVEST_HALTED", combinedDayPnlUsd: combined, harvest: prior });
    }
    const waitRemainingMs = rolloverHarvestWaitRemainingMs(incomingDayKey, rolloverHarvestDelayMs, now());
    if (waitRemainingMs > 0) {
      // The broker's new accounting day starts at 22:00 UTC.  Keep the grid
      // quiet during the configured settlement window so no ordinary exit or
      // new entry can race the account-wide D-068 calculation.  This does not
      // alter the account-day baseline or any risk-ladder timing.
      applyTrancheExitPause(true);
      for (const book of instruments) applyEntryBrake(book, true);
      return Object.freeze({
        action: "ROLLOVER_HARVEST_WAITING",
        combinedDayPnlUsd: combined,
        waitRemainingMs,
        harvest: prior
      });
    }
    let plan;
    const target = rolloverHarvestTarget();
    try {
      plan = prior.mode === "ROLLOVER_PARTIAL" && rolloverPlanEntries(prior.plan).length > 0
        ? prior.plan
        : await buildRolloverPlan(incomingDayKey, target.thresholdUsd);
    } catch (error) {
      // Candidate pricing/readiness is transient at startup and reconnect. It
      // blocks only this optional partial-harvest calculation; it must not
      // create a durable safety halt or exclude a ticket from a partial plan.
      await addEvent("WARN", "D068_ROLLOVER_HARVEST_WAITING_FOR_TICKETS", {
        dayKey: incomingDayKey,
        error: error?.message ?? "rollover ticket read failed"
      });
      return null;
    }
    if (!plan) return null;
    const pending = prior.status === "PENDING"
      ? prior
      : await saveHarvest({
          dayKey: incomingDayKey,
          status: "PENDING",
          mode: "ROLLOVER_PARTIAL",
          plan,
          triggerPnlUsd: combined,
          confirmedAt: null,
          haltReason: null
        });
    applyHarvestGates();
    if (prior.status !== "PENDING") {
      await addEvent("WARN", "D068_ROLLOVER_HARVEST_PENDING", {
        dayKey: incomingDayKey,
        combinedDayPnlUsd: combined,
        threshold: plan.targetUsd,
        targetPhase: target.phase,
        netCarriedPnlUsd: plan.totalUnrealisedPnlUsd,
        totalProfitablePnlUsd: plan.totalProfitablePnlUsd,
        plannedProfitUsd: plan.plannedUsd,
        allocations: rolloverPlanEntries(plan)
      });
      notifications?.enqueue?.({ kind: "HARVEST_PENDING", mode: "ROLLOVER_PARTIAL", eventKey: `D068-PENDING:${incomingDayKey.replaceAll("-", "")}`, combinedDayPnlUsd: combined, thresholdUsd: plan.targetUsd });
    }

    const completed = new Set(Array.isArray(pending.plan?.completed) ? pending.plan.completed : []);
    let active = { ...plan, completed: [...completed] };
    const results = [];
    for (const reading of readings) {
      const allocations = rolloverPlanEntries(active).filter((item) => item.instrument === reading.instrument && !completed.has(`${item.instrument}:${item.lotId}`));
      if (allocations.length === 0) continue;
      if (typeof reading.book.executeRolloverHarvest !== "function") throw new Error(`${reading.instrument} cannot execute rollover harvest`);
      const result = await reading.book.executeRolloverHarvest({
        dayKey: incomingDayKey,
        allocations,
        onConfirmedClose: async (close) => {
          completed.add(`${close.instrument}:${close.lotId}`);
          active = { ...active, completed: [...completed] };
          await saveHarvest({
            dayKey: incomingDayKey,
            status: "PENDING",
            mode: "ROLLOVER_PARTIAL",
            plan: active,
            triggerPnlUsd: pending.triggerPnlUsd,
            confirmedAt: null,
            haltReason: null
          });
        }
      });
      results.push({ instrument: reading.instrument, result });
      if (result.pending.length > 0) break;
    }
    const pendingResults = results.flatMap((item) => item.result.pending.map((entry) => ({ instrument: item.instrument, ...entry })));
    if (pendingResults.length > 0) {
      // D-068 is an optional proportional profit take, not a protective
      // close.  Before any close is confirmed, a changed/missing/rejected
      // ticket must leave the account untouched and return normal operation
      // with an operator-visible warning.  A new account-wide snapshot will
      // be considered on the next evaluation; no ticket is excluded.
      if (completed.size === 0) {
        const ready = await saveHarvest({
          dayKey: incomingDayKey,
          status: "READY",
          mode: "FULL",
          plan: null,
          triggerPnlUsd: null,
          confirmedAt: null,
          haltReason: null
        });
        applyHarvestGates();
        await addEvent("WARN", "D068_ROLLOVER_HARVEST_DEFERRED", {
          dayKey: incomingDayKey,
          combinedDayPnlUsd: combined,
          threshold: plan.targetUsd,
          pending: pendingResults
        });
        notifications?.enqueue?.({
          kind: "HARVEST_DEFERRED",
          mode: "ROLLOVER_PARTIAL",
          eventKey: `D068-DEFERRED:${incomingDayKey.replaceAll("-", "")}`,
          thresholdUsd: plan.targetUsd,
          pending: pendingResults
        });
        return Object.freeze({ action: "HARVEST_DEFERRED", combinedDayPnlUsd: combined, results: Object.freeze(results), harvest: ready });
      }
      // Some closes have already been broker-confirmed.  Retain their durable
      // plan and retry the remaining idempotent work without turning this
      // optional harvest into a safety halt.
      return Object.freeze({ action: "HARVEST_PENDING", combinedDayPnlUsd: combined, results: Object.freeze(results), harvest: harvestState });
    }
    active = { ...active, confirmation: { source: "BROKER_CONFIRMED", at: new Date(now()).toISOString() } };
    const confirmed = await saveHarvest({
      dayKey: incomingDayKey,
      status: "CONFIRMED",
      mode: "ROLLOVER_PARTIAL",
      plan: active,
      triggerPnlUsd: pending.triggerPnlUsd,
      confirmedAt: new Date(now()).toISOString(),
      haltReason: null
    });
    applyHarvestGates();
    try {
      await onRolloverHarvestConfirmed();
    } catch (error) {
      // The broker-confirmed harvest is already durable.  A best-effort timer
      // reset must never turn it into a safety halt or change its result.
      try {
        await addEvent("WARN", "D068_EXPOSURE_POOL_CLOCK_RESET_DEFERRED", { dayKey: incomingDayKey, error: error?.message ?? "exposure pool clock save failed" });
      } catch { /* audit storage is unavailable too */ }
    }
    for (const book of instruments) if (!stickyBrake(book.instrument)) applyEntryBrake(book, false);
    await addEvent("WARN", "D068_ROLLOVER_HARVEST_CONFIRMED", {
      dayKey: incomingDayKey,
      combinedDayPnlUsd: combined,
      threshold: plan.targetUsd,
      netCarriedPnlUsd: plan.totalUnrealisedPnlUsd,
      totalProfitablePnlUsd: plan.totalProfitablePnlUsd,
      plannedProfitUsd: plan.plannedUsd,
      closes: results.flatMap((item) => item.result.closed)
    });
    notifications?.enqueue?.({ kind: "HARVEST_CONFIRMED", mode: "ROLLOVER_PARTIAL", eventKey: `D068-CONFIRMED:${incomingDayKey.replaceAll("-", "")}`, combinedDayPnlUsd: combined, thresholdUsd: plan.targetUsd, confirmedAt: confirmed.confirmedAt });
    return Object.freeze({ action: "HARVEST_CONFIRMED", combinedDayPnlUsd: combined, results: Object.freeze(results), harvest: confirmed });
  }

  function harvestResultWasRateLimited(result) {
    return Array.isArray(result?.results) && result.results.some((entry) => {
      const detail = String(entry?.result?.reason ?? "");
      return /\b429\b|rate[ -]?limit/i.test(detail);
    });
  }

  async function runHarvest(args) {
    const nowMs = now();
    if (harvestRunInFlight !== null) return harvestRunInFlight;
    if (harvestRetryAtMs !== null && nowMs < harvestRetryAtMs) {
      const harvest = await loadHarvest(args.incomingDayKey);
      applyHarvestGates();
      return Object.freeze({
        action: "HARVEST_RETRY_WAIT",
        combinedDayPnlUsd: args.combined,
        waitRemainingMs: harvestRetryAtMs - nowMs,
        harvest
      });
    }

    harvestRunInFlight = (async () => {
      const prior = await loadHarvest(args.incomingDayKey);
      const result = prior.mode === "ROLLOVER_PARTIAL"
        ? await runRolloverHarvest(args)
        : await runFullHarvest(args);

      if (result.action === "HARVEST_PENDING") {
        const rateLimited = harvestResultWasRateLimited(result);
        const retryMs = rateLimited
          ? Math.max(harvestRetryMs, RATE_LIMIT_HARVEST_RETRY_MS)
          : harvestRetryMs;
        harvestRetryAtMs = now() + retryMs;
        if (rateLimited) {
          await addEvent("WARN", "D064_HARVEST_RATE_LIMIT_BACKOFF", {
            dayKey: args.incomingDayKey,
            retryMs,
            results: result.results?.map((entry) => ({
              instrument: entry.instrument,
              status: entry.result?.status ?? "UNKNOWN"
            })) ?? []
          });
        }
      } else {
        harvestRetryAtMs = null;
      }
      return result;
    })();

    try {
      return await harvestRunInFlight;
    } finally {
      harvestRunInFlight = null;
    }
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
      let entryBrakePnlSource = "UNAVAILABLE";
      try {
        unrealisedUsd = Number(book.getUnrealisedUsd()) || 0;
        dayPnlUsd = Number(book.getDayPnlUsd()) || 0;
        exposureUsd = Number(book.getExposureUsd()) || 0;
        if (typeof book.getEntryBrakePnlSource === "function") entryBrakePnlSource = String(book.getEntryBrakePnlSource());
      } catch {
        readFailed = true;
      }
      return { book, instrument: book.instrument, unrealisedUsd, dayPnlUsd, exposureUsd, entryBrakePnlSource, readFailed };
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

      await loadEntryBrakes(incomingDayKey);
      // A Railway restart creates fresh grid instances. Reapply any durable
      // account-day brakes before considering the first broker snapshot.
      for (const book of instruments) applyEntryBrake(book, stickyBrake(book.instrument));

      const readings = readBooks();
      const unreadable = readings.filter((r) => r.readFailed);
      if (unreadable.length > 0) {
        const nowMs = now();
        if (unreadSinceMs === null) {
          unreadSinceMs = nowMs;
        }
        if (sessionHarvestEnabled) {
          const priorEpisode = await loadFreshnessEpisode();
          // Do not create an operator alert episode until this worker has seen
          // one complete snapshot. An existing persisted episode survives a
          // Railway restart and must continue its original timer.
          if (hasSuccessfulRead || priorEpisode.status === "ACTIVE") {
            await noteFreshnessOutage(nowMs, unreadable.map((r) => r.instrument));
            const outageAlert = await noteFreshnessOutageAlert(nowMs);
            if (outageAlert.alerted) {
              await addEvent("WARN", "D064_FRESH_DATA_OUTAGE_ALERTED", {
                dayKey: incomingDayKey,
                instruments: outageAlert.episode.instruments,
                episodeId: outageAlert.episode.episodeId,
                alertAfterMs: freshnessAlertAfterMs
              });
              notifications?.enqueue?.({
                kind: "HARVEST_FRESHNESS_GRACE",
                eventKey: `D064-FRESH-OUTAGE:${outageAlert.episode.episodeId}`,
                instruments: outageAlert.episode.instruments,
                graceMs: freshnessRecoveredAfterMs,
                alertAfterMs: freshnessAlertAfterMs
              });
            }
          }
        }
        for (const reading of readings) {
          // DXtrade-read outages are alert-only. Keep independent brakes such
          // as a booked loss tier or an unconfirmed protective cut intact, but
          // do not turn an unavailable snapshot into a grid-entry stop.
          applyEntryBrake(reading.book, stickyBrake(reading.instrument));
        }
        lastError = `Cannot read ${unreadable.map((r) => r.instrument).join(", ")}`;
        return Object.freeze({
          action: "ACCOUNT_DATA_UNAVAILABLE",
          instruments: unreadable.map((r) => r.instrument),
          outageMs: Math.max(0, nowMs - unreadSinceMs)
        });
      }
      lastError = null;
      hasSuccessfulRead = true;
      unreadSinceMs = null;
      if (sessionHarvestEnabled) {
        const recovery = await noteFreshnessRead(now());
        if (recovery.restored && recovery.episode.alertedAtMs !== null) {
          const outageMs = recovery.episode.startedAtMs === null ? null : Math.max(0, now() - recovery.episode.startedAtMs);
          await addEvent("WARN", "D064_FRESH_DATA_RESTORED", { episodeId: recovery.episode.episodeId, outageMs, instruments: recovery.episode.instruments });
          notifications?.enqueue?.({ kind: "HARVEST_FRESHNESS_RESTORED", eventKey: `D064-FRESH-RESTORED:${recovery.episode.episodeId}`, outageMs, instruments: recovery.episode.instruments });
        }
      }

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

      const totalUnrealisedUsd = fixed2(readings.reduce((sum, r) => sum + r.unrealisedUsd, 0));

      // cutTiers is sorted deepest-first. A tier fires when open loss breaches
      // it and either escalates beyond the deepest tier already fired, or the
      // single ladder cooldown has elapsed.
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
          // Start the ladder cooldown when the cut batch is dispatched so a
          // broken broker path cannot receive an order attempt on every tick.
          const cutStartedAtMs = now();
          lastCutAtMs = cutStartedAtMs;
          const results = [];
          for (const allocation of allocations) {
            const reading = readings.find((r) => r.instrument === allocation.instrument);
            try {
              results.push({
                instrument: allocation.instrument,
                fraction: allocation.fraction,
                result: await reading.book.executeProtectiveCut({
                  fraction: allocation.fraction,
                  reason: `D-063 tier cut ${(activeTier.fraction * 100).toFixed(0)}% at unrealised ${totalUnrealisedUsd.toFixed(2)} (tier -${activeTier.thresholdUsd}, combined ${combined.toFixed(2)}, this book ${allocation.unrealisedLossUsd.toFixed(2)} = ${(allocation.share * 100).toFixed(1)}% of the loss)`,
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
          if (anyFilled) {
            cutsToday += 1;
            deepestCutTierFiredUsd = Math.max(deepestCutTierFiredUsd, activeTier.thresholdUsd);
          }
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
            nextCutEligibleAt: new Date(cutStartedAtMs + cutCooldownMs).toISOString(),
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
        if (reading.unrealisedUsd <= -entryBrakeUsd) {
          brakedToday.add(reading.instrument);
          applyEntryBrake(reading.book, true);
          newlyBraked.push(reading.instrument);
        }
      }

      if (newlyBraked.length > 0) await saveEntryBrakes(incomingDayKey);

      for (const reading of readings) {
        if (!stickyBrake(reading.instrument)) applyEntryBrake(reading.book, false);
      }

      if (newlyBraked.length > 0) {
        await addEvent("WARN", "RISK_SUPERVISOR_ENTRY_BRAKE", {
          instruments: newlyBraked,
          threshold: -entryBrakeUsd,
          combinedDayPnlUsd: combined,
          readings: readings.filter((reading) => newlyBraked.includes(reading.instrument)).map((reading) => ({
            instrument: reading.instrument,
            unrealisedUsd: fixed2(reading.unrealisedUsd),
            source: reading.entryBrakePnlSource
          }))
        });
        return Object.freeze({ action: "BRAKE", instruments: Object.freeze(newlyBraked), combinedDayPnlUsd: combined });
      }

      if (sessionHarvestEnabled) {
        const rollover = await runRolloverHarvest({ incomingDayKey, combined, readings });
        if (rollover !== null) return rollover;
        if (combined >= sessionHarvestThreshold) return runHarvest({ incomingDayKey, combined, readings });
      }

      return Object.freeze({ action: "NONE", combinedDayPnlUsd: combined });
    } finally {
      evaluating = false;
    }
  }

  async function recoverHarvest({ dayKey: incomingDayKey, booksVerified = false, recoveryKind = "FRESH_DATA" } = {}) {
    if (!sessionHarvestEnabled) return Object.freeze({ action: "HARVEST_DISABLED" });
    if (typeof incomingDayKey !== "string" || incomingDayKey === "") throw new TypeError("recoverHarvest requires a dayKey");
    if (booksVerified !== true) return Object.freeze({ action: "HARVEST_RECOVERY_REFUSED" });
    if (recoveryKind !== "FRESH_DATA" && recoveryKind !== "VERIFIED_FLAT" && recoveryKind !== "ROLLOVER_UNVERIFIED") {
      return Object.freeze({ action: "HARVEST_RECOVERY_REFUSED" });
    }
    if (incomingDayKey !== dayKey) rollover(incomingDayKey);
    const prior = await loadHarvest(incomingDayKey);
    const unverifiedRolloverConfirmation = recoveryKind === "ROLLOVER_UNVERIFIED" && isUnverifiedRolloverConfirmation(prior);
    if (prior.status !== "HALTED" && !unverifiedRolloverConfirmation) return Object.freeze({ action: "HARVEST_NOT_HALTED", harvest: prior });
    const freshDataRecovery = recoveryKind === "FRESH_DATA" && isFreshDataHarvestHalt(prior.haltReason);
    const verifiedFlatRecovery = recoveryKind === "VERIFIED_FLAT" && isFlatConfirmationHarvestHalt(prior.haltReason);
    const rolloverUnverifiedRecovery = recoveryKind === "ROLLOVER_UNVERIFIED" && isUnverifiedRolloverHarvestHalt(prior);
    if (!freshDataRecovery && !verifiedFlatRecovery && !rolloverUnverifiedRecovery && !unverifiedRolloverConfirmation) {
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
      // At least one broker close was confirmed.  Do not reset to READY and
      // re-test today's P&L: realised P&L can fall below the threshold between
      // execution and this verification.  Confirm the original harvest,
      // retain its trigger, release only harvest entry brakes, and keep
      // ordinary tranche exits paused until the account-day reset.
      const confirmed = await saveHarvest({
        dayKey: incomingDayKey,
        status: "CONFIRMED",
        mode: prior.mode ?? "FULL",
        plan: prior.plan ?? null,
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
    await saveHarvest({ dayKey: incomingDayKey, status: "READY", mode: "FULL", plan: null, triggerPnlUsd: null, confirmedAt: null, haltReason: null });
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
    const totalUnrealisedUsd = fixed2(readings.reduce((sum, r) => sum + r.unrealisedUsd, 0));
    const activeCutTier = cutTiers.find((tier) => totalUnrealisedUsd <= -tier.thresholdUsd) ?? null;
    const activeCutCooldownRemainingMs = lastCutAtMs === null
      ? 0
      : Math.max(0, cutCooldownMs - (now() - lastCutAtMs));
    const rolloverHarvestDelayRemainingMs = sessionHarvestEnabled && harvestState?.status === "READY" && dayKey !== null
      ? rolloverHarvestWaitRemainingMs(dayKey, rolloverHarvestDelayMs, now())
      : 0;
    return Object.freeze({
      dayKey,
      dayPnlUsd,
      exposureUsd,
      unrealisedUsd: totalUnrealisedUsd,
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
      rolloverHarvestDelayMinutes: sessionHarvestEnabled ? rolloverHarvestDelayMinutes : null,
      rolloverHarvestDelayRemainingMs,
      harvestRetryRemainingMs: harvestRetryAtMs === null ? 0 : Math.max(0, harvestRetryAtMs - now()),
      freshDataGrace: unreadSinceMs === null
        ? null
        : Object.freeze({
          sinceMs: unreadSinceMs,
          outageMs: Math.max(0, now() - unreadSinceMs)
        }),
      harvestedToday: harvestState?.status === "CONFIRMED",
      trancheExitsPaused: ["PENDING", "CONFIRMED", "HALTED"].includes(harvestState?.status) || rolloverHarvestDelayRemainingMs > 0,
      cutsToday,
      cutCooldownMs,
      deepestCutTierFiredUsd,
      // Whether the ladder can actually execute. This is the line that would
      // have made 2026-09-19 obvious from a single /status.
      protectionFailing,
      consecutiveFailedCuts,
      protectionFailingSinceMs,
      lastProtectionFailureReason,
      // The same live-loss figure used to select the partial-cut tier.
      totalUnrealisedUsd,
      activeCutTierThresholdUsd: activeCutTier?.thresholdUsd ?? null,
      cutCooldownRemainingMs: activeCutCooldownRemainingMs,
      lastCutAtMs,
      lastError,
      perInstrument: Object.freeze(readings.map((r) => Object.freeze({
        instrument: r.instrument,
        dayPnlUsd: fixed2(r.dayPnlUsd),
        unrealisedUsd: fixed2(r.unrealisedUsd),
        exposureUsd: fixed2(r.exposureUsd),
        entryBrakePnlSource: r.entryBrakePnlSource,
        braked: brakedToday.has(r.instrument),
        // Whether this book would be cut if a tier fired right now.
        cuttable: r.unrealisedUsd < 0,
        readFailed: r.readFailed
      })))
    });
  }

  return Object.freeze({ evaluate, recoverHarvest, executeDeferredFullFlatten, getSnapshot, allocateProportionalCut });
}
