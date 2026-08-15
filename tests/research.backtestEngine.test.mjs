import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ENTRY_COMMISSION_PCT,
  DEFAULT_EXIT_COMMISSION_PCT,
  DEFAULT_LOT_RULES,
  RESEARCH_STAGE_RISK_CAP,
  isAtOrAfterHardFlat,
  runBacktest
} from "../src/research/backtestEngine.js";

const STRATEGY = Object.freeze({
  instruments: Object.freeze({ "BTC/USD": Object.freeze({ enabled: true }) }),
  signal: Object.freeze({
    bbPeriod: 20,
    bbStdDev: 2,
    rsiPeriod: 14,
    rsiLongThreshold: 32,
    rsiShortThreshold: 68,
    requireCloseInsideBand: true,
    atrPeriod: 14,
    stopAtrMultiple: 1.5,
    timeStopBars: 24
  }),
  regime: Object.freeze({
    minDailyAtrPct: 0.015,
    maxDailyAtrPct: 0.037,
    adxPeriod: 14,
    adxMax: 25,
    adxStandDown: 30,
    rangeBandStdDev: 2.5
  }),
  risk: Object.freeze({
    stage1RiskCap: 200,
    stage2RiskCap: 300,
    stage2Threshold: 53000,
    dailySoftStop: -750,
    dailyHardStop: -1000,
    stage1ProfitCeiling: 500,
    stage2ProfitCeiling: 700,
    maxNotional: 100000,
    floorSafetyMargin: 750
  }),
  execution: Object.freeze({
    minHoldSeconds: 25,
    slippageCapPct: 0.0005,
    hardFlatUtc: "21:45",
    autoExecute: false
  })
});

const ACCOUNT = Object.freeze({
  provider: "tradeify-crypto",
  accountType: "instant-funding",
  startingBalance: 50000,
  dailyLossLimit: 1500,
  maxLossOffset: 3000,
  maxLossFloorCap: 50000,
  leverage: 2,
  maxNotional: 100000,
  consistencyMax: 0.2,
  minimumPayout: 100,
  profitSplit: 0.95,
  minimumHoldSeconds: 20,
  dailySnapshotUtc: "22:00"
});

const INTERVAL_15M = 15 * 60 * 1000;

function buildBars15m(startMs, specs) {
  return specs.map((spec, index) => {
    const openMs = startMs + (index * INTERVAL_15M);
    return {
      source: "binance",
      symbol: "BTCUSDT",
      timeframe: "15m",
      openTime: new Date(openMs).toISOString(),
      closeTime: new Date(openMs + INTERVAL_15M).toISOString(),
      open: spec.open,
      high: spec.high,
      low: spec.low,
      close: spec.close,
      volume: 100 + index,
      isClosed: true
    };
  });
}

function candidate(direction, { stopReference, targetReference, stopDistance, timeStopBars = 24 }) {
  return Object.freeze({
    status: "CANDIDATE",
    strategyId: "test-strategy",
    direction,
    stopReference,
    targetReference,
    stopDistance,
    timeStopBars,
    regime: Object.freeze({ classification: "RANGE" })
  });
}

const NO_SIGNAL = Object.freeze({
  status: "NO_SIGNAL",
  strategyId: "test-strategy",
  direction: null,
  reasonCode: "NO_QUALIFYING_SETUP",
  reason: "scripted: no candidate at this decision index"
});

/** A signalFn stub matching evaluateMeanReversion's ({decisionIndex}) => result shape. */
function scriptedSignal(script) {
  return ({ decisionIndex }) => script[decisionIndex] ?? NO_SIGNAL;
}

const STOP_DISTANCE = 750; // atr15m(500) * stopAtrMultiple(1.5)
const EXPECTED_QTY = 0.133;
const EXPECTED_RISK = 99.75; // qty * stopDistance

test("1 - isAtOrAfterHardFlat compares UTC clock minutes, not local time", () => {
  const before = Date.parse("2025-06-02T21:44:59.999Z");
  const atFlat = Date.parse("2025-06-02T21:45:00.000Z");
  const after = Date.parse("2025-06-02T21:45:15.000Z");
  const nextDay = Date.parse("2025-06-03T00:00:00.000Z");
  assert.equal(isAtOrAfterHardFlat(before, "21:45"), false);
  assert.equal(isAtOrAfterHardFlat(atFlat, "21:45"), true);
  assert.equal(isAtOrAfterHardFlat(after, "21:45"), true);
  assert.equal(isAtOrAfterHardFlat(nextDay, "21:45"), false);
});

test("2 - runBacktest validates its structural inputs", () => {
  const bars15m = buildBars15m(Date.parse("2025-06-02T00:00:00.000Z"), [
    { open: 50000, high: 50000, low: 50000, close: 50000 },
    { open: 50000, high: 50000, low: 50000, close: 50000 },
    { open: 50000, high: 50000, low: 50000, close: 50000 }
  ]);
  assert.throws(
    () => runBacktest({ bars15m: [], signalFn: scriptedSignal({}), strategy: STRATEGY, account: ACCOUNT }),
    /bars15m must contain at least 2 bars/
  );
  assert.throws(
    () => runBacktest({ bars15m, signalFn: "not-a-function", strategy: STRATEGY, account: ACCOUNT }),
    /signalFn must be a function/
  );
  assert.throws(
    () => runBacktest({
      bars15m, signalFn: scriptedSignal({}), strategy: STRATEGY, account: ACCOUNT, startIndex: 0
    }),
    /startIndex must be an integer of at least 1/
  );
  assert.throws(
    () => runBacktest({
      bars15m, signalFn: scriptedSignal({}), strategy: STRATEGY, account: ACCOUNT, endIndex: 99
    }),
    /endIndex must be an integer >= startIndex/
  );
  assert.throws(
    () => runBacktest({
      bars15m, signalFn: scriptedSignal({}), strategy: STRATEGY, account: ACCOUNT,
      startIndex: 1, endIndex: 1, costMultiplier: 0
    }),
    /costMultiplier must be positive/
  );
});

test("3 - entry fills at the fill bar's open, sized and costed by the real risk/commission formulas", () => {
  const START = Date.parse("2025-06-02T00:00:00.000Z");
  const bars15m = buildBars15m(START, [
    { open: 49000, high: 49100, low: 48900, close: 49050 }, // 0
    { open: 49050, high: 49150, low: 48950, close: 49100 }, // 1 - decision bar (candidate fires)
    { open: 50000, high: 50100, low: 49900, close: 50050 }, // 2 - fill bar
    { open: 50050, high: 50150, low: 49950, close: 50000 }, // 3
    { open: 50000, high: 50100, low: 49900, close: 50000 }  // 4
  ]);
  const signalFn = scriptedSignal({
    1: candidate("LONG", { stopReference: 40000, targetReference: 60000, stopDistance: STOP_DISTANCE })
  });

  const result = runBacktest({
    bars15m, bars4h: [], bars1d: [], signalFn, strategy: STRATEGY, account: ACCOUNT,
    startIndex: 1, endIndex: 3
  });

  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.entryBarIndex, 2);
  assert.equal(trade.entryTime, bars15m[2].openTime);
  assert.equal(trade.requestedEntryPrice, 50000);

  const expectedEntryPrice = 50000 * (1 + STRATEGY.execution.slippageCapPct);
  assert.ok(Math.abs(trade.entryPrice - expectedEntryPrice) < 1e-9);
  assert.equal(trade.quantity, EXPECTED_QTY);
  assert.ok(Math.abs(trade.riskAmount - EXPECTED_RISK) < 1e-9);

  const expectedEntryCommission = expectedEntryPrice * trade.quantity * DEFAULT_ENTRY_COMMISSION_PCT;
  assert.ok(Math.abs(trade.entryCommission - expectedEntryCommission) < 1e-9);
});

test("4 - no second entry is taken while a position is open (one-position rule)", () => {
  const START = Date.parse("2025-06-02T00:00:00.000Z");
  const bars15m = buildBars15m(START, [
    { open: 49000, high: 49100, low: 48900, close: 49050 }, // 0
    { open: 49050, high: 49150, low: 48950, close: 49100 }, // 1 - candidate fires
    { open: 50000, high: 50100, low: 49900, close: 50050 }, // 2 - fill bar / entry
    { open: 50050, high: 50150, low: 49950, close: 50000 }, // 3 - a second candidate is scripted here too
    { open: 50000, high: 50100, low: 49900, close: 50000 }, // 4
    { open: 50000, high: 50100, low: 49900, close: 50000 }  // 5
  ]);
  const longSetup = candidate("LONG", { stopReference: 40000, targetReference: 60000, stopDistance: STOP_DISTANCE });
  const signalFn = scriptedSignal({ 1: longSetup, 3: longSetup });

  const result = runBacktest({
    bars15m, bars4h: [], bars1d: [], signalFn, strategy: STRATEGY, account: ACCOUNT,
    startIndex: 1, endIndex: 4
  });

  assert.equal(result.trades.length, 1, "the position opened at decisionIndex 1 blocks the decisionIndex 3 candidate from ever being queried");
  assert.equal(result.trades[0].entryBarIndex, 2);
});

test("5 - an intrabar stop touch exits at the stop price, not the bar open (LONG)", () => {
  const START = Date.parse("2025-06-02T00:00:00.000Z");
  const stopReference = 49250;
  const bars15m = buildBars15m(START, [
    { open: 49000, high: 49100, low: 48900, close: 49050 }, // 0
    { open: 49050, high: 49150, low: 48950, close: 49100 }, // 1 - candidate fires
    { open: 50000, high: 50100, low: 49900, close: 50050 }, // 2 - fill bar, entry at open=50000
    { open: 49900, high: 49950, low: 49200, close: 49500 }, // 3 - low dips through the stop, open stays above it
    { open: 49500, high: 49600, low: 49400, close: 49500 }  // 4
  ]);
  const signalFn = scriptedSignal({
    1: candidate("LONG", { stopReference, targetReference: 60000, stopDistance: STOP_DISTANCE })
  });

  const result = runBacktest({
    bars15m, bars4h: [], bars1d: [], signalFn, strategy: STRATEGY, account: ACCOUNT,
    startIndex: 1, endIndex: 3
  });

  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.exitReason, "PROTECTIVE_STOP");
  assert.equal(trade.exitBarIndex, 3);
  assert.equal(trade.requestedExitPrice, stopReference);
  const expectedExitPrice = stopReference * (1 - STRATEGY.execution.slippageCapPct);
  assert.ok(Math.abs(trade.exitPrice - expectedExitPrice) < 1e-9);
});

test("6 - a gap through the stop fills at the bar open, not the stop price (LONG)", () => {
  const START = Date.parse("2025-06-02T00:00:00.000Z");
  const stopReference = 49250;
  const bars15m = buildBars15m(START, [
    { open: 49000, high: 49100, low: 48900, close: 49050 }, // 0
    { open: 49050, high: 49150, low: 48950, close: 49100 }, // 1 - candidate fires
    { open: 50000, high: 50100, low: 49900, close: 50050 }, // 2 - fill bar, entry at open=50000
    { open: 49000, high: 49050, low: 48800, close: 48900 }, // 3 - opens BELOW the stop (gap)
    { open: 48900, high: 49000, low: 48800, close: 48900 }  // 4
  ]);
  const signalFn = scriptedSignal({
    1: candidate("LONG", { stopReference, targetReference: 60000, stopDistance: STOP_DISTANCE })
  });

  const result = runBacktest({
    bars15m, bars4h: [], bars1d: [], signalFn, strategy: STRATEGY, account: ACCOUNT,
    startIndex: 1, endIndex: 3
  });

  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.exitReason, "PROTECTIVE_STOP_GAP");
  assert.equal(trade.exitBarIndex, 3);
  assert.equal(trade.requestedExitPrice, bars15m[3].open);
});

test("7 - a target touch's requested price is the exact target (LONG), never a more favorable high", () => {
  const START = Date.parse("2025-06-02T00:00:00.000Z");
  const targetReference = 51000;
  const bars15m = buildBars15m(START, [
    { open: 49000, high: 49100, low: 48900, close: 49050 }, // 0
    { open: 49050, high: 49150, low: 48950, close: 49100 }, // 1 - candidate fires
    { open: 50000, high: 50100, low: 49900, close: 50050 }, // 2 - fill bar, entry at open=50000
    { open: 50100, high: 51800, low: 50050, close: 51600 }, // 3 - high blows well past the target
    { open: 51600, high: 51700, low: 51500, close: 51600 }  // 4
  ]);
  const signalFn = scriptedSignal({
    1: candidate("LONG", { stopReference: 40000, targetReference, stopDistance: STOP_DISTANCE })
  });

  const result = runBacktest({
    bars15m, bars4h: [], bars1d: [], signalFn, strategy: STRATEGY, account: ACCOUNT,
    startIndex: 1, endIndex: 3
  });

  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.exitReason, "TARGET");
  assert.equal(trade.exitBarIndex, 3);
  assert.equal(trade.requestedExitPrice, targetReference, "must request the target, not the bar's more favorable high");
});

test("8 - a SHORT protective stop and target mirror the LONG rules", () => {
  const START = Date.parse("2025-06-02T00:00:00.000Z");
  const stopReference = 50800;
  const bars15m = buildBars15m(START, [
    { open: 51000, high: 51100, low: 50900, close: 51050 }, // 0
    { open: 51050, high: 51150, low: 50950, close: 51100 }, // 1 - candidate fires
    { open: 50000, high: 50100, low: 49900, close: 50050 }, // 2 - fill bar, entry at open=50000 (SHORT)
    { open: 50100, high: 50900, low: 50050, close: 50700 }, // 3 - high touches the stop intrabar, open stays below
    { open: 50700, high: 50800, low: 50600, close: 50700 }  // 4
  ]);
  const signalFn = scriptedSignal({
    1: candidate("SHORT", { stopReference, targetReference: 40000, stopDistance: STOP_DISTANCE })
  });

  const result = runBacktest({
    bars15m, bars4h: [], bars1d: [], signalFn, strategy: STRATEGY, account: ACCOUNT,
    startIndex: 1, endIndex: 3
  });

  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.direction, "SHORT");
  assert.equal(trade.exitReason, "PROTECTIVE_STOP");
  assert.equal(trade.requestedExitPrice, stopReference);
  const expectedExitPrice = stopReference * (1 + STRATEGY.execution.slippageCapPct);
  assert.ok(Math.abs(trade.exitPrice - expectedExitPrice) < 1e-9, "buying to cover a SHORT slips adverse-up");
});

test("9 - a time-stop exit fires at that bar's open once timeStopBars have elapsed", () => {
  const START = Date.parse("2025-06-02T00:00:00.000Z");
  const bars = [
    { open: 49000, high: 49100, low: 48900, close: 49050 }, // 0
    { open: 49050, high: 49150, low: 48950, close: 49100 }  // 1 - candidate fires
  ];
  // Fill bar is index 2 (entry). With timeStopBars = 2, the position must be
  // flattened once barIndex >= entryBarIndex(2) + 2 = 4 - i.e. at bar 4's
  // open. Bars 2 and 3 stay flat and inside the stop/target band so nothing
  // else can trigger first.
  for (let index = 2; index <= 5; index += 1) {
    bars.push({ open: 50000, high: 50050, low: 49950, close: 50000 });
  }
  const bars15m = buildBars15m(START, bars);
  const signalFn = scriptedSignal({
    1: candidate("LONG", {
      stopReference: 40000, targetReference: 60000, stopDistance: STOP_DISTANCE, timeStopBars: 2
    })
  });

  const result = runBacktest({
    bars15m, bars4h: [], bars1d: [], signalFn, strategy: STRATEGY, account: ACCOUNT,
    startIndex: 1, endIndex: 4
  });

  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.entryBarIndex, 2);
  assert.equal(trade.exitReason, "TIME_STOP");
  assert.equal(trade.exitBarIndex, 4);
  assert.equal(trade.requestedExitPrice, bars15m[4].open);
});

test("10 - an open position is force-exited at the 21:45 UTC bar's open (HARD_FLAT)", () => {
  // Bar 0 opens at 20:45 UTC; each bar is 15m, so bar index 4 opens exactly
  // at 21:45 UTC.
  const START = Date.parse("2025-06-02T20:45:00.000Z");
  const bars15m = buildBars15m(START, [
    { open: 49900, high: 50000, low: 49800, close: 49950 }, // 0 (20:45)
    { open: 49950, high: 50050, low: 49850, close: 50000 }, // 1 (21:00) - candidate fires
    { open: 50000, high: 50100, low: 49950, close: 50050 }, // 2 (21:15) - fill bar, entry at open=50000
    { open: 50050, high: 50100, low: 50000, close: 50050 }, // 3 (21:30) - flat, no trigger
    { open: 50050, high: 50100, low: 50000, close: 50050 }, // 4 (21:45) - hard flat
    { open: 50050, high: 50100, low: 50000, close: 50050 }  // 5 (22:00) - padding for the endIndex bound
  ]);
  const signalFn = scriptedSignal({
    1: candidate("LONG", { stopReference: 40000, targetReference: 60000, stopDistance: STOP_DISTANCE })
  });

  const result = runBacktest({
    bars15m, bars4h: [], bars1d: [], signalFn, strategy: STRATEGY, account: ACCOUNT,
    startIndex: 1, endIndex: 4
  });

  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.entryBarIndex, 2);
  assert.equal(trade.exitReason, "HARD_FLAT");
  assert.equal(trade.exitBarIndex, 4);
  assert.equal(trade.requestedExitPrice, bars15m[4].open);
});

test("11 - an exit on the entry bar itself is flagged HOLD_TIME_UNPROVABLE", () => {
  const START = Date.parse("2025-06-02T00:00:00.000Z");
  const stopReference = 49700;
  const bars15m = buildBars15m(START, [
    { open: 49000, high: 49100, low: 48900, close: 49050 }, // 0
    { open: 49050, high: 49150, low: 48950, close: 49100 }, // 1 - candidate fires
    // Fill bar: opens at 50000 (above the stop) but its own low dips through
    // the stop on the very bar the position is entered on.
    { open: 50000, high: 50100, low: 49600, close: 49800 }, // 2
    { open: 49800, high: 49900, low: 49700, close: 49800 }  // 3
  ]);
  const signalFn = scriptedSignal({
    1: candidate("LONG", { stopReference, targetReference: 60000, stopDistance: STOP_DISTANCE })
  });

  const result = runBacktest({
    bars15m, bars4h: [], bars1d: [], signalFn, strategy: STRATEGY, account: ACCOUNT,
    startIndex: 1, endIndex: 2
  });

  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.entryBarIndex, 2);
  assert.equal(trade.exitBarIndex, 2);
  assert.equal(trade.exitReason, "PROTECTIVE_STOP");
  assert.equal(trade.holdBars, 1);
  assert.equal(trade.holdTimeUnprovable, true);
});

test("12 - costMultiplier scales slippage and commission on both entry and exit", () => {
  const START = Date.parse("2025-06-02T00:00:00.000Z");
  const targetReference = 51000;
  const bars15m = buildBars15m(START, [
    { open: 49000, high: 49100, low: 48900, close: 49050 }, // 0
    { open: 49050, high: 49150, low: 48950, close: 49100 }, // 1 - candidate fires
    { open: 50000, high: 50100, low: 49900, close: 50050 }, // 2 - fill bar
    { open: 50100, high: 51050, low: 50050, close: 51000 }, // 3 - hits the target
    { open: 51000, high: 51100, low: 50900, close: 51000 }  // 4
  ]);
  const signalFn = scriptedSignal({
    1: candidate("LONG", { stopReference: 40000, targetReference, stopDistance: STOP_DISTANCE })
  });

  const costMultiplier = 2;
  const result = runBacktest({
    bars15m, bars4h: [], bars1d: [], signalFn, strategy: STRATEGY, account: ACCOUNT,
    startIndex: 1, endIndex: 3, costMultiplier
  });

  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  const scaledSlippage = STRATEGY.execution.slippageCapPct * costMultiplier;
  const expectedEntryPrice = 50000 * (1 + scaledSlippage);
  const expectedExitPrice = targetReference * (1 - scaledSlippage);
  assert.ok(Math.abs(trade.entryPrice - expectedEntryPrice) < 1e-9);
  assert.ok(Math.abs(trade.exitPrice - expectedExitPrice) < 1e-9);

  const expectedEntryCommission = expectedEntryPrice * trade.quantity * DEFAULT_ENTRY_COMMISSION_PCT * costMultiplier;
  const expectedExitCommission = expectedExitPrice * trade.quantity * DEFAULT_EXIT_COMMISSION_PCT * costMultiplier;
  assert.ok(Math.abs(trade.entryCommission - expectedEntryCommission) < 1e-9);
  assert.ok(Math.abs(trade.exitCommission - expectedExitCommission) < 1e-9);
});

test("13 - crossing the 22:00 UTC account-day boundary resets the daily counters (closedBalance persists)", () => {
  const START = Date.parse("2025-06-02T20:00:00.000Z");
  const stopReference = 49250;
  const bars15m = buildBars15m(START, [
    { open: 49900, high: 50000, low: 49800, close: 49950 }, // 0 (20:00)
    { open: 49950, high: 50050, low: 49850, close: 50000 }, // 1 (20:15) - candidate fires
    { open: 50000, high: 50100, low: 49900, close: 50050 }, // 2 (20:30) - fill bar, entry LONG at open=50000
    { open: 49500, high: 49550, low: 49200, close: 49300 }, // 3 (20:45) - stop hit -> realized loss booked
    { open: 49300, high: 49350, low: 49250, close: 49300 }, // 4 (21:00) - flat, no candidate
    { open: 49300, high: 49350, low: 49250, close: 49300 }, // 5 (21:15) - flat
    { open: 49300, high: 49350, low: 49250, close: 49300 }, // 6 (21:30) - flat
    { open: 49300, high: 49350, low: 49250, close: 49300 }, // 7 (21:45) - flat; this bar's close is 22:00 UTC
    { open: 49300, high: 49350, low: 49250, close: 49300 }  // 8 (22:00) - padding for the endIndex bound
  ]);
  const signalFn = scriptedSignal({
    1: candidate("LONG", { stopReference, targetReference: 60000, stopDistance: STOP_DISTANCE })
  });

  const result = runBacktest({
    bars15m, bars4h: [], bars1d: [], signalFn, strategy: STRATEGY, account: ACCOUNT,
    startIndex: 1, endIndex: 7
  });

  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.exitReason, "PROTECTIVE_STOP");
  assert.ok(trade.netPnl < 0, "the trade must realize a loss for the reset to be observable");
  assert.equal(result.haltedAtIndex, null);
  assert.equal(result.finalState.dailyRealizedPnl, 0, "the account-day boundary at bar 7's close must reset the daily counter");
  assert.equal(result.finalState.lossesToday, 0, "the loss count resets too");
  assert.ok(
    Math.abs(result.finalState.closedBalance - (ACCOUNT.startingBalance + trade.netPnl)) < 1e-9,
    "closedBalance itself is unaffected by the daily-counter reset"
  );
});

test("14 - an account failure force-flattens the open position and halts the run", () => {
  const START = Date.parse("2025-06-02T00:00:00.000Z");
  // activeFloor for a fresh state is 48500 (dailyFloor = startingBalance -
  // dailyLossLimit). A deep enough intrabar move against the open position
  // pushes live equity (closedBalance + dailyUnrealizedPnl) at-or-below that
  // floor. The stop is set far away so PROTECTIVE_STOP never pre-empts this.
  const bars15m = buildBars15m(START, [
    { open: 49000, high: 49100, low: 48900, close: 49050 }, // 0
    { open: 49050, high: 49150, low: 48950, close: 49100 }, // 1 - candidate fires
    { open: 50000, high: 50100, low: 49900, close: 50050 }, // 2 - fill bar, entry LONG at open=50000
    { open: 50050, high: 50100, low: 37900, close: 38500 }, // 3 - catastrophic drop; unrealized loss breaches the floor
    { open: 38500, high: 38600, low: 38400, close: 38500 }  // 4 - padding; must never be reached
  ]);
  const signalFn = scriptedSignal({
    1: candidate("LONG", { stopReference: 1000, targetReference: 60000, stopDistance: STOP_DISTANCE })
  });

  const result = runBacktest({
    bars15m, bars4h: [], bars1d: [], signalFn, strategy: STRATEGY, account: ACCOUNT,
    startIndex: 1, endIndex: 3
  });

  assert.ok(result.accountFailure, "a breach of the active floor must be recorded");
  assert.equal(result.accountFailure.atBarIndex, 3);
  assert.equal(result.haltedAtIndex, 3);
  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.exitReason, "ACCOUNT_FAILURE");
  assert.equal(trade.exitBarIndex, 3);
  assert.equal(trade.requestedExitPrice, bars15m[3].close);
  assert.equal(result.finalState.dailyUnrealizedPnl, 0, "the forced close must clear unrealized P&L");
});

test("15 - a position entered on the very last permitted decision bar still exits after (not before) its own entry", () => {
  const START = Date.parse("2025-06-02T00:00:00.000Z");
  const bars15m = buildBars15m(START, [
    { open: 49000, high: 49100, low: 48900, close: 49050 }, // 0
    { open: 49050, high: 49150, low: 48950, close: 49100 }, // 1 - endIndex: candidate fires on the final iteration
    { open: 50000, high: 50100, low: 49900, close: 50050 }  // 2 - fill bar; the loop never iterates over this index
  ]);
  const signalFn = scriptedSignal({
    1: candidate("LONG", { stopReference: 40000, targetReference: 60000, stopDistance: STOP_DISTANCE })
  });

  const result = runBacktest({
    bars15m, bars4h: [], bars1d: [], signalFn, strategy: STRATEGY, account: ACCOUNT,
    startIndex: 1, endIndex: 1
  });

  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.entryBarIndex, 2);
  assert.equal(trade.exitBarIndex, 2, "must never exit on a bar before its own entry bar");
  assert.equal(trade.exitReason, "END_OF_DATA");
  assert.equal(trade.holdBars, 1);
  assert.equal(trade.holdTimeUnprovable, true);
  assert.equal(trade.requestedExitPrice, bars15m[2].close);
});

test("16 - a position still open at the natural end of the run is closed at the last bar's close (END_OF_DATA)", () => {
  const START = Date.parse("2025-06-02T00:00:00.000Z");
  const bars15m = buildBars15m(START, [
    { open: 49000, high: 49100, low: 48900, close: 49050 }, // 0
    { open: 49050, high: 49150, low: 48950, close: 49100 }, // 1 - candidate fires
    { open: 50000, high: 50100, low: 49900, close: 50050 }, // 2 - fill bar, entry
    { open: 50050, high: 50100, low: 50000, close: 50050 }, // 3 - flat
    { open: 50050, high: 50100, low: 50000, close: 50075 }  // 4 - last bar; the default endIndex stops here
  ]);
  const signalFn = scriptedSignal({
    1: candidate("LONG", { stopReference: 40000, targetReference: 60000, stopDistance: STOP_DISTANCE })
  });

  // No explicit endIndex - exercises the default (bars15m.length - 2 = 3).
  const result = runBacktest({
    bars15m, bars4h: [], bars1d: [], signalFn, strategy: STRATEGY, account: ACCOUNT, startIndex: 1
  });

  assert.equal(result.endIndex, 3);
  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.exitReason, "END_OF_DATA");
  assert.equal(trade.exitBarIndex, 3);
  assert.equal(trade.requestedExitPrice, bars15m[3].close);
});

test("17 - defaults are exported and match the frozen contract's Section 8/9.1 assumptions", () => {
  assert.equal(DEFAULT_ENTRY_COMMISSION_PCT, 0.0004);
  assert.equal(DEFAULT_EXIT_COMMISSION_PCT, 0.0004);
  assert.deepEqual(DEFAULT_LOT_RULES, { minLot: 0.001, lotIncrement: 0.001 });
  assert.equal(RESEARCH_STAGE_RISK_CAP, 100);
});
