const BTC_SYMBOL = "BTC/USD";
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_FRESH_AFTER_MS = 3_000;

function finite(name, value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${name} must be finite`);
  return number;
}

function nonNegativeInteger(name, value) {
  const number = finite(name, value);
  if (!Number.isInteger(number) || number < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return number;
}

function requireFunction(name, value) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  return value;
}

function extractMetric(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.metrics)) {
    throw new Error("DXtrade account metrics response must contain a metrics array");
  }
  if (payload.metrics.length !== 1) {
    throw new Error("DXtrade account metrics response must contain exactly one account");
  }
  return payload.metrics[0];
}

function normalizePositions(metric) {
  if (metric.positions === undefined) return Object.freeze([]);
  if (!Array.isArray(metric.positions)) throw new Error("DXtrade account metric positions must be an array");
  return Object.freeze(metric.positions.map((position, index) => {
    if (!position || typeof position !== "object" || Array.isArray(position)) {
      throw new Error(`DXtrade position metric ${index} must be an object`);
    }
    if (typeof position.symbol !== "string" || position.symbol.trim() === "") {
      throw new Error(`DXtrade position metric ${index} must contain a symbol`);
    }
    return Object.freeze({
      symbol: position.symbol.trim(),
      quantity: finite(`DXtrade position ${index} quantity`, position.quantity),
      markPrice: finite(`DXtrade position ${index} markPrice`, position.markPrice),
      openPl: finite(`DXtrade position ${index} openPl`, position.openPl ?? 0),
      dayClosedPl: finite(`DXtrade position ${index} dayClosedPl`, position.dayClosedPl ?? 0),
      avgOpenPrice: finite(`DXtrade position ${index} avgOpenPrice`, position.avgOpenPrice ?? 0)
    });
  }));
}

export function normalizeDxtradeAccountMetrics(payload, {
  startingBalance,
  persistedPeakClosedBalance,
  fetchedAtMs = Date.now()
}) {
  const metric = extractMetric(payload);
  const balance = finite("DXtrade balance", metric.balance);
  const equity = finite("DXtrade equity", metric.equity);
  const dayClosedPl = finite("DXtrade dayClosedPl", metric.dayClosedPl ?? 0);
  const openPositionsCount = nonNegativeInteger("DXtrade openPositionsCount", metric.openPositionsCount ?? 0);
  const start = finite("startingBalance", startingBalance);
  const priorPeak = finite("persistedPeakClosedBalance", persistedPeakClosedBalance);
  const fetched = finite("fetchedAtMs", fetchedAtMs);
  if (fetched <= 0) throw new TypeError("fetchedAtMs must be positive");

  // DXtrade dayClosedPl is the realized P&L of the current broker business day.
  // Therefore balance - dayClosedPl reconstructs the account's closing balance at
  // the start of the current account day without waiting for a rollover observation.
  const previousDayClosingBalance = balance - dayClosedPl;
  const peakClosedBalance = Math.max(start, priorPeak, balance);
  const positions = normalizePositions(metric);
  const nonZeroPositions = positions.filter((position) => Math.abs(position.quantity) > 1e-12);
  const btcPositions = nonZeroPositions.filter((position) => position.symbol === BTC_SYMBOL);
  const foreignPositions = nonZeroPositions.filter((position) => position.symbol !== BTC_SYMBOL);

  let invariantError = null;
  if (foreignPositions.length > 0) {
    invariantError = "A non-BTC position exists on the Tradeify account";
  } else if (openPositionsCount > 1 || nonZeroPositions.length > 1 || btcPositions.length > 1) {
    invariantError = "More than one open position exists on the Tradeify account";
  } else if (openPositionsCount !== nonZeroPositions.length) {
    invariantError = "DXtrade open-position count does not match position metrics";
  }

  const btcPosition = btcPositions[0] ?? null;
  const currentNotional = btcPosition ? Math.abs(btcPosition.quantity * btcPosition.markPrice) : 0;
  if (!Number.isFinite(currentNotional)) throw new Error("DXtrade BTC notional is invalid");

  return Object.freeze({
    account: metric.account == null ? null : String(metric.account),
    version: metric.version == null ? null : Number(metric.version),
    balance,
    equity,
    dayClosedPl,
    openPl: finite("DXtrade openPl", metric.openPl ?? 0),
    previousDayClosingBalance,
    peakClosedBalance,
    openPositionsCount,
    btcPosition,
    currentNotional,
    invariantError,
    accountLocked: invariantError !== null,
    fetchedAt: new Date(fetched).toISOString(),
    fetchedAtMs: fetched
  });
}

export function createDxtradeAccountMonitor({
  client,
  startingBalance,
  getPersistedPeakClosedBalance,
  onSnapshot = async () => {},
  onError = () => {},
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  freshAfterMs = DEFAULT_FRESH_AFTER_MS,
  now = () => Date.now()
}) {
  if (typeof client?.login !== "function" || typeof client?.getAccountMetrics !== "function") {
    throw new TypeError("DXtrade account monitor requires login and getAccountMetrics methods");
  }
  const getPeak = requireFunction("getPersistedPeakClosedBalance", getPersistedPeakClosedBalance);
  const publish = requireFunction("onSnapshot", onSnapshot);
  const reportError = requireFunction("onError", onError);
  const clock = requireFunction("now", now);
  finite("startingBalance", startingBalance);
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1_000 || pollIntervalMs > 60_000) {
    throw new TypeError("pollIntervalMs must be an integer from 1000 to 60000 milliseconds");
  }
  if (!Number.isInteger(freshAfterMs) || freshAfterMs < pollIntervalMs || freshAfterMs > 120_000) {
    throw new TypeError("freshAfterMs must be an integer at least as large as pollIntervalMs");
  }

  let timer = null;
  let busy = false;
  let stopped = true;
  let latest = null;
  let lastError = null;

  async function pollOnce() {
    if (busy) return latest;
    busy = true;
    try {
      await client.login();
      const [payload, persistedPeak] = await Promise.all([
        client.getAccountMetrics({ includePositions: true }),
        getPeak()
      ]);
      const snapshot = normalizeDxtradeAccountMetrics(payload, {
        startingBalance,
        persistedPeakClosedBalance: persistedPeak,
        fetchedAtMs: clock()
      });
      latest = snapshot;
      lastError = null;
      await publish(snapshot);
      return snapshot;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("DXtrade account monitor failed");
      reportError(lastError);
      return latest;
    } finally {
      busy = false;
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(async () => {
      await pollOnce();
      schedule();
    }, pollIntervalMs);
    timer.unref?.();
  }

  async function start() {
    if (!stopped) return;
    stopped = false;
    await pollOnce();
    schedule();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function getSnapshot() {
    const ageMs = latest ? Math.max(0, clock() - latest.fetchedAtMs) : Infinity;
    return Object.freeze({
      snapshot: latest,
      healthy: latest !== null && lastError === null && ageMs <= freshAfterMs && latest.invariantError === null,
      fresh: latest !== null && ageMs <= freshAfterMs,
      ageMs,
      error: lastError ? "DXtrade account monitor error" : null
    });
  }

  return Object.freeze({ start, stop, pollOnce, getSnapshot });
}
