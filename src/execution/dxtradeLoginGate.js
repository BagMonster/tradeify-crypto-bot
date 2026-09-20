/**
 * Process-wide gate for DXtrade authentication.
 *
 * WHY THIS EXISTS
 *
 * This deployment holds six DXtrade sessions: one account monitor and one
 * execution client per instrument. They all use the same credentials, so when
 * the broker invalidates the session it is invalidated for all of them at the
 * same moment. On 2026-09-19 exactly that happened and four books reported
 * ACCOUNT_DATA_UNAVAILABLE within the same tick.
 *
 * Each client already guards against re-authenticating twice concurrently,
 * but that guard is per instance. Six instances each deciding independently
 * that they are the only one produces six near-simultaneous /login calls, and
 * DXtrade answers with HTTP 429 "Too many requests". Observed live on
 * 2026-09-20: a six-session rotation issued up to twelve auth requests in
 * 1,503ms and four of the six failed.
 *
 * That failure mode is worse than the bug it was meant to fix. A session that
 * dies for every client at once is the normal case, so without this gate the
 * recovery path would reliably fail in precisely the situation it exists for.
 *
 * WHAT IT DOES
 *
 * Every login in the process passes through one queue. Logins run one at a
 * time with a minimum gap between them, and a 429 is retried with increasing
 * backoff rather than being surfaced as a dead session.
 */

const DEFAULT_MIN_SPACING_MS = 1_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_BACKOFF_MS = 1_500;

function isRateLimited(error) {
  if (error?.status === 429) return true;
  const message = typeof error?.message === "string" ? error.message : "";
  return message.includes("429") || message.toLowerCase().includes("too many requests");
}

// Deliberately NOT unref'd. A login in flight should hold the process open
// for the fraction of a second it needs; letting Node exit midway through
// re-authentication is worse than a brief delay on shutdown.
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export function createDxtradeLoginGate({
  minSpacingMs = DEFAULT_MIN_SPACING_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
  now = () => Date.now(),
  wait = sleep
} = {}) {
  if (!Number.isFinite(minSpacingMs) || minSpacingMs < 0) throw new TypeError("minSpacingMs must be a non-negative number");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError("maxAttempts must be a positive integer");

  // The queue is a promise chain. Each caller appends itself to the tail, so
  // logins run strictly one at a time in arrival order no matter how many
  // clients ask at once.
  let tail = Promise.resolve();
  let lastCompletedAt = null;
  let totalLogins = 0;
  let totalRateLimited = 0;

  async function runSpaced(label, perform) {
    if (lastCompletedAt !== null) {
      const sinceLast = now() - lastCompletedAt;
      if (sinceLast < minSpacingMs) await wait(minSpacingMs - sinceLast);
    }
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await perform();
        totalLogins += 1;
        lastCompletedAt = now();
        return result;
      } catch (error) {
        lastError = error;
        lastCompletedAt = now();
        if (!isRateLimited(error) || attempt === maxAttempts) throw error;
        totalRateLimited += 1;
        const backoffMs = baseBackoffMs * attempt;
        console.warn(`DXtrade login for ${label} was rate limited (attempt ${attempt}/${maxAttempts}); retrying in ${backoffMs}ms`);
        await wait(backoffMs);
      }
    }
    throw lastError;
  }

  return Object.freeze({
    /**
     * Queue a login. `perform` should do the actual /login request and nothing
     * else - it runs while the gate is held, so keep it short.
     */
    async login(label, perform) {
      if (typeof perform !== "function") throw new TypeError("perform must be a function");
      const run = tail.then(() => runSpaced(String(label ?? "unnamed"), perform));
      // Keep the chain alive even when this caller's login rejects, otherwise
      // one failure would wedge the queue for every client behind it.
      tail = run.catch(() => {});
      return run;
    },

    getStats() {
      return Object.freeze({
        totalLogins,
        totalRateLimited,
        lastCompletedAt,
        minSpacingMs
      });
    }
  });
}

/**
 * The gate every DXtrade client in this process shares.
 *
 * A module-level singleton is deliberate: the whole point is that separate
 * client instances cannot each believe they are the only one authenticating.
 */
export const dxtradeLoginGate = createDxtradeLoginGate();
