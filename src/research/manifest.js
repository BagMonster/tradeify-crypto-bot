import { createHash } from "node:crypto";

const BAR_INTERVAL_MS = Object.freeze({
  "15m": 15 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000
});

export const EXPECTED_BAR_COUNTS = Object.freeze({ "15m": 35040, "4h": 2190, "1d": 365 });
export const EXPECTED_SOURCE = "binance";
export const EXPECTED_SYMBOL = "BTCUSDT";
export const BARS_PER_TWELFTH = 2920;
export const PARTITION_TWELFTHS = Object.freeze({ development: 8, validation: 2, holdout: 2 });
export const CONTRACT_VERSION = "26.1-amended";

function requirePositiveNumber(name, value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return number;
}

function verifyTimeframe(bars, timeframe, { expectedSource, expectedSymbol, expectedCount }) {
  const intervalMs = BAR_INTERVAL_MS[timeframe];
  if (!Array.isArray(bars)) throw new Error(`${timeframe} bars must be an array`);
  if (bars.length !== expectedCount) {
    throw new Error(
      `${timeframe} bars must contain exactly ${expectedCount} completed bars, found ${bars.length}`
    );
  }

  let previousCloseTime = null;
  let firstOpenTime = null;
  let lastCloseTime = null;

  bars.forEach((input, index) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error(`${timeframe} bars[${index}] must be an object`);
    }
    if (input.isClosed !== true) {
      throw new Error(`${timeframe} bars[${index}] must be completed`);
    }
    if (input.timeframe !== timeframe) {
      throw new Error(`${timeframe} bars[${index}] has the wrong timeframe`);
    }
    if (input.source !== expectedSource || input.symbol !== expectedSymbol) {
      throw new Error(
        `${timeframe} bars[${index}] must carry source "${expectedSource}" and symbol "${expectedSymbol}"`
      );
    }

    const openTime = Date.parse(input.openTime);
    const closeTime = Date.parse(input.closeTime);
    if (!Number.isFinite(openTime) || !Number.isFinite(closeTime)) {
      throw new Error(`${timeframe} bars[${index}] must have valid ISO timestamps`);
    }
    if (openTime % intervalMs !== 0) {
      throw new Error(
        `${timeframe} bars[${index}] openTime must be UTC-aligned to the ${timeframe} boundary`
      );
    }
    if (closeTime - openTime !== intervalMs) {
      throw new Error(`${timeframe} bars[${index}] must be exactly one completed ${timeframe} interval`);
    }
    if (previousCloseTime !== null) {
      if (openTime < previousCloseTime) {
        throw new Error(`${timeframe} bars[${index}] regresses before the prior bar's close time`);
      }
      if (openTime !== previousCloseTime) {
        throw new Error(`${timeframe} bars[${index}] leaves a gap after the prior bar's close time`);
      }
    }
    previousCloseTime = closeTime;
    firstOpenTime ??= openTime;
    lastCloseTime = closeTime;

    const open = requirePositiveNumber(`${timeframe} bars[${index}].open`, input.open);
    const high = requirePositiveNumber(`${timeframe} bars[${index}].high`, input.high);
    const low = requirePositiveNumber(`${timeframe} bars[${index}].low`, input.low);
    const close = requirePositiveNumber(`${timeframe} bars[${index}].close`, input.close);
    if (high < Math.max(open, low, close) || low > Math.min(open, high, close)) {
      throw new Error(`${timeframe} bars[${index}] has inconsistent OHLC values`);
    }
  });

  return Object.freeze({
    count: bars.length,
    firstOpenTime: new Date(firstOpenTime).toISOString(),
    lastCloseTime: new Date(lastCloseTime).toISOString()
  });
}

/**
 * Section 2.1 dataset verification. Aborts (throws) on the first failing check
 * rather than warning and continuing. Every field is checked independently per
 * timeframe: exact bar count, completed/UTC-aligned/contiguous timestamps,
 * one hardcoded source and symbol, and valid OHLC geometry.
 */
export function verifyDataset({
  bars15m,
  bars4h,
  bars1d,
  expectedSource = EXPECTED_SOURCE,
  expectedSymbol = EXPECTED_SYMBOL,
  expectedCounts = EXPECTED_BAR_COUNTS
} = {}) {
  const summary15m = verifyTimeframe(bars15m, "15m", {
    expectedSource,
    expectedSymbol,
    expectedCount: expectedCounts["15m"]
  });
  const summary4h = verifyTimeframe(bars4h, "4h", {
    expectedSource,
    expectedSymbol,
    expectedCount: expectedCounts["4h"]
  });
  const summary1d = verifyTimeframe(bars1d, "1d", {
    expectedSource,
    expectedSymbol,
    expectedCount: expectedCounts["1d"]
  });

  return Object.freeze({
    source: expectedSource,
    symbol: expectedSymbol,
    counts: Object.freeze({
      "15m": summary15m.count,
      "4h": summary4h.count,
      "1d": summary1d.count
    }),
    first15mOpenTime: summary15m.firstOpenTime,
    last15mCloseTime: summary15m.lastCloseTime,
    first4hOpenTime: summary4h.firstOpenTime,
    last4hCloseTime: summary4h.lastCloseTime,
    first1dOpenTime: summary1d.firstOpenTime,
    last1dCloseTime: summary1d.lastCloseTime
  });
}

/**
 * Section 2.3 fixed-bar-count partitions. Development is bars 1-23,360 (8
 * twelfths), validation 23,361-29,200 (2 twelfths), holdout 29,201-35,040 (2
 * twelfths), at 2,920 bars per twelfth. Indices below are 0-indexed into the
 * verified bars15m array; tDevEndCloseTime/tValEndCloseTime are the two
 * boundary timestamps 4h and 1d bars are assigned against.
 */
export function computePartitions(bars15m) {
  if (!Array.isArray(bars15m) || bars15m.length !== EXPECTED_BAR_COUNTS["15m"]) {
    throw new Error(`bars15m must contain exactly ${EXPECTED_BAR_COUNTS["15m"]} verified bars`);
  }

  const developmentCount = BARS_PER_TWELFTH * PARTITION_TWELFTHS.development;
  const validationCount = BARS_PER_TWELFTH * PARTITION_TWELFTHS.validation;
  const holdoutCount = BARS_PER_TWELFTH * PARTITION_TWELFTHS.holdout;
  if (developmentCount + validationCount + holdoutCount !== bars15m.length) {
    throw new Error("partition twelfths do not add up to the verified bar count");
  }

  const developmentEndIndex = developmentCount - 1;
  const validationEndIndex = developmentCount + validationCount - 1;
  const holdoutEndIndex = bars15m.length - 1;

  const tDevEndCloseTime = bars15m[developmentEndIndex].closeTime;
  const tValEndCloseTime = bars15m[validationEndIndex].closeTime;
  const tDevEndCloseTimeMs = Date.parse(tDevEndCloseTime);
  const tValEndCloseTimeMs = Date.parse(tValEndCloseTime);
  if (!Number.isFinite(tDevEndCloseTimeMs) || !Number.isFinite(tValEndCloseTimeMs)) {
    throw new Error("partition boundary bars must have valid ISO closeTime values");
  }

  return Object.freeze({
    barsPerTwelfth: BARS_PER_TWELFTH,
    development: Object.freeze({
      startIndex: 0,
      endIndex: developmentEndIndex,
      count: developmentCount,
      twelfths: PARTITION_TWELFTHS.development
    }),
    validation: Object.freeze({
      startIndex: developmentEndIndex + 1,
      endIndex: validationEndIndex,
      count: validationCount,
      twelfths: PARTITION_TWELFTHS.validation
    }),
    holdout: Object.freeze({
      startIndex: validationEndIndex + 1,
      endIndex: holdoutEndIndex,
      count: holdoutCount,
      twelfths: PARTITION_TWELFTHS.holdout
    }),
    tDevEndCloseTime,
    tValEndCloseTime,
    tDevEndCloseTimeMs,
    tValEndCloseTimeMs
  });
}

/**
 * Section 2.3: 4h and 1d bars are assigned to a partition by close time
 * against the two 15m-derived boundary timestamps, never by their own bar
 * counts (2,190 / 12 does not divide evenly). The boundary instant itself
 * belongs to the earlier partition, matching that the boundary IS the last
 * bar's close time in that partition.
 */
export function partitionForCloseTime(closeTime, partitions) {
  const closeTimeMs = typeof closeTime === "number" ? closeTime : Date.parse(closeTime);
  if (!Number.isFinite(closeTimeMs)) throw new Error("closeTime must be a valid timestamp");
  if (!partitions || typeof partitions.tDevEndCloseTimeMs !== "number" ||
      typeof partitions.tValEndCloseTimeMs !== "number") {
    throw new Error("partitions must be the object returned by computePartitions");
  }
  if (closeTimeMs <= partitions.tDevEndCloseTimeMs) return "development";
  if (closeTimeMs <= partitions.tValEndCloseTimeMs) return "validation";
  return "holdout";
}

/** Section 2.2: SHA-256 hex digest of a config file's raw text content. */
export function sha256Hex(text) {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("text must be a non-empty string");
  }
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Section 2.2 run manifest. Two runs with identical inputs must produce a
 * byte-identical manifest (JSON.stringify equal) — this function is pure and
 * deterministic in every field.
 */
export function buildManifest({
  datasetSummary,
  partitions,
  strategyConfigHash,
  accountConfigHash,
  gitCommit,
  monteCarloSeed,
  contractVersion = CONTRACT_VERSION
}) {
  if (!datasetSummary || typeof datasetSummary !== "object") {
    throw new Error("datasetSummary is required");
  }
  if (!partitions || typeof partitions !== "object") {
    throw new Error("partitions is required");
  }
  if (typeof strategyConfigHash !== "string" || !/^[0-9a-f]{64}$/.test(strategyConfigHash)) {
    throw new Error("strategyConfigHash must be a 64-character SHA-256 hex digest");
  }
  if (typeof accountConfigHash !== "string" || !/^[0-9a-f]{64}$/.test(accountConfigHash)) {
    throw new Error("accountConfigHash must be a 64-character SHA-256 hex digest");
  }
  if (typeof gitCommit !== "string" || gitCommit.trim() === "") {
    throw new Error("gitCommit must be a non-empty string");
  }
  if (!Number.isInteger(monteCarloSeed)) {
    throw new Error("monteCarloSeed must be an integer");
  }
  if (typeof contractVersion !== "string" || contractVersion.trim() === "") {
    throw new Error("contractVersion must be a non-empty string");
  }

  return Object.freeze({
    contractVersion,
    source: datasetSummary.source,
    symbol: datasetSummary.symbol,
    counts: Object.freeze({ ...datasetSummary.counts }),
    first15mOpenTime: datasetSummary.first15mOpenTime,
    last15mCloseTime: datasetSummary.last15mCloseTime,
    partitionBoundaries: Object.freeze({
      tDevEndCloseTime: partitions.tDevEndCloseTime,
      tValEndCloseTime: partitions.tValEndCloseTime
    }),
    strategyConfigHash,
    accountConfigHash,
    gitCommit: gitCommit.trim(),
    monteCarloSeed
  });
}

const REQUIRED_SLOT_KEYS = Object.freeze(["slot1", "slot2", "slot3", "slot4"]);

function requireConfigHash(name, value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} must be a 64-character SHA-256 hex digest`);
  }
  return value;
}

/**
 * Section 6.2 step 2's freeze record: "every parameter, the selected
 * variant, the config hashes, the git commit, the timestamp" - written and
 * committed AFTER folds 1-4 select the single Slot 4 variant and BEFORE
 * folds 5-6 run, per Section 6.2's non-negotiable ordering. No parameter
 * may change after this record is written; this function only assembles
 * and validates the record, it does not enforce that ordering itself (the
 * caller - scripts/run-backtest.mjs - is what decides when to call it).
 *
 * `slots` carries the frozen parameter definition for all four slots
 * (Section 3's Slot 1-4), keyed slot1..slot4, so the record is a complete
 * strategy freeze - not just the Slot 4 selection evidence. `slots.slot4`
 * is expected to be the selected variant's own parameter object (e.g.
 * COMPRESSION_VARIANTS' {id, breakoutPeriod, percentile}), separate from
 * `slot4Variants` below, which carries the FULL walkForward.js
 * rankSlot4Variants(...) comparison - every variant, not just the winner -
 * so the freeze record shows the losing variants' evidence too, not only
 * the outcome.
 */
export function buildFreezeRecord({
  contractVersion = CONTRACT_VERSION,
  slots,
  slot4Variants,
  strategyConfigHash,
  accountConfigHash,
  gitCommit,
  timestamp
}) {
  if (typeof contractVersion !== "string" || contractVersion.trim() === "") {
    throw new Error("contractVersion must be a non-empty string");
  }
  if (!slots || typeof slots !== "object" || Array.isArray(slots)) {
    throw new Error("slots must be an object");
  }
  const slotKeys = Object.keys(slots).sort();
  if (slotKeys.length !== REQUIRED_SLOT_KEYS.length ||
      !REQUIRED_SLOT_KEYS.every((key, index) => slotKeys[index] === key)) {
    throw new Error(`slots must have exactly these keys: ${REQUIRED_SLOT_KEYS.join(", ")}`);
  }
  REQUIRED_SLOT_KEYS.forEach((key) => {
    if (!slots[key] || typeof slots[key] !== "object" || Array.isArray(slots[key])) {
      throw new Error(`slots.${key} must be an object`);
    }
  });

  if (!Array.isArray(slot4Variants) || slot4Variants.length === 0) {
    throw new Error("slot4Variants must be a non-empty array");
  }
  let selectedCount = 0;
  let selectedSlot4VariantId = null;
  slot4Variants.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`slot4Variants[${index}] must be an object`);
    }
    if (typeof entry.variantId !== "string" || entry.variantId.trim() === "") {
      throw new Error(`slot4Variants[${index}].variantId must be a non-empty string`);
    }
    if (!Number.isInteger(entry.rank) || entry.rank < 1) {
      throw new Error(`slot4Variants[${index}].rank must be a positive integer`);
    }
    if (!entry.aggregate || typeof entry.aggregate !== "object") {
      throw new Error(`slot4Variants[${index}].aggregate must be an object`);
    }
    if (entry.rank === 1) {
      selectedCount += 1;
      selectedSlot4VariantId = entry.variantId;
    }
  });
  if (selectedCount !== 1) {
    throw new Error("slot4Variants must contain exactly one entry with rank 1");
  }
  if (slots.slot4.id !== undefined && slots.slot4.id !== selectedSlot4VariantId) {
    throw new Error("slots.slot4.id must match the rank-1 entry in slot4Variants");
  }

  requireConfigHash("strategyConfigHash", strategyConfigHash);
  requireConfigHash("accountConfigHash", accountConfigHash);
  if (typeof gitCommit !== "string" || gitCommit.trim() === "") {
    throw new Error("gitCommit must be a non-empty string");
  }
  const timestampMs = Date.parse(timestamp);
  if (typeof timestamp !== "string" || !Number.isFinite(timestampMs)) {
    throw new Error("timestamp must be a valid ISO timestamp string");
  }

  return Object.freeze({
    contractVersion,
    freezeStep: "26.6",
    slots: Object.freeze({
      slot1: Object.freeze({ ...slots.slot1 }),
      slot2: Object.freeze({ ...slots.slot2 }),
      slot3: Object.freeze({ ...slots.slot3 }),
      slot4: Object.freeze({ ...slots.slot4 })
    }),
    slot4Variants: Object.freeze(slot4Variants.map((entry) => Object.freeze({ ...entry }))),
    selectedSlot4VariantId,
    strategyConfigHash,
    accountConfigHash,
    gitCommit: gitCommit.trim(),
    timestamp
  });
}
