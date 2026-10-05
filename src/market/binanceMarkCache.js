const DEFAULT_REST_BASE_URL = "https://data-api.binance.vision";
const DEFAULT_REFRESH_AFTER_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_MAX_CACHED_MARK_AGE_MS = 60_000;

function marketSymbol(value) {
  if (typeof value !== "string" || !/^[A-Z0-9]{5,20}$/.test(value)) {
    throw new TypeError("Binance mark symbol must be uppercase alphanumeric");
  }
  return value;
}

function positive(name, value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError(`${name} must be a positive finite number`);
  return number;
}

function whole(name, value, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name} must be an integer >= ${minimum}`);
  return value;
}

/**
 * Non-blocking Binance REST fallback for ticket marking.
 *
 * The risk supervisor never awaits this cache.  A caller may ask it to refresh,
 * but every request is single-flight and rate-limited per instrument; reads are
 * always from the most recently completed price.  This prevents quiet trade
 * streams from becoming account-wide risk outages without creating a REST storm.
 */
export function createBinanceMarkCache({
  symbol,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  restBaseUrl = DEFAULT_REST_BASE_URL,
  refreshAfterMs = DEFAULT_REFRESH_AFTER_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxCachedMarkAgeMs = DEFAULT_MAX_CACHED_MARK_AGE_MS
} = {}) {
  const configuredSymbol = marketSymbol(symbol);
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (typeof restBaseUrl !== "string" || !/^https:\/\//.test(restBaseUrl)) throw new TypeError("restBaseUrl must be an https URL");
  whole("refreshAfterMs", refreshAfterMs, 250);
  whole("timeoutMs", timeoutMs, 250);
  whole("maxCachedMarkAgeMs", maxCachedMarkAgeMs, refreshAfterMs);

  let cached = null;
  let inFlight = null;
  let lastAttemptAtMs = null;
  let lastError = null;

  function state() {
    return Object.freeze({
      symbol: configuredSymbol,
      cached: cached === null ? null : Object.freeze({ ...cached }),
      refreshing: inFlight !== null,
      lastAttemptAtMs,
      lastError
    });
  }

  function due(nowMs) {
    return lastAttemptAtMs === null || nowMs - lastAttemptAtMs >= refreshAfterMs;
  }

  function refreshIfDue() {
    const nowMs = now();
    if (inFlight !== null || !due(nowMs)) return inFlight;
    lastAttemptAtMs = nowMs;
    lastError = null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    const url = `${restBaseUrl}/api/v3/ticker/price?symbol=${configuredSymbol}`;
    inFlight = Promise.resolve()
      .then(() => fetchImpl(url, { signal: controller.signal }))
      .then(async (response) => {
        if (!response?.ok) throw new Error(`Binance REST mark returned HTTP ${response?.status ?? "unknown"}`);
        const body = await response.json();
        const price = positive("Binance REST mark price", body?.price);
        cached = Object.freeze({ price, markedAtMs: now(), source: "BINANCE_REST_MARK" });
        lastError = null;
        return cached;
      })
      .catch((error) => {
        lastError = error instanceof Error ? error.message : "Binance REST mark failed";
        return null;
      })
      .finally(() => {
        clearTimeout(timeout);
        inFlight = null;
      });
    return inFlight;
  }

  function read({ connected, tradeQuiet = false, lastTrade } = {}) {
    const price = Number(lastTrade?.price);
    const tradeAtMs = Date.parse(lastTrade?.tradeTime ?? "");
    const nowMs = now();
    const cachedFresh = cached !== null && nowMs - cached.markedAtMs <= maxCachedMarkAgeMs;
    // A live connection remains the primary source even if this is a quiet
    // market. The non-blocking REST refresh independently confirms the mark.
    if (connected === true && Number.isFinite(price) && price > 0) {
      refreshIfDue();
      if (cachedFresh) return cached;
      // A quiet-but-open trade stream may legitimately have no messages. Keep
      // its last trade while the REST confirmation is in flight; once the
      // confirmation fails, fail closed only for this instrument.
      if (tradeQuiet === true && inFlight === null && lastError !== null) return null;
      return Object.freeze({ price, markedAtMs: Number.isFinite(tradeAtMs) ? tradeAtMs : now(), source: "BINANCE_TRADE_MARK" });
    }
    // A dead socket asks REST to refresh, but never waits in the risk path.
    refreshIfDue();
    return cachedFresh ? cached : null;
  }

  return Object.freeze({ read, refreshIfDue, getState: state });
}
