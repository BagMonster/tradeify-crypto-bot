import { BARS_PER_TWELFTH } from "./manifest.js";
import { summarizeTrades } from "./metrics.js";

export const WALK_FORWARD_TRAIN_TWELFTHS = 4;
export const WALK_FORWARD_TOTAL_FOLDS = 6;
export const SLOT4_SELECTION_FOLDS = 4;

/**
 * Section 6.1 walk-forward folds: a fixed 4-twelfth train window, a
 * 1-twelfth test window, stepping 1 twelfth at a time across the first 10
 * of the 12 twelfths manifest.js's PARTITION_TWELFTHS divides the verified
 * dataset into. Fold N's test window is twelfth (N + 4) - fold 1 tests
 * twelfth 5 (the first twelfth with a full 4-twelfth trailing train window),
 * fold 6 tests twelfth 10. Twelfths 1-8 are the development partition and
 * 9-10 are the validation partition, so folds 5-6 land inside validation by
 * construction - that is exactly why Section 6.2's freeze order requires
 * folds 1-4 to select and freeze Slot 4 FIRST, and only run folds 5-6
 * (stability reporting only) after that freeze record is committed. Nothing
 * in this module enforces that ordering; it is enforced by which folds the
 * caller chooses to run and when (see SLOT4_SELECTION_FOLDS /
 * SLOT4_SELECTION_WALK_FORWARD_FOLDS below).
 *
 * All indices are 0-indexed offsets into a verified bars15m array, matching
 * manifest.js's computePartitions convention. Train and test windows are
 * contiguous and non-overlapping (trainEndIndex + 1 === testStartIndex).
 * The train window is warm-up/context only - every one of Chapter 26's four
 * slots is a fixed-parameter strategy, not a fitted model, so "train" never
 * means parameter fitting here; src/research/backtestEngine.js's
 * runBacktest only ever scores decisions inside [startIndex, endIndex], so
 * a fold's train window exists solely to give causal indicator/regime
 * lookups their required trailing history when the fold is run against the
 * FULL bars15m array (never a pre-sliced one - slicing would shift every
 * exitBarIndex and break chronological ordering across folds).
 */
export function walkForwardFold(foldNumber) {
  if (!Number.isInteger(foldNumber) || foldNumber < 1 || foldNumber > WALK_FORWARD_TOTAL_FOLDS) {
    throw new Error(`foldNumber must be an integer from 1 to ${WALK_FORWARD_TOTAL_FOLDS}`);
  }

  const testTwelfth = foldNumber + WALK_FORWARD_TRAIN_TWELFTHS;
  const testStartIndex = (testTwelfth - 1) * BARS_PER_TWELFTH;
  const testEndIndex = testTwelfth * BARS_PER_TWELFTH - 1;
  const trainStartIndex = (testTwelfth - WALK_FORWARD_TRAIN_TWELFTHS - 1) * BARS_PER_TWELFTH;
  const trainEndIndex = testStartIndex - 1;

  return Object.freeze({
    foldNumber,
    testTwelfth,
    trainStartIndex,
    trainEndIndex,
    trainCount: trainEndIndex - trainStartIndex + 1,
    testStartIndex,
    testEndIndex,
    testCount: testEndIndex - testStartIndex + 1,
    purpose: foldNumber <= SLOT4_SELECTION_FOLDS
      ? "Slot 4 selection + stability"
      : "Stability reporting only, run after freeze"
  });
}

/** All 6 folds, in fold-number order. */
export const WALK_FORWARD_FOLDS = Object.freeze(
  Array.from({ length: WALK_FORWARD_TOTAL_FOLDS }, (_, index) => walkForwardFold(index + 1))
);

/** The 4 folds Section 6.2 permits to run before the freeze (folds 1-4 only). */
export const SLOT4_SELECTION_WALK_FORWARD_FOLDS = Object.freeze(
  WALK_FORWARD_FOLDS.filter((fold) => fold.foldNumber <= SLOT4_SELECTION_FOLDS)
);

/**
 * Section 9.4's Slot 4 selection criteria, in priority order: "net profit
 * after costs" first, "profit relative to drawdown" second, "parameter
 * stability" third, "holdout behavior" fourth. Holdout is not opened at
 * this step (Section 6.2's step 6 opens it, long after the freeze), so it
 * never enters this ranking - qualification against holdout is a later
 * step's job, not this function's.
 *
 * [INTERPRETATION, flagged to the owner]: Section 9.4 names "parameter
 * stability" as a criterion without defining it numerically. This module
 * reads it as: how many of the SLOT4_SELECTION_FOLDS folds a variant is
 * independently profitable in (profitableFoldCount), then - as a further
 * tiebreak - how bad its single worst fold is (worstFoldNetPnl). A variant
 * profitable in every fold is judged more stable than one whose aggregate
 * profit comes from a single outlier fold and losses elsewhere, even at a
 * similar aggregate total. This is checked only AFTER net profit and
 * profit/drawdown are compared, so it can only break ties between variants
 * that are already close on both contract-named, higher-priority criteria -
 * it can never override either of them.
 *
 * Expects each entry's perFoldTrades[i] to be the trade list from running
 * that variant, alone, over SLOT4_SELECTION_WALK_FORWARD_FOLDS[i]'s test
 * window against the FULL bars15m array (see walkForwardFold's docstring) -
 * so exitBarIndex is monotonically increasing both within a fold and across
 * folds 1 through 4, and perFoldTrades.flat() is already in the
 * chronological order summarizeTrades requires.
 */
export function rankSlot4Variants(variantResults) {
  if (!Array.isArray(variantResults) || variantResults.length === 0) {
    throw new Error("variantResults must be a non-empty array");
  }

  const evaluated = variantResults.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`variantResults[${index}] must be an object`);
    }
    const { variantId, perFoldTrades } = entry;
    if (typeof variantId !== "string" || variantId.trim() === "") {
      throw new Error(`variantResults[${index}].variantId must be a non-empty string`);
    }
    if (!Array.isArray(perFoldTrades) || perFoldTrades.length !== SLOT4_SELECTION_FOLDS) {
      throw new Error(
        `variantResults[${index}].perFoldTrades must contain exactly ${SLOT4_SELECTION_FOLDS} fold trade arrays`
      );
    }

    const foldSummaries = perFoldTrades.map((trades, foldIndex) => {
      if (!Array.isArray(trades)) {
        throw new Error(`variantResults[${index}].perFoldTrades[${foldIndex}] must be an array`);
      }
      return summarizeTrades(trades);
    });

    const aggregate = summarizeTrades(perFoldTrades.flat());
    const profitableFoldCount = foldSummaries.filter((summary) => summary.netPnl > 0).length;
    const worstFoldNetPnl = Math.min(...foldSummaries.map((summary) => summary.netPnl));

    return Object.freeze({
      variantId,
      foldSummaries: Object.freeze(foldSummaries),
      aggregate,
      profitableFoldCount,
      worstFoldNetPnl
    });
  });

  const duplicateIds = new Set();
  const seenIds = new Set();
  evaluated.forEach(({ variantId }) => {
    if (seenIds.has(variantId)) duplicateIds.add(variantId);
    seenIds.add(variantId);
  });
  if (duplicateIds.size > 0) {
    throw new Error(`variantResults contains duplicate variantId(s): ${[...duplicateIds].join(", ")}`);
  }

  const sorted = [...evaluated].sort((a, b) => {
    if (b.aggregate.netPnl !== a.aggregate.netPnl) return b.aggregate.netPnl - a.aggregate.netPnl;
    const aRatio = a.aggregate.profitToDrawdown ?? -Infinity;
    const bRatio = b.aggregate.profitToDrawdown ?? -Infinity;
    if (bRatio !== aRatio) return bRatio - aRatio;
    if (b.profitableFoldCount !== a.profitableFoldCount) return b.profitableFoldCount - a.profitableFoldCount;
    return b.worstFoldNetPnl - a.worstFoldNetPnl;
  });

  return Object.freeze(sorted.map((result, index) => Object.freeze({ ...result, rank: index + 1 })));
}

/** Convenience wrapper around rankSlot4Variants: returns the rank-1 entry alone. */
export function selectSlot4Variant(variantResults) {
  return rankSlot4Variants(variantResults)[0];
}
