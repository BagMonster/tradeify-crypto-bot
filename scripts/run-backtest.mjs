#!/usr/bin/env node
/**
 * scripts/run-backtest.mjs
 *
 * CLI entry point — never imported by index.mjs, never imported by any
 * research module. Reads bars and writes files only (Section 12's safety
 * boundary): no network call, no PostgreSQL access, no secret is read here.
 * The bars this script reads come from local JSON files that
 * scripts/export-bars-for-research.mjs writes separately, using the
 * owner's own DATABASE_URL — this script never touches DATABASE_URL at
 * all.
 *
 * Usage (from the repository root):
 *   node scripts/run-backtest.mjs --step 26.6
 *
 * Step 26.6 mode (the only mode implemented so far, per Section 6.2's
 * freeze order):
 *   1. Verify the exported dataset (manifest.js) and compute partitions.
 *   2. Build the Section 5 daily regime timeline.
 *   3. Run each of the 4 Slot 4 compression-breakout variants, IN
 *      ISOLATION, across walk-forward folds 1-4 only (never folds 5-6 —
 *      those overlap the validation partition and must not run before the
 *      freeze, per Section 6.1/6.2).
 *   4. Rank the 4 variants (walkForward.js's rankSlot4Variants) and select
 *      the winner.
 *   5. Assemble and write the freeze record (manifest.js's
 *      buildFreezeRecord) to docs/chapter-26-slot4-freeze-record.json.
 *
 * This script does not commit or push anything — it only writes a file to
 * the local working tree. Committing the freeze record is a separate,
 * explicit git step the owner takes after reviewing this script's output.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadAccountConfig, loadStrategyConfig } from "../src/config.js";
import {
  EXPECTED_BAR_COUNTS,
  buildFreezeRecord,
  computePartitions,
  sha256Hex,
  verifyDataset
} from "../src/research/manifest.js";
import { calculateDailyRegimeTimeline } from "../src/research/regime.js";
import {
  COMPRESSION_BREAKOUT_STRATEGY_ID,
  DONCHIAN_STRATEGY_ID,
  MEAN_REVERSION_STRATEGY_ID,
  TS_MOMENTUM_STRATEGY_ID,
  createSignalRouter
} from "../src/research/router.js";
import { runBacktest } from "../src/research/backtestEngine.js";
import { summarizeTrades } from "../src/research/metrics.js";
import {
  SLOT4_SELECTION_WALK_FORWARD_FOLDS,
  rankSlot4Variants
} from "../src/research/walkForward.js";
import {
  COMPRESSION_VARIANTS
} from "../src/research/strategies/compressionBreakout.js";
import { DONCHIAN_ENTRY_PERIOD, DONCHIAN_EXIT_PERIOD } from "../src/research/strategies/donchian.js";
import { TS_MOMENTUM_LOOKBACK, TS_MOMENTUM_EMA_PERIOD } from "../src/research/strategies/tsMomentum.js";

const BARS_DIR = path.resolve("artifacts", "research-bars");
const FREEZE_RECORD_PATH = path.resolve("docs", "chapter-26-slot4-freeze-record.json");

function parseArgs(argv) {
  const args = { step: "26.6" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--step" && argv[index + 1]) {
      args.step = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

async function readJsonFile(filePath) {
  const text = await readFile(filePath, "utf8");
  return { text, parsed: JSON.parse(text) };
}

/**
 * scripts/export-bars-for-research.mjs deliberately exports EVERY completed
 * bar currently stored, with no upper limit — the bot keeps recording new
 * completed candles in real time, so by the time this script runs, the
 * export will almost always hold slightly MORE than the exact
 * EXPECTED_BAR_COUNTS Section 2.1 named as the frozen research dataset
 * (35,040 / 2,190 / 365). manifest.js's verifyDataset intentionally fails
 * closed on any count other than exactly those — it will not silently
 * accept "close enough." Rather than weaken that check, trim each series
 * here to its earliest EXPECTED_BAR_COUNTS entries (bars are already
 * chronological, source ASC by open_time), reproducing the exact frozen
 * one-year window every time this is run, regardless of how much extra
 * history has accumulated since. Trimming from the front (not the back)
 * keeps the dataset's start point stable across repeated exports, which
 * matters since every fold boundary, partition, and test fixture in this
 * chapter is defined by bar COUNT, anchored to that original start point.
 */
function trimToExpectedWindow(bars, timeframe) {
  const expected = EXPECTED_BAR_COUNTS[timeframe];
  if (!Array.isArray(bars) || bars.length < expected) {
    throw new Error(
      `${timeframe}.json has ${Array.isArray(bars) ? bars.length : "0"} bars, ` +
      `fewer than the ${expected} the frozen contract requires — re-export once enough history exists`
    );
  }
  if (bars.length > expected) {
    console.log(`  ${timeframe}: trimming ${bars.length} exported bars to the earliest ${expected}`);
  }
  return bars.slice(0, expected);
}

async function loadExportedBars() {
  const [bars15m, bars4h, bars1d] = await Promise.all([
    readJsonFile(path.join(BARS_DIR, "15m.json")),
    readJsonFile(path.join(BARS_DIR, "4h.json")),
    readJsonFile(path.join(BARS_DIR, "1d.json"))
  ]);
  return {
    bars15m: trimToExpectedWindow(bars15m.parsed, "15m"),
    bars4h: trimToExpectedWindow(bars4h.parsed, "4h"),
    bars1d: trimToExpectedWindow(bars1d.parsed, "1d")
  };
}

/**
 * Reads the current commit of the working tree's checked-out branch
 * directly from .git, without shelling out to a git binary — the same
 * technique used throughout this project's own tooling. Falls back to
 * .git/packed-refs if a branch has no loose ref file.
 */
async function readGitCommit() {
  const headText = (await readFile(path.resolve(".git", "HEAD"), "utf8")).trim();
  const refMatch = headText.match(/^ref:\s*(.+)$/);
  if (!refMatch) {
    // Detached HEAD: the file itself already holds the commit hash.
    return headText;
  }
  const refPath = refMatch[1].trim();
  try {
    return (await readFile(path.resolve(".git", refPath), "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const packedRefs = await readFile(path.resolve(".git", "packed-refs"), "utf8");
    const line = packedRefs
      .split("\n")
      .find((entry) => entry.endsWith(` ${refPath}`));
    if (!line) throw new Error(`could not resolve ${refPath} to a commit (not loose, not packed)`);
    return line.split(" ")[0].trim();
  }
}

function runCompressionVariantOnFold({ bars15m, bars4h, bars1d, regimeTimeline, strategy, account, variant, fold }) {
  const router = createSignalRouter({
    regimeTimeline,
    enabledStrategyIds: [COMPRESSION_BREAKOUT_STRATEGY_ID],
    compressionVariant: variant
  });
  const result = runBacktest({
    bars15m,
    bars4h,
    bars1d,
    signalFn: router.signalFn,
    strategy,
    account,
    startIndex: fold.testStartIndex,
    endIndex: fold.testEndIndex,
    dynamicExitFns: router.dynamicExitFns,
    routeLabel: `slot4-${variant.id}-fold${fold.foldNumber}`
  });
  return result;
}

async function runStep266() {
  console.log("Step 26.6 — folds 1-4, Slot 4 variant selection, freeze record\n");

  console.log(`Reading exported bars from ${BARS_DIR} ...`);
  const { bars15m, bars4h, bars1d } = await loadExportedBars();

  console.log("Verifying dataset (manifest.js) ...");
  const datasetSummary = verifyDataset({ bars15m, bars4h, bars1d });
  const partitions = computePartitions(bars15m);
  console.log(
    `  ${datasetSummary.counts["15m"]} 15m / ${datasetSummary.counts["4h"]} 4h / ` +
    `${datasetSummary.counts["1d"]} 1d bars verified. ` +
    `${datasetSummary.first15mOpenTime} .. ${datasetSummary.last15mCloseTime}`
  );

  console.log("Loading config/strategy.json and config/account.json ...");
  const [strategy, account] = await Promise.all([loadStrategyConfig(), loadAccountConfig()]);
  const strategyRaw = await readFile(path.resolve("config", "strategy.json"), "utf8");
  const accountRaw = await readFile(path.resolve("config", "account.json"), "utf8");
  const strategyConfigHash = sha256Hex(strategyRaw);
  const accountConfigHash = sha256Hex(accountRaw);

  console.log("Building the Section 5 daily regime timeline ...");
  const regimeTimeline = calculateDailyRegimeTimeline(bars1d, {
    period: strategy.regime.adxPeriod,
    thresholds: {
      minDailyAtrPct: strategy.regime.minDailyAtrPct,
      maxDailyAtrPct: strategy.regime.maxDailyAtrPct,
      adxMax: strategy.regime.adxMax,
      adxStandDown: strategy.regime.adxStandDown
    }
  });
  console.log(`  ${regimeTimeline.length} daily regime entries computed.`);

  console.log(`\nFolds 1-4 (Slot 4 selection only — folds 5-6 do NOT run before the freeze):`);
  SLOT4_SELECTION_WALK_FORWARD_FOLDS.forEach((fold) => {
    console.log(
      `  fold ${fold.foldNumber}: test twelfth ${fold.testTwelfth}, ` +
      `bars15m[${fold.testStartIndex}..${fold.testEndIndex}]`
    );
  });

  console.log(`\nRunning ${COMPRESSION_VARIANTS.length} Slot 4 variants across folds 1-4, in isolation:`);
  const variantResults = COMPRESSION_VARIANTS.map((variant) => {
    const perFoldTrades = SLOT4_SELECTION_WALK_FORWARD_FOLDS.map((fold) => {
      const result = runCompressionVariantOnFold({
        bars15m, bars4h, bars1d, regimeTimeline, strategy, account, variant, fold
      });
      if (result.accountFailure) {
        console.log(
          `  WARNING: variant ${variant.id} fold ${fold.foldNumber} hit an account failure ` +
          `at bar ${result.accountFailure.atBarIndex} (${result.accountFailure.atCloseTime})`
        );
      }
      return result.trades;
    });
    const foldSummaries = perFoldTrades.map((trades) => summarizeTrades(trades));
    foldSummaries.forEach((summary, index) => {
      console.log(
        `  ${variant.id} fold ${index + 1}: ${summary.tradeCount} trades, netPnl ${summary.netPnl.toFixed(2)}`
      );
    });
    return { variantId: variant.id, perFoldTrades };
  });

  console.log("\nRanking variants (Section 9.4: net profit -> profit/drawdown -> fold stability) ...");
  const ranked = rankSlot4Variants(variantResults);
  ranked.forEach((entry) => {
    console.log(
      `  rank ${entry.rank}: ${entry.variantId} — netPnl ${entry.aggregate.netPnl.toFixed(2)}, ` +
      `profitToDrawdown ${entry.aggregate.profitToDrawdown === null ? "null" : entry.aggregate.profitToDrawdown.toFixed(3)}, ` +
      `profitableFolds ${entry.profitableFoldCount}/4, worstFoldNetPnl ${entry.worstFoldNetPnl.toFixed(2)}`
    );
  });

  const selected = ranked[0];
  const selectedVariantDefinition = COMPRESSION_VARIANTS.find((variant) => variant.id === selected.variantId);
  console.log(`\nSelected Slot 4 variant: ${selected.variantId}`);

  const gitCommit = await readGitCommit();
  const timestamp = new Date().toISOString();

  const freezeRecord = buildFreezeRecord({
    slots: {
      slot1: Object.freeze({
        strategyId: DONCHIAN_STRATEGY_ID,
        entryPeriod: DONCHIAN_ENTRY_PERIOD,
        exitPeriod: DONCHIAN_EXIT_PERIOD
      }),
      slot2: Object.freeze({
        strategyId: TS_MOMENTUM_STRATEGY_ID,
        momentumLookback: TS_MOMENTUM_LOOKBACK,
        emaPeriod: TS_MOMENTUM_EMA_PERIOD
      }),
      slot3: Object.freeze({
        strategyId: MEAN_REVERSION_STRATEGY_ID,
        signalConfig: Object.freeze({ ...strategy.signal })
      }),
      slot4: Object.freeze({ ...selectedVariantDefinition })
    },
    slot4Variants: ranked,
    strategyConfigHash,
    accountConfigHash,
    gitCommit,
    timestamp
  });

  await writeFile(FREEZE_RECORD_PATH, `${JSON.stringify(freezeRecord, null, 2)}\n`, "utf8");
  console.log(`\nFreeze record written to ${FREEZE_RECORD_PATH}`);
  console.log("This file is NOT committed yet — review it, then commit it as Section 6.2 step 2 requires,");
  console.log("BEFORE running folds 5-6 (Step 26.7). No parameter may change after this commit.");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.step !== "26.6") {
    throw new Error(`Unsupported --step "${args.step}" — only "26.6" is implemented so far.`);
  }
  await runStep266();
}

main().catch((error) => {
  console.error(`run-backtest failed: ${error.message}`);
  console.error(error.stack);
  process.exitCode = 1;
});
