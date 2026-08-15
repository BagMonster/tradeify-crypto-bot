import test from "node:test";
import assert from "node:assert/strict";
import {
  BARS_PER_TWELFTH,
  CONTRACT_VERSION,
  EXPECTED_BAR_COUNTS,
  buildFreezeRecord,
  buildManifest,
  computePartitions,
  partitionForCloseTime,
  sha256Hex,
  verifyDataset
} from "../src/research/manifest.js";

const INTERVAL_MS = Object.freeze({
  "15m": 15 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000
});

function bars(timeframe, count, {
  source = "binance",
  symbol = "BTCUSDT",
  startTime = Date.parse("2025-08-16T00:00:00.000Z"),
  startPrice = 50_000,
  step = 0.25
} = {}) {
  const intervalMs = INTERVAL_MS[timeframe];
  return Array.from({ length: count }, (_, index) => {
    const close = startPrice + (index * step);
    const openTime = startTime + (index * intervalMs);
    return {
      source,
      symbol,
      timeframe,
      openTime: new Date(openTime).toISOString(),
      closeTime: new Date(openTime + intervalMs).toISOString(),
      open: close - 0.1,
      high: close + 0.2,
      low: close - 0.2,
      close,
      volume: 100 + index,
      isClosed: true
    };
  });
}

function fullYearDataset() {
  return {
    bars15m: bars("15m", EXPECTED_BAR_COUNTS["15m"]),
    bars4h: bars("4h", EXPECTED_BAR_COUNTS["4h"]),
    bars1d: bars("1d", EXPECTED_BAR_COUNTS["1d"])
  };
}

test("1 - a full, well-formed year verifies and reports exact counts and boundaries", () => {
  const summary = verifyDataset(fullYearDataset());
  assert.deepEqual(summary.counts, EXPECTED_BAR_COUNTS);
  assert.equal(summary.source, "binance");
  assert.equal(summary.symbol, "BTCUSDT");
  assert.equal(summary.first15mOpenTime, "2025-08-16T00:00:00.000Z");
  assert.equal(summary.last15mCloseTime, new Date(
    Date.parse("2025-08-16T00:00:00.000Z") + (EXPECTED_BAR_COUNTS["15m"] * INTERVAL_MS["15m"])
  ).toISOString());
});

test("2 - a bar count that does not match 35,040 / 2,190 / 365 is rejected", () => {
  const dataset = fullYearDataset();
  dataset.bars15m.pop();
  assert.throws(() => verifyDataset(dataset), /exactly 35040/);
});

test("3 - a source or symbol other than binance/BTCUSDT is rejected", () => {
  const dataset = fullYearDataset();
  dataset.bars4h[10] = { ...dataset.bars4h[10], source: "dxtrade" };
  assert.throws(() => verifyDataset(dataset), /source "binance" and symbol "BTCUSDT"/);
});

test("4 - incomplete, gapped, regressed, misaligned, and malformed-OHLC bars are all rejected", () => {
  const incomplete = fullYearDataset();
  incomplete.bars15m[10] = { ...incomplete.bars15m[10], isClosed: false };
  assert.throws(() => verifyDataset(incomplete), /must be completed/);

  const gap = fullYearDataset();
  gap.bars1d[10] = {
    ...gap.bars1d[10],
    openTime: new Date(Date.parse(gap.bars1d[10].openTime) + INTERVAL_MS["1d"]).toISOString(),
    closeTime: new Date(Date.parse(gap.bars1d[10].closeTime) + INTERVAL_MS["1d"]).toISOString()
  };
  assert.throws(() => verifyDataset(gap), /leaves a gap/);

  const misaligned = fullYearDataset();
  misaligned.bars15m[0] = {
    ...misaligned.bars15m[0],
    openTime: "2025-08-16T00:00:01.000Z",
    closeTime: "2025-08-16T00:15:01.000Z"
  };
  assert.throws(() => verifyDataset(misaligned), /UTC-aligned/);

  const badGeometry = fullYearDataset();
  badGeometry.bars4h[5] = { ...badGeometry.bars4h[5], high: badGeometry.bars4h[5].low - 1 };
  assert.throws(() => verifyDataset(badGeometry), /inconsistent OHLC/);
});

test("5 - partitions split 35,040 bars into 8/2/2 twelfths of 2,920 bars each", () => {
  const { bars15m } = fullYearDataset();
  const partitions = computePartitions(bars15m);

  assert.equal(partitions.barsPerTwelfth, BARS_PER_TWELFTH);
  assert.deepEqual(partitions.development, { startIndex: 0, endIndex: 23359, count: 23360, twelfths: 8 });
  assert.deepEqual(partitions.validation, {
    startIndex: 23360, endIndex: 29199, count: 5840, twelfths: 2
  });
  assert.deepEqual(partitions.holdout, {
    startIndex: 29200, endIndex: 35039, count: 5840, twelfths: 2
  });
  assert.equal(partitions.tDevEndCloseTime, bars15m[23359].closeTime);
  assert.equal(partitions.tValEndCloseTime, bars15m[29199].closeTime);
});

test("6 - computePartitions requires exactly the verified 35,040-bar array", () => {
  assert.throws(() => computePartitions(bars("15m", 100)), /exactly 35040/);
});

test("7 - 4h and 1d bars are assigned to partitions by close time, not by their own bar count", () => {
  const { bars15m } = fullYearDataset();
  const partitions = computePartitions(bars15m);

  assert.equal(partitionForCloseTime(partitions.tDevEndCloseTime, partitions), "development");
  assert.equal(
    partitionForCloseTime(partitions.tDevEndCloseTimeMs + 1, partitions),
    "validation"
  );
  assert.equal(partitionForCloseTime(partitions.tValEndCloseTime, partitions), "validation");
  assert.equal(
    partitionForCloseTime(partitions.tValEndCloseTimeMs + 1, partitions),
    "holdout"
  );
});

test("8 - sha256Hex matches the known NIST test vector for \"abc\"", () => {
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  assert.throws(() => sha256Hex(""), /non-empty string/);
});

test("9 - buildManifest assembles a complete, deterministic manifest", () => {
  const { bars15m } = fullYearDataset();
  const datasetSummary = verifyDataset(fullYearDataset());
  const partitions = computePartitions(bars15m);
  const input = {
    datasetSummary,
    partitions,
    strategyConfigHash: sha256Hex("strategy-config"),
    accountConfigHash: sha256Hex("account-config"),
    gitCommit: "abc1234",
    monteCarloSeed: 42
  };

  const first = buildManifest(input);
  const second = buildManifest(input);
  assert.deepEqual(first, second);
  assert.equal(first.contractVersion, CONTRACT_VERSION);
  assert.equal(first.gitCommit, "abc1234");
  assert.equal(first.monteCarloSeed, 42);
  assert.deepEqual(first.partitionBoundaries, {
    tDevEndCloseTime: partitions.tDevEndCloseTime,
    tValEndCloseTime: partitions.tValEndCloseTime
  });
});

test("10 - buildManifest rejects malformed hashes, commit, and seed", () => {
  const { bars15m } = fullYearDataset();
  const base = {
    datasetSummary: verifyDataset(fullYearDataset()),
    partitions: computePartitions(bars15m),
    strategyConfigHash: sha256Hex("strategy-config"),
    accountConfigHash: sha256Hex("account-config"),
    gitCommit: "abc1234",
    monteCarloSeed: 42
  };

  assert.throws(() => buildManifest({ ...base, strategyConfigHash: "not-a-hash" }), /SHA-256/);
  assert.throws(() => buildManifest({ ...base, accountConfigHash: "not-a-hash" }), /SHA-256/);
  assert.throws(() => buildManifest({ ...base, gitCommit: "" }), /gitCommit/);
  assert.throws(() => buildManifest({ ...base, monteCarloSeed: 1.5 }), /integer/);
});

function freezeRecordSlots(slot4Overrides = {}) {
  return {
    slot1: Object.freeze({ strategyId: "donchian-breakout", channelPeriod: 20 }),
    slot2: Object.freeze({ strategyId: "ts-momentum", lookback: 90 }),
    slot3: Object.freeze({ strategyId: "mean-reversion" }),
    slot4: Object.freeze({ id: "L10-N20", breakoutPeriod: 10, percentile: 20, ...slot4Overrides })
  };
}

function slot4Variants({ selectedId = "L10-N20" } = {}) {
  const ids = ["L10-N20", "L10-N40", "L30-N20", "L30-N40"];
  return ids.map((variantId, index) => Object.freeze({
    variantId,
    rank: variantId === selectedId ? 1 : index + 2,
    aggregate: Object.freeze({ netPnl: variantId === selectedId ? 500 : 100 * index })
  }));
}

test("11 - buildFreezeRecord assembles a complete, deterministic freeze record", () => {
  const input = {
    slots: freezeRecordSlots(),
    slot4Variants: slot4Variants(),
    strategyConfigHash: sha256Hex("strategy-config"),
    accountConfigHash: sha256Hex("account-config"),
    gitCommit: "abc1234",
    timestamp: "2026-08-15T00:00:00.000Z"
  };

  const first = buildFreezeRecord(input);
  const second = buildFreezeRecord(input);
  assert.deepEqual(first, second);
  assert.equal(first.contractVersion, CONTRACT_VERSION);
  assert.equal(first.freezeStep, "26.6");
  assert.equal(first.selectedSlot4VariantId, "L10-N20");
  assert.equal(first.slots.slot4.id, "L10-N20");
  assert.equal(first.slot4Variants.length, 4);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.slots));
  assert.ok(Object.isFrozen(first.slots.slot1));
  assert.ok(Object.isFrozen(first.slot4Variants));
  assert.ok(Object.isFrozen(first.slot4Variants[0]));
});

test("12 - buildFreezeRecord rejects a slots object missing a required slot", () => {
  const base = {
    slot4Variants: slot4Variants(),
    strategyConfigHash: sha256Hex("strategy-config"),
    accountConfigHash: sha256Hex("account-config"),
    gitCommit: "abc1234",
    timestamp: "2026-08-15T00:00:00.000Z"
  };
  const { slot1, slot2, slot3, slot4 } = freezeRecordSlots();
  assert.throws(
    () => buildFreezeRecord({ ...base, slots: { slot1, slot2, slot3 } }),
    /slots must have exactly these keys/
  );
  assert.throws(
    () => buildFreezeRecord({ ...base, slots: { slot1, slot2, slot3, slot4, slot5: {} } }),
    /slots must have exactly these keys/
  );
  assert.throws(
    () => buildFreezeRecord({ ...base, slots: { slot1, slot2, slot3, slot4: "nope" } }),
    /slots\.slot4 must be an object/
  );
});

test("13 - buildFreezeRecord requires exactly one rank-1 slot4Variants entry", () => {
  const base = {
    slots: freezeRecordSlots(),
    strategyConfigHash: sha256Hex("strategy-config"),
    accountConfigHash: sha256Hex("account-config"),
    gitCommit: "abc1234",
    timestamp: "2026-08-15T00:00:00.000Z"
  };

  const noWinner = slot4Variants().map((entry) => Object.freeze({ ...entry, rank: entry.rank + 1 }));
  assert.throws(
    () => buildFreezeRecord({ ...base, slot4Variants: noWinner }),
    /exactly one entry with rank 1/
  );

  const twoWinners = slot4Variants().map((entry, index) =>
    Object.freeze({ ...entry, rank: index < 2 ? 1 : entry.rank }));
  assert.throws(
    () => buildFreezeRecord({ ...base, slot4Variants: twoWinners }),
    /exactly one entry with rank 1/
  );
});

test("14 - buildFreezeRecord requires slots.slot4.id to match the rank-1 variant", () => {
  const base = {
    slots: freezeRecordSlots({ id: "L30-N40" }),
    slot4Variants: slot4Variants({ selectedId: "L10-N20" }),
    strategyConfigHash: sha256Hex("strategy-config"),
    accountConfigHash: sha256Hex("account-config"),
    gitCommit: "abc1234",
    timestamp: "2026-08-15T00:00:00.000Z"
  };
  assert.throws(() => buildFreezeRecord(base), /slots\.slot4\.id must match/);
});

test("15 - buildFreezeRecord rejects malformed hashes, commit, and timestamp", () => {
  const base = {
    slots: freezeRecordSlots(),
    slot4Variants: slot4Variants(),
    strategyConfigHash: sha256Hex("strategy-config"),
    accountConfigHash: sha256Hex("account-config"),
    gitCommit: "abc1234",
    timestamp: "2026-08-15T00:00:00.000Z"
  };

  assert.throws(() => buildFreezeRecord({ ...base, strategyConfigHash: "not-a-hash" }), /SHA-256/);
  assert.throws(() => buildFreezeRecord({ ...base, accountConfigHash: "not-a-hash" }), /SHA-256/);
  assert.throws(() => buildFreezeRecord({ ...base, gitCommit: "" }), /gitCommit/);
  assert.throws(() => buildFreezeRecord({ ...base, timestamp: "not-a-date" }), /timestamp/);
  assert.throws(() => buildFreezeRecord({ ...base, timestamp: undefined }), /timestamp/);
});
