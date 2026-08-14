const BINANCE_MARKET_DATA_BASE_URL = "https://data-api.binance.vision";
const BINANCE_SOURCE = "binance";
const BINANCE_SYMBOL = "BTCUSDT";
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HISTORY_DAYS = 365;
const DEFAULT_PAGE_LIMIT = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_PAGES_PER_TIMEFRAME = 100;

export const BINANCE_BACKFILL_INTERVAL_MS = Object.freeze({
  "15m": 15 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": DAY_MS
});

const BACKFILL_TIMEFRAMES = Object.freeze(Object.keys(BINANCE_BACKFILL_INTERVAL_MS));

function requireInteger(name, value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function requireTimeframe(timeframe) {
  if (!BINANCE_BACKFILL_INTERVAL_MS[timeframe]) {
    throw new Error("timeframe must be 15m, 4h, or 1d");
  }
  return timeframe;
}

function requireDatabase(database) {
  if (!database || typeof database.getBarCoverage !== "function" ||
      typeof database.upsertBars !== "function") {
    throw new Error("database must provide getBarCoverage and upsertBars");
  }
  return database;
}

function requireClient(client) {
  if (!client || typeof client.getServerTime !== "function" ||
      typeof client.getKlines !== "function") {
    throw new Error("client must provide getServerTime and getKlines");
  }
  return client;
}

function asFiniteNumber(name, value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be finite`);
  return number;
}

function asPositiveNumber(name, value) {
  const number = asFiniteNumber(name, value);
  if (number <= 0) throw new Error(`${name} must be greater than zero`);
  return number;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class BinanceMarketDataError extends Error {
  constructor(status) {
    super(`Binance market-data request failed with HTTP ${status}`);
    this.name = "BinanceMarketDataError";
    this.status = status;
  }
}

function isRetryable(error) {
  return error?.name === "AbortError" ||
    error?.name === "TypeError" ||
    error?.status === 429 ||
    (Number.isInteger(error?.status) && error.status >= 500 && error.status <= 599);
}

async function parseJsonResponse(response) {
  if (!response || typeof response.ok !== "boolean" || !Number.isInteger(response.status)) {
    throw new Error("Binance market-data response is invalid");
  }
  if (!response.ok) throw new BinanceMarketDataError(response.status);

  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 2_000_000) {
    throw new Error("Binance market-data response is unexpectedly large");
  }

  try {
    return await response.json();
  } catch {
    throw new Error("Binance market-data response is not valid JSON");
  }
}

export function normalizeBinanceKline(row, { timeframe, completedThrough }) {
  const normalizedTimeframe = requireTimeframe(timeframe);
  const intervalMs = BINANCE_BACKFILL_INTERVAL_MS[normalizedTimeframe];
  const completionBoundary = requireInteger("completedThrough", completedThrough, { minimum: 1 });

  if (!Array.isArray(row) || row.length !== 12) {
    throw new Error("Binance kline must contain exactly 12 fields");
  }

  const openTime = requireInteger("Binance kline open time", row[0], { minimum: 1 });
  const closeTimeInclusive = requireInteger("Binance kline close time", row[6], { minimum: 1 });
  const closeTimeExclusive = openTime + intervalMs;
  if (openTime % intervalMs !== 0) {
    throw new Error(`Binance ${normalizedTimeframe} kline is not UTC-aligned`);
  }
  if (closeTimeInclusive !== closeTimeExclusive - 1) {
    throw new Error(`Binance ${normalizedTimeframe} kline has an invalid close boundary`);
  }
  if (closeTimeExclusive > completionBoundary) {
    throw new Error("Binance kline is not completed");
  }

  const open = asPositiveNumber("Binance kline open", row[1]);
  const high = asPositiveNumber("Binance kline high", row[2]);
  const low = asPositiveNumber("Binance kline low", row[3]);
  const close = asPositiveNumber("Binance kline close", row[4]);
  const volume = asFiniteNumber("Binance kline volume", row[5]);
  if (volume < 0) throw new Error("Binance kline volume must be non-negative");
  if (high < Math.max(open, low, close) || low > Math.min(open, high, close)) {
    throw new Error("Binance kline OHLC values are inconsistent");
  }

  return Object.freeze({
    source: BINANCE_SOURCE,
    symbol: BINANCE_SYMBOL,
    timeframe: normalizedTimeframe,
    openTime: new Date(openTime).toISOString(),
    closeTime: new Date(closeTimeExclusive).toISOString(),
    open,
    high,
    low,
    close,
    volume,
    isClosed: true
  });
}

export function createBinanceBackfillClient({
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxRetries = DEFAULT_MAX_RETRIES
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  if (typeof sleepImpl !== "function") throw new Error("sleep implementation is required");
  requireInteger("requestTimeoutMs", requestTimeoutMs, { minimum: 100, maximum: 60_000 });
  requireInteger("maxRetries", maxRetries, { minimum: 0, maximum: 5 });

  async function request(path, query = {}) {
    const url = new URL(path, BINANCE_MARKET_DATA_BASE_URL);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          headers: { accept: "application/json" },
          redirect: "error",
          signal: controller.signal
        });
        return await parseJsonResponse(response);
      } catch (error) {
        lastError = error;
        if (attempt === maxRetries || !isRetryable(error)) throw error;
        await sleepImpl(Math.min(250 * (2 ** attempt), 1_000));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }

  async function getServerTime() {
    const payload = await request("/api/v3/time");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Binance server-time response is invalid");
    }
    return requireInteger("Binance server time", payload.serverTime, { minimum: 1 });
  }

  async function getKlines({ timeframe, startTime, endTimeExclusive, limit }) {
    const normalizedTimeframe = requireTimeframe(timeframe);
    const intervalMs = BINANCE_BACKFILL_INTERVAL_MS[normalizedTimeframe];
    const normalizedStart = requireInteger("startTime", startTime, { minimum: 1 });
    const normalizedEnd = requireInteger("endTimeExclusive", endTimeExclusive, { minimum: 1 });
    const normalizedLimit = requireInteger("limit", limit, { minimum: 1, maximum: 1000 });
    if (normalizedStart % intervalMs !== 0 || normalizedEnd % intervalMs !== 0) {
      throw new Error("Binance kline request boundaries must be UTC-aligned");
    }
    if (normalizedStart >= normalizedEnd) {
      throw new Error("startTime must be before endTimeExclusive");
    }

    const payload = await request("/api/v3/klines", {
      symbol: BINANCE_SYMBOL,
      interval: normalizedTimeframe,
      startTime: normalizedStart,
      endTime: normalizedEnd - 1,
      timeZone: 0,
      limit: normalizedLimit
    });
    if (!Array.isArray(payload)) throw new Error("Binance kline response must be an array");
    if (payload.length > normalizedLimit) throw new Error("Binance returned more klines than requested");
    return payload;
  }

  return Object.freeze({ getServerTime, getKlines });
}

function coverageIsComplete(coverage, { expectedCount, startTime, endTimeExclusive }) {
  return coverage?.count === expectedCount &&
    coverage.firstOpenTime === new Date(startTime).toISOString() &&
    coverage.lastCloseTime === new Date(endTimeExclusive).toISOString();
}

export async function backfillBinanceHistory({
  database,
  client = createBinanceBackfillClient(),
  historyDays = DEFAULT_HISTORY_DAYS,
  pageLimit = DEFAULT_PAGE_LIMIT,
  logger = console
}) {
  requireDatabase(database);
  requireClient(client);
  requireInteger("historyDays", historyDays, { minimum: 1, maximum: 3660 });
  requireInteger("pageLimit", pageLimit, { minimum: 1, maximum: 1000 });

  const serverTime = await client.getServerTime();
  const summaries = [];

  for (const timeframe of BACKFILL_TIMEFRAMES) {
    const intervalMs = BINANCE_BACKFILL_INTERVAL_MS[timeframe];
    const endTimeExclusive = Math.floor(serverTime / intervalMs) * intervalMs;
    const startTime = endTimeExclusive - (historyDays * DAY_MS);
    const expectedCount = (endTimeExclusive - startTime) / intervalMs;
    const coverageRequest = {
      source: BINANCE_SOURCE,
      symbol: BINANCE_SYMBOL,
      timeframe,
      startTime,
      endTimeExclusive
    };

    const initialCoverage = await database.getBarCoverage(coverageRequest);
    if (coverageIsComplete(initialCoverage, { expectedCount, startTime, endTimeExclusive })) {
      summaries.push(Object.freeze({ timeframe, expectedCount, storedCount: 0, skipped: true }));
      logger.info?.(`Binance ${timeframe} backfill already complete (${expectedCount} bars).`);
      continue;
    }

    let cursor = startTime;
    let storedCount = 0;
    let pageCount = 0;
    while (cursor < endTimeExclusive) {
      pageCount += 1;
      if (pageCount > MAX_PAGES_PER_TIMEFRAME) {
        throw new Error(`Binance ${timeframe} backfill exceeded its page safety limit`);
      }

      const remaining = (endTimeExclusive - cursor) / intervalMs;
      const requestedLimit = Math.min(pageLimit, remaining);
      const rows = await client.getKlines({
        timeframe,
        startTime: cursor,
        endTimeExclusive,
        limit: requestedLimit
      });
      if (rows.length === 0) {
        throw new Error(`Binance ${timeframe} backfill ended before the requested range was complete`);
      }

      const bars = rows.map((row) => normalizeBinanceKline(row, {
        timeframe,
        completedThrough: endTimeExclusive
      }));
      for (const bar of bars) {
        const openTime = Date.parse(bar.openTime);
        if (openTime !== cursor) {
          throw new Error(`Binance ${timeframe} backfill contains a missing or duplicate bar`);
        }
        cursor += intervalMs;
      }
      if (cursor > endTimeExclusive) {
        throw new Error(`Binance ${timeframe} backfill exceeded the requested range`);
      }

      await database.upsertBars(bars);
      storedCount += bars.length;
    }

    const finalCoverage = await database.getBarCoverage(coverageRequest);
    if (!coverageIsComplete(finalCoverage, { expectedCount, startTime, endTimeExclusive })) {
      throw new Error(`Binance ${timeframe} backfill did not produce complete database coverage`);
    }

    summaries.push(Object.freeze({ timeframe, expectedCount, storedCount, skipped: false }));
    logger.info?.(`Binance ${timeframe} backfill stored ${storedCount} completed bars.`);
  }

  return Object.freeze({
    source: BINANCE_SOURCE,
    symbol: BINANCE_SYMBOL,
    serverTime: new Date(serverTime).toISOString(),
    historyDays,
    timeframes: Object.freeze(summaries)
  });
}
