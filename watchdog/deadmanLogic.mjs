/**
 * watchdog/deadmanLogic.mjs
 *
 * Pure decision logic for the deadman watchdog. No I/O, no imports from the bot, so
 * it can be tested exhaustively and cannot fail the way the bot fails.
 *
 * Two questions, answered separately:
 *   assess()  is the bot healthy right now, and if not, how is it unhealthy?
 *   decide()  given what we told the owner last time, should we message now?
 */

export const STATES = Object.freeze({
  HEALTHY: "HEALTHY",
  NO_HEARTBEAT: "NO_HEARTBEAT",               // the bot has never written its row
  PROCESS_DOWN: "PROCESS_DOWN",               // the bot has stopped writing at all
  EVALUATIONS_STOPPED: "EVALUATIONS_STOPPED", // writing, but no risk check completing
  WATCHDOG_DB_ERROR: "WATCHDOG_DB_ERROR"      // the watchdog cannot read Postgres
});

// A feed with no Binance trade for this long is named in the alert. Liquid pairs
// trade many times a minute, so two minutes of silence is already abnormal.
const FEED_STALE_SECONDS = 120;

function ageMs(iso, nowMs) {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? Math.max(0, nowMs - t) : null;
}

export function formatAge(ms) {
  if (!Number.isFinite(ms)) return "unknown";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 90) return `${totalSeconds}s`;
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 120) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function assess({ row, nowMs, staleAfterMs }) {
  if (!row) return Object.freeze({ state: STATES.NO_HEARTBEAT });

  const writtenAgeMs = ageMs(row.written_at, nowMs);
  const evaluationAgeMs = ageMs(row.last_evaluation_at, nowMs);
  const staleFeeds = Object.entries(row.feeds ?? {})
    .filter(([, seconds]) => seconds === null || (Number.isFinite(seconds) && seconds >= FEED_STALE_SECONDS))
    .map(([instrument, seconds]) => `${instrument} ${seconds === null ? "no trade yet" : `${seconds}s`}`);
  const common = { writtenAgeMs, evaluationAgeMs, staleFeeds, lastEvaluationAt: row.last_evaluation_at ?? null, profile: row.profile ?? null };

  if (writtenAgeMs === null || writtenAgeMs > staleAfterMs) {
    return Object.freeze({ state: STATES.PROCESS_DOWN, ...common });
  }
  if (evaluationAgeMs === null || evaluationAgeMs > staleAfterMs) {
    return Object.freeze({ state: STATES.EVALUATIONS_STOPPED, ...common });
  }
  return Object.freeze({ state: STATES.HEALTHY, ...common });
}

function message(assessment, { reminder }) {
  const prefix = reminder ? "(still) " : "";
  switch (assessment.state) {
    case STATES.PROCESS_DOWN:
      return [
        `🚨 ${prefix}DEADMAN: TRADING BOT IS SILENT`,
        `No heartbeat for ${formatAge(assessment.writtenAgeMs)}.`,
        "The bot process is down, hung, or cannot reach Postgres. No alerts, cuts or flattens can run.",
        "Check Railway: is the trading worker running and healthy?",
        "If positions are open and the bot does not come back, manage them in DXtrade directly."
      ].join("\n");
    case STATES.EVALUATIONS_STOPPED:
      return [
        `🚨 ${prefix}DEADMAN: RISK CHECKS HAVE STOPPED`,
        `The bot process is alive (heartbeat ${formatAge(assessment.writtenAgeMs)} ago), but no risk evaluation has completed for ${formatAge(assessment.evaluationAgeMs)}.`,
        assessment.staleFeeds?.length
          ? `Binance feeds with no recent trade: ${assessment.staleFeeds.join(", ")}.`
          : "Price feeds look alive, so an evaluation may be hung.",
        "The loss ladder is not running. Check /status and /health. A Railway restart clears a hung evaluation."
      ].join("\n");
    case STATES.NO_HEARTBEAT:
      return [
        `⚠️ ${prefix}DEADMAN: NO HEARTBEAT RECORDED YET`,
        "The watchdog is running, but the trading bot has never written its bot_liveness row.",
        "Either the bot is not running, or it is a version without the deadman heartbeat."
      ].join("\n");
    case STATES.WATCHDOG_DB_ERROR:
      return [
        `⚠️ ${prefix}DEADMAN WATCHDOG CANNOT READ POSTGRES`,
        `${assessment.failures} checks in a row failed.`,
        "The bot may be fine, but it is not being watched. Check the Postgres service in Railway."
      ].join("\n");
    default:
      return null;
  }
}

/**
 * previous: { state, sinceMs, lastAlertAtMs, alerted } or null on the first check.
 * Returns { send: string|null, next }.
 *
 *   - Healthy and nothing outstanding: silent.
 *   - Newly unhealthy: alert once.
 *   - Still unhealthy in the same way: remind every remindEveryMs.
 *   - Unhealthy in a DIFFERENT way: alert again with the new picture.
 *   - Healthy again after an alert: one recovery message with how long it lasted.
 */
export function decide({ previous, assessment, nowMs, remindEveryMs }) {
  const prior = previous ?? { state: STATES.HEALTHY, sinceMs: nowMs, lastAlertAtMs: null, alerted: false };

  if (assessment.state === STATES.HEALTHY) {
    const next = { state: STATES.HEALTHY, sinceMs: prior.state === STATES.HEALTHY ? prior.sinceMs : nowMs, lastAlertAtMs: null, alerted: false };
    if (prior.state !== STATES.HEALTHY && prior.alerted) {
      return Object.freeze({
        send: [
          "✅ DEADMAN: BOT HEARTBEAT RESTORED",
          `Risk checks are completing again after ${formatAge(nowMs - prior.sinceMs)} of trouble.`,
          "Run /status to confirm positions, the ladder and the exposure pool."
        ].join("\n"),
        next
      });
    }
    return Object.freeze({ send: null, next });
  }

  if (prior.state !== assessment.state) {
    // Keep the episode start when moving between unhealthy states, so the recovery
    // message reports the whole outage.
    const sinceMs = prior.state === STATES.HEALTHY ? nowMs : prior.sinceMs;
    return Object.freeze({
      send: message(assessment, { reminder: false }),
      next: { state: assessment.state, sinceMs, lastAlertAtMs: nowMs, alerted: true }
    });
  }

  if (prior.lastAlertAtMs === null || nowMs - prior.lastAlertAtMs >= remindEveryMs) {
    return Object.freeze({
      send: message(assessment, { reminder: prior.lastAlertAtMs !== null }),
      next: { ...prior, lastAlertAtMs: nowMs, alerted: true }
    });
  }
  return Object.freeze({ send: null, next: prior });
}
