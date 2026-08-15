import test from "node:test";
import assert from "node:assert/strict";
import { BARS_PER_TWELFTH } from "../src/research/manifest.js";
import {
  WALK_FORWARD_TRAIN_TWELFTHS,
  WALK_FORWARD_TOTAL_FOLDS,
  SLOT4_SELECTION_FOLDS,
  walkForwardFold,
  WALK_FORWARD_FOLDS,
  SLOT4_SELECTION_WALK_FORWARD_FOLDS,
  rankSlot4Variants,
  selectSlot4Variant
} from "../src/research/walkForward.js";

function trade(overrides) {
  return Object.freeze({
    routeLabel: "test-run",
    strategyId: "compression-breakout",
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

test("constants match Section 6.1", () => {
  assert.equal(WALK_FORWARD_TRAIN_TWELFTHS, 4);
  assert.equal(WALK_FORWARD_TOTAL_FOLDS, 6);
  assert.equal(SLOT4_SELECTION_FOLDS, 4);
  assert.equal(BARS_PER_TWELFTH, 2920);
});

test("walkForwardFold rejects a non-integer or out-of-range fold number", () => {
  assert.throws(() => walkForwardFold(0), /foldNumber must be an integer from 1 to 6/);
  assert.throws(() => walkForwardFold(7), /foldNumber must be an integer from 1 to 6/);
  assert.throws(() => walkForwardFold(1.5), /foldNumber must be an integer from 1 to 6/);
  assert.throws(() => walkForwardFold("1"), /foldNumber must be an integer from 1 to 6/);
  assert.throws(() => walkForwardFold(undefined), /foldNumber must be an integer from 1 to 6/);
});

test("fold 1 tests twelfth 5, 0-indexed [11680, 14599]", () => {
  const fold = walkForwardFold(1);
  assert.equal(fold.foldNumber, 1);
  assert.equal(fold.testTwelfth, 5);
  assert.equal(fold.testStartIndex, 11680);
  assert.equal(fold.testEndIndex, 14599);
  assert.equal(fold.testCount, 2920);
  assert.equal(fold.trainStartIndex, 0);
  assert.equal(fold.trainEndIndex, 11679);
  assert.equal(fold.trainCount, 11680);
  assert.equal(fold.purpose, "Slot 4 selection + stability");
});

test("fold 4 tests twelfth 8, 0-indexed [20440, 23359]", () => {
  const fold = walkForwardFold(4);
  assert.equal(fold.testTwelfth, 8);
  assert.equal(fold.testStartIndex, 20440);
  assert.equal(fold.testEndIndex, 23359);
  assert.equal(fold.trainStartIndex, 8760);
  assert.equal(fold.trainEndIndex, 20439);
  assert.equal(fold.purpose, "Slot 4 selection + stability");
});

test("fold 6 tests twelfth 10, 0-indexed [26280, 29199], stability-only purpose", () => {
  const fold = walkForwardFold(6);
  assert.equal(fold.testTwelfth, 10);
  assert.equal(fold.testStartIndex, 26280);
  assert.equal(fold.testEndIndex, 29199);
  assert.equal(fold.trainStartIndex, 14600);
  assert.equal(fold.trainEndIndex, 26279);
  assert.equal(fold.purpose, "Stability reporting only, run after freeze");
});

test("every fold's train window is contiguous with its test window and 4 twelfths long", () => {
  for (let foldNumber = 1; foldNumber <= 6; foldNumber += 1) {
    const fold = walkForwardFold(foldNumber);
    assert.equal(fold.trainEndIndex + 1, fold.testStartIndex);
    assert.equal(fold.trainCount, 4 * BARS_PER_TWELFTH);
    assert.equal(fold.testCount, BARS_PER_TWELFTH);
  }
});

test("WALK_FORWARD_FOLDS holds all 6 folds in order and is frozen", () => {
  assert.equal(WALK_FORWARD_FOLDS.length, 6);
  WALK_FORWARD_FOLDS.forEach((fold, index) => assert.equal(fold.foldNumber, index + 1));
  assert.ok(Object.isFrozen(WALK_FORWARD_FOLDS));
  assert.ok(Object.isFrozen(WALK_FORWARD_FOLDS[0]));
});

test("SLOT4_SELECTION_WALK_FORWARD_FOLDS holds exactly folds 1-4", () => {
  assert.equal(SLOT4_SELECTION_WALK_FORWARD_FOLDS.length, 4);
  assert.deepEqual(
    SLOT4_SELECTION_WALK_FORWARD_FOLDS.map((fold) => fold.foldNumber),
    [1, 2, 3, 4]
  );
});

function foldTrades(exitBarIndices, netPnl) {
  return exitBarIndices.map((exitBarIndex, tradeIndex) =>
    trade({
      exitBarIndex,
      netPnl,
      grossPnl: netPnl,
      exitTime: new Date(2025, 0, 1 + exitBarIndex + tradeIndex).toISOString()
    })
  );
}

test("rankSlot4Variants rejects malformed input", () => {
  assert.throws(() => rankSlot4Variants([]), /non-empty array/);
  assert.throws(() => rankSlot4Variants("nope"), /non-empty array/);
  assert.throws(() => rankSlot4Variants([{}]), /variantId must be a non-empty string/);
  assert.throws(
    () => rankSlot4Variants([{ variantId: "L10-N20", perFoldTrades: [[], []] }]),
    /must contain exactly 4 fold trade arrays/
  );
  assert.throws(
    () => rankSlot4Variants([{ variantId: "L10-N20", perFoldTrades: [[], [], [], "nope"] }]),
    /perFoldTrades\[3\] must be an array/
  );
});

test("rankSlot4Variants rejects duplicate variant ids", () => {
  const perFoldTrades = [[], [], [], []];
  assert.throws(
    () => rankSlot4Variants([
      { variantId: "L10-N20", perFoldTrades },
      { variantId: "L10-N20", perFoldTrades }
    ]),
    /duplicate variantId\(s\): L10-N20/
  );
});

test("rankSlot4Variants ranks by aggregate net profit first", () => {
  const ranked = rankSlot4Variants([
    {
      variantId: "loser",
      perFoldTrades: [
        foldTrades([100], -50),
        foldTrades([200], -50),
        foldTrades([300], -50),
        foldTrades([400], -50)
      ]
    },
    {
      variantId: "winner",
      perFoldTrades: [
        foldTrades([100], 100),
        foldTrades([200], 100),
        foldTrades([300], 100),
        foldTrades([400], 100)
      ]
    }
  ]);

  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].variantId, "winner");
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[0].aggregate.netPnl, 400);
  assert.equal(ranked[1].variantId, "loser");
  assert.equal(ranked[1].rank, 2);
  assert.equal(ranked[1].aggregate.netPnl, -200);
  assert.ok(Object.isFrozen(ranked));
  assert.ok(Object.isFrozen(ranked[0]));
});

test("rankSlot4Variants breaks a net-profit tie on profitToDrawdown", () => {
  // Both variants net +100 in aggregate, but "smooth" never draws down at
  // all (maxDrawdown 0 -> profitToDrawdown null, since summarizeTrades only
  // defines the ratio when maxDrawdown > 0) while "choppy" round-trips
  // through a real, finite, positive profitToDrawdown. A defined ratio must
  // outrank an undefined one (the comparator treats null as -Infinity), so
  // "choppy" ranks ahead of "smooth" despite identical aggregate netPnl.
  const ranked = rankSlot4Variants([
    {
      variantId: "choppy",
      perFoldTrades: [
        [trade({ exitBarIndex: 1, netPnl: 200, grossPnl: 200 }), trade({ exitBarIndex: 2, netPnl: -100, grossPnl: -100 })],
        [],
        [],
        []
      ]
    },
    {
      variantId: "smooth",
      perFoldTrades: [
        [trade({ exitBarIndex: 1, netPnl: 100, grossPnl: 100 })],
        [],
        [],
        []
      ]
    }
  ]);

  assert.equal(ranked[0].aggregate.netPnl, 100);
  assert.equal(ranked[1].aggregate.netPnl, 100);
  assert.equal(ranked[0].variantId, "choppy");
  assert.ok(typeof ranked[0].aggregate.profitToDrawdown === "number");
  assert.equal(ranked[1].variantId, "smooth");
  assert.ok(ranked[1].aggregate.profitToDrawdown === null);
});

test("rankSlot4Variants breaks a net-profit and profitToDrawdown tie on profitable fold count", () => {
  const ranked = rankSlot4Variants([
    {
      variantId: "one-outlier-fold",
      perFoldTrades: [
        foldTrades([1], 400),
        foldTrades([2], -100),
        foldTrades([3], -100),
        foldTrades([4], -100)
      ]
    },
    {
      variantId: "profitable-every-fold",
      perFoldTrades: [
        foldTrades([1], 50),
        foldTrades([2], 50),
        foldTrades([3], 50),
        foldTrades([4], -50)
      ]
    }
  ]);

  assert.equal(ranked[0].aggregate.netPnl, 100);
  assert.equal(ranked[1].aggregate.netPnl, 100);
  assert.equal(ranked[0].variantId, "profitable-every-fold");
  assert.equal(ranked[0].profitableFoldCount, 3);
  assert.equal(ranked[1].variantId, "one-outlier-fold");
  assert.equal(ranked[1].profitableFoldCount, 1);
});

test("rankSlot4Variants breaks a final tie on worst single-fold netPnl", () => {
  // Both variants: folds 1-2 are +100 each, folds 3-4 together give back
  // exactly -100 (net aggregate +100 for both). Because both losing folds
  // sit at the end in the same order for both variants, the running
  // peak-to-trough drawdown is identical either way (200 - 100 = 100, so
  // profitToDrawdown is 1 for both) regardless of how that -100 is split
  // across the two folds - only worstFoldNetPnl (the single worst fold)
  // differs: -80 for "deep-worst-fold" vs -50 for "shallow-worst-fold".
  const ranked = rankSlot4Variants([
    {
      variantId: "deep-worst-fold",
      perFoldTrades: [
        foldTrades([1], 100),
        foldTrades([2], 100),
        foldTrades([3], -80),
        foldTrades([4], -20)
      ]
    },
    {
      variantId: "shallow-worst-fold",
      perFoldTrades: [
        foldTrades([1], 100),
        foldTrades([2], 100),
        foldTrades([3], -50),
        foldTrades([4], -50)
      ]
    }
  ]);

  assert.equal(ranked[0].aggregate.netPnl, 100);
  assert.equal(ranked[1].aggregate.netPnl, 100);
  assert.equal(ranked[0].aggregate.profitToDrawdown, ranked[1].aggregate.profitToDrawdown);
  assert.equal(ranked[0].profitableFoldCount, ranked[1].profitableFoldCount);
  assert.equal(ranked[0].variantId, "shallow-worst-fold");
  assert.equal(ranked[0].worstFoldNetPnl, -50);
  assert.equal(ranked[1].variantId, "deep-worst-fold");
  assert.equal(ranked[1].worstFoldNetPnl, -80);
});

test("rankSlot4Variants handles a variant with no trades in any fold", () => {
  const ranked = rankSlot4Variants([
    { variantId: "flat", perFoldTrades: [[], [], [], []] }
  ]);
  assert.equal(ranked[0].aggregate.netPnl, 0);
  assert.equal(ranked[0].aggregate.tradeCount, 0);
  assert.equal(ranked[0].profitableFoldCount, 0);
  assert.equal(ranked[0].worstFoldNetPnl, 0);
});

test("rankSlot4Variants requires each fold's trades to already be chronological", () => {
  assert.throws(
    () => rankSlot4Variants([
      {
        variantId: "out-of-order",
        perFoldTrades: [
          [trade({ exitBarIndex: 20, netPnl: 10 }), trade({ exitBarIndex: 10, netPnl: 10 })],
          [],
          [],
          []
        ]
      }
    ]),
    /chronological order/
  );
});

test("selectSlot4Variant returns only the rank-1 entry", () => {
  const winner = selectSlot4Variant([
    { variantId: "loser", perFoldTrades: [foldTrades([1], -10), [], [], []] },
    { variantId: "winner", perFoldTrades: [foldTrades([1], 10), [], [], []] }
  ]);
  assert.equal(winner.variantId, "winner");
  assert.equal(winner.rank, 1);
});
