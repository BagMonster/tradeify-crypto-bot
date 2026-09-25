import { ACCOUNT_DAY_OFFSET_MS, accountDayKey } from "./dailyRiskLadder.js";

export const DUST_MAX_REMAINING_FRACTION = 0.10;
export const DUST_LOSS_BUDGET_FRACTION = 0.02;
export const DUST_SCHEDULE_MINUTE_UTC = 3;

function finite(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError(`${name} must be finite`);
  return n;
}

function positive(name, value) {
  const n = finite(name, value);
  if (n <= 0) throw new TypeError(`${name} must be positive`);
  return n;
}

export function accountDayStartMs(dayKey) {
  if (typeof dayKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) throw new TypeError("dayKey is invalid");
  const midnight = Date.parse(`${dayKey}T00:00:00.000Z`);
  if (!Number.isFinite(midnight)) throw new TypeError("dayKey is invalid");
  return midnight - ACCOUNT_DAY_OFFSET_MS;
}

export function dustLossBudgetUsd(cutTiers, fraction = DUST_LOSS_BUDGET_FRACTION) {
  if (!Array.isArray(cutTiers) || cutTiers.length === 0) throw new TypeError("cutTiers are required");
  const shallowest = Math.min(...cutTiers.map((tier) => positive("cut tier threshold", tier?.thresholdUsd)));
  const share = positive("dust loss budget fraction", fraction);
  if (share >= 1) throw new TypeError("dust loss budget fraction must be below one");
  return Number((shallowest * share).toFixed(8));
}

export function dustCleanupDue({ nowMs, dayKey = accountDayKey(nowMs), minuteUtc = DUST_SCHEDULE_MINUTE_UTC }) {
  const now = finite("nowMs", nowMs);
  if (!Number.isInteger(minuteUtc) || minuteUtc < 0 || minuteUtc > 59) throw new TypeError("minuteUtc is invalid");
  return now >= accountDayStartMs(dayKey) + minuteUtc * 60_000;
}

export function realizedPnlUsd({ virtualSide, entryPrice, fillPrice, quantity }) {
  const entry = positive("entryPrice", entryPrice);
  const fill = positive("fillPrice", fillPrice);
  const units = positive("quantity", quantity);
  if (virtualSide !== "BUY" && virtualSide !== "SELL") throw new TypeError("virtualSide is invalid");
  const pnl = virtualSide === "BUY" ? (fill - entry) * units : (entry - fill) * units;
  return Number(pnl.toFixed(8));
}

// The coordinator owns the once-per-account-day guarantee. A book's runtime owns
// the exact broker ticket close and does not mutate a ring until DXtrade confirms it.
export function createDailyDustCleanupCoordinator({
  accountRisk,
  books,
  store,
  addEvent = async () => {},
  notifications = null,
  now = () => Date.now()
}) {
  if (!accountRisk || typeof accountRisk !== "object") throw new TypeError("accountRisk is required");
  if (!Array.isArray(books)) throw new TypeError("books are required");
  for (const book of books) {
    if (typeof book?.instrument !== "string" || typeof book?.runDustCleanup !== "function" || typeof book?.isMarketReady !== "function" || typeof book?.isExecutionEnabled !== "function") {
      throw new TypeError("dust cleanup book is invalid");
    }
  }
  for (const method of ["getDailyDustCleanupState", "saveDailyDustCleanupState"]) {
    if (typeof store?.[method] !== "function") throw new TypeError(`dust cleanup store.${method} is required`);
  }
  if (typeof addEvent !== "function") throw new TypeError("addEvent must be a function");
  if (notifications !== null && typeof notifications?.enqueue !== "function") throw new TypeError("notifications.enqueue must be a function");

  const maxRemainingFraction = Number(accountRisk.dustCleanup?.maxRemainingFraction ?? DUST_MAX_REMAINING_FRACTION);
  if (!(maxRemainingFraction > 0 && maxRemainingFraction <= 1)) throw new TypeError("dust cleanup maximum remaining fraction is invalid");
  const budgetFraction = Number(accountRisk.dustCleanup?.lossBudgetFraction ?? DUST_LOSS_BUDGET_FRACTION);
  const scheduledMinuteUtc = Number(accountRisk.dustCleanup?.minuteUtc ?? DUST_SCHEDULE_MINUTE_UTC);
  const configuredTiers = Array.isArray(accountRisk.cutTiers) && accountRisk.cutTiers.length > 0
    ? accountRisk.cutTiers
    : [{ thresholdUsd: accountRisk.partialCutUsd }];
  const lossBudgetUsd = dustLossBudgetUsd(configuredTiers, budgetFraction);
  let running = false;

  async function run({ immediate = false } = {}) {
    if (running) return Object.freeze({ action: "BUSY" });
    const nowMs = finite("now", now());
    const dayKey = accountDayKey(nowMs);
    if (!immediate && !dustCleanupDue({ nowMs, dayKey, minuteUtc: scheduledMinuteUtc })) {
      return Object.freeze({ action: "NOT_DUE", dayKey });
    }
    const prior = await store.getDailyDustCleanupState(dayKey);
    if (prior.completedAt !== null) return Object.freeze({ action: "ALREADY_COMPLETED", dayKey, state: prior });
    const executionDisabled = books.filter((book) => !book.isExecutionEnabled());
    if (executionDisabled.length > 0) {
      await addEvent("WARN", "DAILY_DUST_CLEANUP_WAITING_FOR_EXECUTION", { dayKey, instruments: executionDisabled.map((book) => book.instrument) });
      return Object.freeze({ action: "WAITING_FOR_LIVE_EXECUTION", dayKey, instruments: Object.freeze(executionDisabled.map((book) => book.instrument)) });
    }
    const unready = books.filter((book) => !book.isMarketReady());
    if (unready.length > 0) {
      await addEvent("WARN", "DAILY_DUST_CLEANUP_WAITING_FOR_MARKET_DATA", { dayKey, instruments: unready.map((book) => book.instrument) });
      return Object.freeze({ action: "WAITING_FOR_MARKET_DATA", dayKey, instruments: Object.freeze(unready.map((book) => book.instrument)) });
    }

    running = true;
    try {
      let usedLossUsd = prior.autoLossUsd;
      const closed = [];
      const deferred = [];
      const failed = [];
      for (const book of books) {
        const result = await book.runDustCleanup({
          dayKey,
          openedBeforeMs: accountDayStartMs(dayKey),
          maxRemainingFraction,
          remainingLossBudgetUsd: Math.max(0, lossBudgetUsd - usedLossUsd),
          onConfirmedClose: async (fill) => {
            usedLossUsd = Number((usedLossUsd + Math.max(0, -fill.realizedPnlUsd)).toFixed(8));
            await store.saveDailyDustCleanupState({ dayKey, autoLossUsd: usedLossUsd, completedAt: null });
          }
        });
        for (const fill of result.closed) {
          closed.push({ instrument: book.instrument, ...fill });
        }
        deferred.push(...result.deferred.map((entry) => ({ instrument: book.instrument, ...entry })));
        failed.push(...result.failed.map((entry) => ({ instrument: book.instrument, ...entry })));
      }
      const state = await store.saveDailyDustCleanupState({ dayKey, autoLossUsd: usedLossUsd, completedAt: new Date(nowMs).toISOString() });
      const payload = { dayKey, lossBudgetUsd, autoLossUsd: usedLossUsd, closed, deferred, failed, immediate };
      await addEvent(failed.length > 0 ? "WARN" : "INFO", "DAILY_DUST_CLEANUP_COMPLETED", payload);
      if (closed.length > 0 || deferred.length > 0 || failed.length > 0) {
        notifications?.enqueue?.({
          kind: "DUST_CLEANUP_SUMMARY",
          eventKey: `DUST-CLEANUP:${dayKey}`,
          dayKey,
          closedCount: closed.length,
          deferredCount: deferred.length,
          failedCount: failed.length,
          autoLossUsd: usedLossUsd,
          lossBudgetUsd
        });
      }
      return Object.freeze({ action: "COMPLETED", dayKey, state, lossBudgetUsd, autoLossUsd: usedLossUsd, closed: Object.freeze(closed), deferred: Object.freeze(deferred), failed: Object.freeze(failed) });
    } finally {
      running = false;
    }
  }

  return Object.freeze({ run, lossBudgetUsd, maxRemainingFraction, scheduledMinuteUtc });
}
