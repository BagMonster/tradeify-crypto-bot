import test from "node:test";
import assert from "node:assert/strict";
import {
  computePartitionBreakdown,
  computeRouteBreakdown,
  summarizeTrades
} from "../src/research/metrics.js";

function trade(overrides) {
  return Object.freeze({
    routeLabel: "test-run",
    strategyId: "donchian-breakout",
    direction: "LONG",
    regimeLabel: "RANGE",
    entryBarIndex: 0,
    entryTime: "2025-01-01T00:00:00.000Z",
    exitBarIndex: 0,
    exitTime: "2025-01-01T01:00:00.000Z",
    requestedEntryPrice: 100,
    entryPrice: 100,
    requestedExitPrice: 100,
    exitPrice: 100,
    stopReference: 90,
    targetReference: null,
    quantity: 1,
    riskAmount: 10,
    grossPnl: 0,
    entryCommission: 0,
    exitCommission: 0,
    netPnl: 0,
    rMultiple: null,
    maxFavorableExcursion: 0,
    maxAdverseExcursion: 0,
    holdBars: 1,
    holdTimeUnprovable: false,
    exitReason: "TARGET",
    ...overrides
  });
}

// Hand-computed expected values (see the summary in the delivery notes):
// netPnl 220, expectancy 44, avgWin 150, avgLoss -40, profitFactor 3.75,
// bestTradeNetPnl 200, netPnlExcludingBestTrade 20, maxDrawdown 50,
// profitToDrawdown 4.4, longest win/loss streaks both 1 (broken by the
// breakeven trade), avgMFE 71, avgMAE 24, avgHoldBars 3, 1 unprovable hold.
const MIXED_TRADES = Object.freeze([
  trade({
    netPnl: 100, grossPnl: 110, entryCommission: 5, exitCommission: 5,
    maxFavorableExcursion: 120, maxAdverseExcursion: 20, holdBars: 3,
    holdTimeUnprovable: false, exitBarIndex: 10
  }),
  trade({
    netPnl: -50, grossPnl: -45, entryCommission: 2.5, exitCommission: 2.5,
    maxFavorableExcursion: 10, maxAdverseExcursion: 60, holdBars: 5,
    holdTimeUnprovable: true, exitBarIndex: 20
  }),
  trade({
    netPnl: 200, grossPnl: 210, entryCommission: 5, exitCommission: 5,
    maxFavorableExcursion: 220, maxAdverseExcursion: 5, holdBars: 2,
    holdTimeUnprovable: false, exitBarIndex: 30
  }),
  trade({
    netPnl: -30, grossPnl: -25, entryCommission: 2.5, exitCommission: 2.5,
    maxFavorableExcursion: 5, maxAdverseExcursion: 35, holdBars: 4,
    holdTimeUnprovable: false, exitBarIndex: 40
  }),
  trade({
    netPnl: 0, grossPnl: 0, entryCommission: 0, exitCommission: 0,
    maxFavorableExcursion: 0, maxAdverseExcursion: 0, holdBars: 1,
    holdTimeUnprovable: false, exitBarIndex: 50
  })
]);

test("1 - summarizeTrades on an empty array returns the well-defined null-filled shape, not NaN/throw", () => {
  const result = summarizeTrades([]);
  assert.equal(result.tradeCount, 0);
  assert.equal(result.winRate, null);
  assert.equal(result.expectancy, null);
  assert.equal(result.avgWin, null);
  assert.equal(result.avgLoss, null);
  assert.equal(result.profitFactor, null);
  assert.equal(result.maxDrawdown, 0);
  assert.equal(result.profitToDrawdown, null);
  assert.equal(result.longestWinningStreak, 0);
  assert.equal(result.longestLosingStreak, 0);
});

test("2 - summarizeTrades computes win rate, expectancy, avgWin/avgLoss, and profit factor", () => {
  const result = summarizeTrades(MIXED_TRADES);
  assert.equal(result.tradeCount, 5);
  assert.equal(result.winCount, 2);
  assert.equal(result.lossCount, 2);
  assert.equal(result.breakevenCount, 1);
  assert.equal(result.winRate, 0.4);
  assert.equal(result.netPnl, 220);
  assert.equal(result.grossPnl, 250);
  assert.equal(result.totalCommission, 30);
  assert.equal(result.expectancy, 44);
  assert.equal(result.avgWin, 150);
  assert.equal(result.avgLoss, -40);
  assert.equal(result.profitFactor, 3.75);
});

test("3 - summarizeTrades computes bestTradeNetPnl and netPnlExcludingBestTrade", () => {
  const result = summarizeTrades(MIXED_TRADES);
  assert.equal(result.bestTradeNetPnl, 200);
  assert.equal(result.netPnlExcludingBestTrade, 20);
});

test("4 - summarizeTrades computes maxDrawdown and profitToDrawdown from the realized-P&L curve", () => {
  const result = summarizeTrades(MIXED_TRADES);
  // equity after each trade: 100, 50, 250, 220, 220 -> peak-to-trough max is 50 (100 -> 50)
  assert.equal(result.maxDrawdown, 50);
  assert.equal(result.profitToDrawdown, 4.4);
});

test("5 - summarizeTrades computes win/loss streaks, broken by a breakeven trade", () => {
  const result = summarizeTrades(MIXED_TRADES);
  assert.equal(result.longestWinningStreak, 1);
  assert.equal(result.longestLosingStreak, 1);
});

test("6 - summarizeTrades averages MAE/MFE and hold bars, and counts unprovable holds", () => {
  const result = summarizeTrades(MIXED_TRADES);
  assert.equal(result.avgMaxFavorableExcursion, 71);
  assert.equal(result.avgMaxAdverseExcursion, 24);
  assert.equal(result.avgHoldBars, 3);
  assert.equal(result.holdTimeUnprovableCount, 1);
});

test("7 - a longer winning or losing run is tracked correctly across a break", () => {
  const trades = [
    trade({ netPnl: 10, exitBarIndex: 1 }),
    trade({ netPnl: 10, exitBarIndex: 2 }),
    trade({ netPnl: 10, exitBarIndex: 3 }),
    trade({ netPnl: -5, exitBarIndex: 4 }),
    trade({ netPnl: -5, exitBarIndex: 5 }),
    trade({ netPnl: 10, exitBarIndex: 6 })
  ];
  const result = summarizeTrades(trades);
  assert.equal(result.longestWinningStreak, 3);
  assert.equal(result.longestLosingStreak, 2);
});

test("8 - summarizeTrades requires chronological input (non-decreasing exitBarIndex)", () => {
  const trades = [
    trade({ netPnl: 10, exitBarIndex: 20 }),
    trade({ netPnl: 10, exitBarIndex: 10 })
  ];
  assert.throws(() => summarizeTrades(trades), /chronological order/);
});

test("9 - summarizeTrades fails closed on a missing or non-finite required field", () => {
  const trades = [trade({ netPnl: undefined, exitBarIndex: 1 })];
  assert.throws(() => summarizeTrades(trades), /netPnl must be a finite number/);
});

test("10 - computeRouteBreakdown groups trades by the (strategy, direction, regime) triple and sorts by route id", () => {
  const trades = [
    trade({ strategyId: "donchian-breakout", direction: "LONG", regimeLabel: "TREND", netPnl: 50, exitBarIndex: 1 }),
    trade({ strategyId: "bollinger-rsi-mean-reversion", direction: "SHORT", regimeLabel: "RANGE", netPnl: -20, exitBarIndex: 2 }),
    trade({ strategyId: "donchian-breakout", direction: "LONG", regimeLabel: "TREND", netPnl: 30, exitBarIndex: 3 })
  ];
  const breakdown = computeRouteBreakdown(trades);
  assert.equal(breakdown.length, 2);
  // route ids are sorted lexicographically: "bollinger-..." sorts before "donchian-..."
  assert.equal(breakdown[0].route.strategy, "bollinger-rsi-mean-reversion");
  assert.equal(breakdown[0].route.direction, "SHORT");
  assert.equal(breakdown[0].route.regimeLabel, "RANGE");
  assert.equal(breakdown[0].stats.tradeCount, 1);
  assert.equal(breakdown[0].stats.netPnl, -20);

  assert.equal(breakdown[1].route.strategy, "donchian-breakout");
  assert.equal(breakdown[1].route.regimeLabel, "TREND");
  assert.equal(breakdown[1].stats.tradeCount, 2);
  assert.equal(breakdown[1].stats.netPnl, 80);
});

test("11 - computeRouteBreakdown fails closed on a trade with an untradable or missing regime label", () => {
  const trades = [trade({ regimeLabel: "EXCLUDED_VOL", exitBarIndex: 1 })];
  assert.throws(() => computeRouteBreakdown(trades), /does not form a valid route/);

  const missing = [trade({ regimeLabel: undefined, exitBarIndex: 1 })];
  assert.throws(() => computeRouteBreakdown(missing), /does not form a valid route/);
});

test("12 - computePartitionBreakdown buckets trades by exit time against the manifest boundaries", () => {
  const partitions = Object.freeze({
    tDevEndCloseTimeMs: Date.parse("2025-01-10T00:00:00.000Z"),
    tValEndCloseTimeMs: Date.parse("2025-01-20T00:00:00.000Z")
  });
  const trades = [
    trade({ exitTime: "2025-01-05T00:00:00.000Z", netPnl: 10, exitBarIndex: 1 }),
    trade({ exitTime: "2025-01-10T00:00:00.000Z", netPnl: 20, exitBarIndex: 2 }), // boundary belongs to development
    trade({ exitTime: "2025-01-15T00:00:00.000Z", netPnl: -5, exitBarIndex: 3 }),
    trade({ exitTime: "2025-01-25T00:00:00.000Z", netPnl: 100, exitBarIndex: 4 })
  ];
  const breakdown = computePartitionBreakdown(trades, partitions);
  assert.equal(breakdown.development.tradeCount, 2);
  assert.equal(breakdown.development.netPnl, 30);
  assert.equal(breakdown.validation.tradeCount, 1);
  assert.equal(breakdown.validation.netPnl, -5);
  assert.equal(breakdown.holdout.tradeCount, 1);
  assert.equal(breakdown.holdout.netPnl, 100);
});

test("13 - computePartitionBreakdown requires a partitions object", () => {
  assert.throws(() => computePartitionBreakdown([], null), /partitions must be the object returned by/);
});
