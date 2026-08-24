const BASE_URL = "https://data-api.binance.vision";
const DAY_MS = 86_400_000;
const DEFAULT_SYMBOL = "SOLUSDT";
const DEFAULT_DAYS = 200;

function symbol(value) {
  if (typeof value !== "string" || !/^[A-Z0-9]{5,20}$/.test(value.trim())) {
    throw new TypeError("Binance symbol must be uppercase alphanumeric");
  }
  return value.trim();
}

function positiveInteger(name, value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

async function jsonResponse(response) {
  if (!response || typeof response.ok !== "boolean" || !Number.isInteger(response.status)) {
    throw new Error("Binance MA response is invalid");
  }
  if (!response.ok) throw new Error(`Binance MA request failed with HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error("Binance MA response is not valid JSON");
  }
}

export function createBinanceDailyMaProvider({
  marketSymbol = DEFAULT_SYMBOL,
  days = DEFAULT_DAYS,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000
} = {}) {
  const activeSymbol = symbol(marketSymbol);
  positiveInteger("days", days, 2, 1000);
  positiveInteger("timeoutMs", timeoutMs, 500, 60_000);
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");

  let cache = null;
  let inFlight = null;

  async function request(path, query = {}) {
    const url = new URL(path, BASE_URL);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await jsonResponse(await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: controller.signal
      }));
    } finally {
      clearTimeout(timer);
    }
  }

  async function refresh() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const timePayload = await request("/api/v3/time");
      const serverTime = Number(timePayload?.serverTime);
      if (!Number.isSafeInteger(serverTime) || serverTime <= 0) throw new Error("Binance server time is invalid");
      const currentUtcDayStart = Math.floor(serverTime / DAY_MS) * DAY_MS;
      const rows = await request("/api/v3/klines", {
        symbol: activeSymbol,
        interval: "1d",
        endTime: currentUtcDayStart - 1,
        limit: days
      });
      if (!Array.isArray(rows) || rows.length !== days) {
        throw new Error(`Binance ${activeSymbol} MA requires exactly ${days} completed daily candles`);
      }

      let sum = 0;
      let priorOpenTime = null;
      for (const row of rows) {
        if (!Array.isArray(row) || row.length < 7) throw new Error("Binance daily candle is malformed");
        const openTime = Number(row[0]);
        const close = Number(row[4]);
        const closeTime = Number(row[6]);
        if (!Number.isSafeInteger(openTime) || openTime % DAY_MS !== 0) throw new Error("Binance daily candle is not UTC aligned");
        if (!Number.isSafeInteger(closeTime) || closeTime !== openTime + DAY_MS - 1) throw new Error("Binance daily candle close boundary is invalid");
        if (closeTime >= currentUtcDayStart) throw new Error("Binance MA included an incomplete UTC day");
        if (!Number.isFinite(close) || close <= 0) throw new Error("Binance daily close is invalid");
        if (priorOpenTime !== null && openTime !== priorOpenTime + DAY_MS) throw new Error("Binance MA history contains a gap");
        priorOpenTime = openTime;
        sum += close;
      }

      cache = Object.freeze({
        symbol: activeSymbol,
        days,
        ma: sum / days,
        completedThrough: new Date(rows.at(-1)[0] + DAY_MS).toISOString(),
        utcDayStart: currentUtcDayStart,
        refreshedAt: new Date(serverTime).toISOString()
      });
      return cache;
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  async function getCurrent() {
    if (!cache || Date.now() >= cache.utcDayStart + DAY_MS) return refresh();
    return cache;
  }

  function peek() {
    return cache;
  }

  return Object.freeze({ refresh, getCurrent, peek, symbol: activeSymbol, days });
}
