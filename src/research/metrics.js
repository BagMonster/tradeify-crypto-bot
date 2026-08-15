import { partitionForCloseTime } from "./manifest.js";
import { routeId } from "./regime.js";

function requireTradesArray(trades) {
  if (!Array.isArray(trades)) throw new Error("trades must be an array");
  return trades;
}

/**
 * summarizeTrades and computeRouteBreakdown both depend on order for
 * maxDrawdown and the win/loss streak counts (a shuffled trade list would
 * produce a meaningless drawdown curve). src/research/backtestEngine.js
 * already appends trades in the order they close, so this is a cheap
 * fail-closed check on that invariant rather than a sort - metrics.js does
 * not decide what "chronological" means, it only refuses to silently
 * compute a number that would be wrong if the caller got the order wrong.
 */
function requireChronological(trades) {
  for (let index = 1; index < trades.length; index += 1) {
    if (trades[index].exitBarIndex < trades[index - 1].exitBarIndex) {
      throw new Error(`trades must be in chronological order (exitBarIndex regressed at index ${index})`);
    }
  }
  return trades;
}

function requireFiniteTradeField(trade, index, field) {
  const value = trade?.[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`trades[${index}].${field} must be a finite number`);
  }
  return value;
}

const EMPTY_SUMMARY = Object.freeze({
  tradeCount: 0,
  winCount: 0,
  lossCount: 0,
  breakevenCount: 0,
  winRate: null,
  netPnl: 0,
  grossPnl: 0,
  totalCommission: 0,
  expectancy: null,
  avgWin: null,
  avgLoss: null,
  profitFactor: null,
  bestTradeNetPnl: null,
  netPnlExcludingBestTrade: null,
  maxDrawdown: 0,
  profitToDrawdown: null,
  longestWinningStreak: 0,
  longestLosingStreak: 0,
  avgMaxFavorableExcursion: null,
  avgMaxAdverseExcursion: null,
  avgHoldBars: null,
  holdTimeUnprovableCount: 0
});

/**
 * Section 11.1's "expectancy, drawdown, streaks, MAE/MFE" for one list of
 * closed trades, in the shape src/research/backtestEngine.js's runBacktest
 * returns via its `trades` array. Every ratio that is undefined on an empty
 * or degenerate input (winRate, expectancy, avgWin/avgLoss, profitFactor,
 * profitToDrawdown) returns null rather than NaN/Infinity - the same
 * "return null on an undefined ratio" convention src/riskEngine.js's
 * calculateConsistency already uses.
 *
 * [INTERPRETATION, flagged to the owner]: maxDrawdown is computed from the
 * sequence of REALIZED trade net P&L only (the running peak-to-trough of
 * cumulative closed-trade P&L) - not a continuous account-equity curve
 * including intrabar unrealized swings between closes. Section 10 lists
 * "max drawdown" as a per-route evidence field without defining which
 * curve it is measured against; the realized-trade curve is what this
 * module has the inputs to compute without re-deriving account state, and
 * is a standard, conservative-by-omission choice (it cannot overstate
 * drawdown by including unrealized noise, but also cannot understate a
 * large intrabar adverse excursion that closed back out favorably - that
 * information already exists per-trade as maxAdverseExcursion and is
 * reported separately via avgMaxAdverseExcursion).
 *
 * "Not dependent on one exceptional trade" (Section 9.4) is not evaluated
 * here as a pass/fail verdict - that is a later step's qualification logic
 * (Steps 26.6/26.7). bestTradeNetPnl and netPnlExcludingBestTrade are
 * provided as the two numbers that check needs, computed once here so
 * every later caller uses the same figures.
 */
export function summarizeTrades(trades) {
  requireTradesArray(trades);
  if (trades.length === 0) return EMPTY_SUMMARY;
  requireChronological(trades);

  let netPnl = 0;
  let grossPnl = 0;
  let totalCommission = 0;
  let winCount = 0;
  let lossCount = 0;
  let breakevenCount = 0;
  let winPnlSum = 0;
  let lossPnlSum = 0;
  let bestTradeNetPnl = -Infinity;
  let mfeSum = 0;
  let maeSum = 0;
  let holdBarsSum = 0;
  let holdTimeUnprovableCount = 0;

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;

  let winStreak = 0;
  let lossStreak = 0;
  let longestWinningStreak = 0;
  let longestLosingStreak = 0;

  trades.forEach((trade, index) => {
    const tradeNetPnl = requireFiniteTradeField(trade, index, "netPnl");
    const tradeGrossPnl = requireFiniteTradeField(trade, index, "grossPnl");
    const entryCommission = requireFiniteTradeField(trade, index, "entryCommission");
    const exitCommission = requireFiniteTradeField(trade, index, "exitCommission");
    const maxFavorableExcursion = requireFiniteTradeField(trade, index, "maxFavorableExcursion");
    const maxAdverseExcursion = requireFiniteTradeField(trade, index, "maxAdverseExcursion");
    const holdBars = requireFiniteTradeField(trade, index, "holdBars");

    netPnl += tradeNetPnl;
    grossPnl += tradeGrossPnl;
    totalCommission += entryCommission + exitCommission;
    mfeSum += maxFavorableExcursion;
    maeSum += maxAdverseExcursion;
    holdBarsSum += holdBars;
    if (trade.holdTimeUnprovable) holdTimeUnprovableCount += 1;
    bestTradeNetPnl = Math.max(bestTradeNetPnl, tradeNetPnl);

    if (tradeNetPnl > 0) {
      winCount += 1;
      winPnlSum += tradeNetPnl;
      winStreak += 1;
      lossStreak = 0;
    } else if (tradeNetPnl < 0) {
      lossCount += 1;
      lossPnlSum += tradeNetPnl;
      lossStreak += 1;
      winStreak = 0;
    } else {
      breakevenCount += 1;
      winStreak = 0;
      lossStreak = 0;
    }
    longestWinningStreak = Math.max(longestWinningStreak, winStreak);
    longestLosingStreak = Math.max(longestLosingStreak, lossStreak);

    equity += tradeNetPnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  });

  const tradeCount = trades.length;
  const lossMagnitude = Math.abs(lossPnlSum);

  return Object.freeze({
    tradeCount,
    winCount,
    lossCount,
    breakevenCount,
    winRate: winCount / tradeCount,
    netPnl,
    grossPnl,
    totalCommission,
    expectancy: netPnl / tradeCount,
    avgWin: winCount > 0 ? winPnlSum / winCount : null,
    avgLoss: lossCount > 0 ? lossPnlSum / lossCount : null,
    profitFactor: lossMagnitude > 0 ? winPnlSum / lossMagnitude : null,
    bestTradeNetPnl,
    netPnlExcludingBestTrade: netPnl - bestTradeNetPnl,
    maxDrawdown,
    profitToDrawdown: maxDrawdown > 0 ? netPnl / maxDrawdown : null,
    longestWinningStreak,
    longestLosingStreak,
    avgMaxFavorableExcursion: mfeSum / tradeCount,
    avgMaxAdverseExcursion: maeSum / tradeCount,
    avgHoldBars: holdBarsSum / tradeCount,
    holdTimeUnprovableCount
  });
}

/**
 * Section 5.3 / 9.4 per-route breakdown: groups trades into their
 * (strategy, direction, regime label) triple via regime.js's routeId
 * (reused, not re-implemented, so a route's identity can never drift
 * between regime.js and this file) and summarizes each group with
 * summarizeTrades. A trade whose regimeLabel is missing or not RANGE/TREND
 * fails closed via routeId's own validation - every trade this module ever
 * sees came from a real fill, and every real fill's entry candidate must
 * have carried a tradable regime label (see router.js), so this should
 * never trip in practice; if it does, that is a defect upstream worth
 * surfacing loudly rather than silently bucketing the trade as "unknown."
 *
 * Each route's trades stay in the same relative (chronological) order they
 * appeared in the input, so that route's own maxDrawdown/streak figures
 * remain meaningful.
 */
export function computeRouteBreakdown(trades) {
  requireTradesArray(trades);
  requireChronological(trades);

  const groups = new Map();
  trades.forEach((trade, index) => {
    const strategy = trade?.strategyId;
    const direction = trade?.direction;
    const regimeLabel = trade?.regimeLabel;
    let route;
    try {
      route = routeId({ strategy, direction, regimeLabel });
    } catch (error) {
      throw new Error(`trades[${index}] does not form a valid route: ${error.message}`);
    }
    if (!groups.has(route.id)) groups.set(route.id, { route, trades: [] });
    groups.get(route.id).trades.push(trade);
  });

  const routes = [...groups.values()]
    .map(({ route, trades: routeTrades }) => Object.freeze({
      route,
      stats: summarizeTrades(routeTrades)
    }))
    .sort((a, b) => (a.route.id < b.route.id ? -1 : a.route.id > b.route.id ? 1 : 0));

  return Object.freeze(routes);
}

/**
 * Section 10's "per-partition breakdown," keyed off manifest.js's
 * partitionForCloseTime (reused, not re-implemented) applied to each
 * trade's EXIT time - a trade is attributed to the partition it was
 * realized in. [INTERPRETATION, flagged to the owner]: a trade whose entry
 * and exit straddle a partition boundary is still attributed wholly to its
 * exit partition, matching that P&L is only realized, and only affects
 * account state, at exit (src/research/backtestEngine.js's
 * recordTradeClose is likewise keyed to the exit bar, never the entry
 * bar).
 *
 * Returns one summarizeTrades() result per partition; combine with
 * computeRouteBreakdown by pre-filtering `trades` to a specific route
 * before calling either function - this module deliberately does not
 * provide every partition x route combination itself, to stay a single
 * small composable piece rather than an N x M report generator (that
 * belongs to report.js, a later step).
 */
export function computePartitionBreakdown(trades, partitions) {
  requireTradesArray(trades);
  requireChronological(trades);
  if (!partitions || typeof partitions !== "object") {
    throw new Error("partitions must be the object returned by manifest.js's computePartitions");
  }

  const buckets = { development: [], validation: [], holdout: [] };
  trades.forEach((trade, index) => {
    const partition = partitionForCloseTime(trade.exitTime, partitions);
    if (!buckets[partition]) {
      throw new Error(`trades[${index}] resolved to an unknown partition: ${partition}`);
    }
    buckets[partition].push(trade);
  });

  return Object.freeze({
    development: summarizeTrades(buckets.development),
    validation: summarizeTrades(buckets.validation),
    holdout: summarizeTrades(buckets.holdout)
  });
}
