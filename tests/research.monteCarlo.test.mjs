import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_QUALIFYING_SHUFFLE_COUNT,
  fisherYatesShuffle,
  mulberry32,
  replayShuffledSequence,
  runMonteCarlo
} from "../src/research/monteCarlo.js";

const ACCOUNT = Object.freeze({
  startingBalance: 50000,
  maxLossOffset: 3000,
  maxLossFloorCap: 50000,
  dailyLossLimit: 1500
});

test("1 - mulberry32 requires an integer seed", () => {
  assert.throws(() => mulberry32(1.5), /seed must be an integer/);
  assert.throws(() => mulberry32("42"), /seed must be an integer/);
});

test("2 - mulberry32(42) reproduces a locked, known draw sequence (Section 9.5 determinism)", () => {
  const rng = mulberry32(42);
  const draws = Array.from({ length: 5 }, () => rng());
  const expected = [
    0.6011037519201636,
    0.44829055899754167,
    0.8524657934904099,
    0.6697340414393693,
    0.17481389874592423
  ];
  draws.forEach((draw, index) => {
    assert.ok(Math.abs(draw - expected[index]) < 1e-15, `draw ${index} diverged from the locked sequence`);
  });
});

test("3 - two independent mulberry32 generators from the same seed produce identical streams", () => {
  const a = mulberry32(123);
  const b = mulberry32(123);
  const drawsA = Array.from({ length: 20 }, () => a());
  const drawsB = Array.from({ length: 20 }, () => b());
  assert.deepEqual(drawsA, drawsB);
});

test("4 - fisherYatesShuffle validates its inputs", () => {
  assert.throws(() => fisherYatesShuffle("not-an-array", mulberry32(1)), /items must be an array/);
  assert.throws(() => fisherYatesShuffle([1, 2, 3], null), /randomFn must be a function/);
});

test("5 - fisherYatesShuffle never mutates its input array", () => {
  const original = Object.freeze([1, 2, 3, 4, 5]);
  const copy = [...original];
  fisherYatesShuffle(copy, mulberry32(5));
  assert.deepEqual(copy, [1, 2, 3, 4, 5]);
});

test("6 - fisherYatesShuffle(seed 42) reproduces a locked, known permutation", () => {
  const shuffled = fisherYatesShuffle([1, 2, 3, 4, 5, 6, 7, 8], mulberry32(42));
  assert.deepEqual(shuffled, [3, 8, 2, 1, 7, 6, 4, 5]);
  // still a permutation of the original set
  assert.deepEqual([...shuffled].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("7 - replayShuffledSequence never breaches when the balance always stays above the MLL floor", () => {
  const trades = [{ netPnl: 100 }, { netPnl: 50 }, { netPnl: -20 }];
  const result = replayShuffledSequence(trades, ACCOUNT);
  assert.equal(result.breached, false);
  assert.equal(result.breachedAtIndex, null);
  assert.equal(result.closedBalance, 50130);
});

test("8 - a large win that ratchets the MLL floor up, followed by a loss that drops below the new floor, breaches", () => {
  // 50000 -> +100 = 50100 (new high, mllFloor ratchets to 50100-3000=47100)
  // -> -5000 = 45100, which is <= the just-ratcheted 47100 floor
  const trades = [{ netPnl: 100 }, { netPnl: -5000 }];
  const result = replayShuffledSequence(trades, ACCOUNT);
  assert.equal(result.breached, true);
  assert.equal(result.breachedAtIndex, 1);
  assert.equal(result.closedBalance, 45100);
  assert.equal(result.mllFloor, 47100);
});

test("9 - a loss that breaches the initial MLL floor with no prior high-water ratchet", () => {
  // initial mllFloor = 50000 - 3000 = 47000; a single -3500 loss lands at 46500 <= 47000
  const trades = [{ netPnl: -3500 }];
  const result = replayShuffledSequence(trades, ACCOUNT);
  assert.equal(result.breached, true);
  assert.equal(result.breachedAtIndex, 0);
  assert.equal(result.closedBalance, 46500);
  assert.equal(result.mllFloor, 47000);
});

test("10 - replayShuffledSequence fails closed on a non-finite netPnl", () => {
  const trades = [{ netPnl: 100 }, { netPnl: Number.NaN }];
  assert.throws(() => replayShuffledSequence(trades, ACCOUNT), /trades\[1\]\.netPnl must be a finite number/);
});

test("11 - runMonteCarlo validates trades, account, seed, and shuffleCount", () => {
  assert.throws(
    () => runMonteCarlo({ trades: "nope", account: ACCOUNT, seed: 1, shuffleCount: 10 }),
    /trades must be an array/
  );
  assert.throws(
    () => runMonteCarlo({ trades: [], account: null, seed: 1, shuffleCount: 10 }),
    /account must be an object/
  );
  assert.throws(
    () => runMonteCarlo({ trades: [], account: ACCOUNT, seed: 1.5, shuffleCount: 10 }),
    /seed must be an integer/
  );
  assert.throws(
    () => runMonteCarlo({ trades: [], account: ACCOUNT, seed: 1, shuffleCount: 0 }),
    /shuffleCount must be a positive integer/
  );
});

test("12 - runMonteCarlo is deterministic: the same seed, trades, and account reproduce byte-identical output", () => {
  const trades = Array.from({ length: 40 }, (_, index) => ({ netPnl: index % 5 === 0 ? -800 : 150 }));
  const first = runMonteCarlo({ trades, account: ACCOUNT, seed: 7, shuffleCount: 50 });
  const second = runMonteCarlo({ trades, account: ACCOUNT, seed: 7, shuffleCount: 50 });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.failureCount, 24);
});

test("13 - runMonteCarlo draws from one continuous PRNG stream, never re-seeding per shuffle", () => {
  const trades = Array.from({ length: 40 }, (_, index) => ({ netPnl: index % 5 === 0 ? -800 : 150 }));
  // The first 50 shuffles of a 100-shuffle run are driven by the exact same
  // draws as a standalone 50-shuffle run (same seed) - so a 100-shuffle run
  // can only ever accumulate as many or more failures than a 50-shuffle run,
  // never fewer. A per-shuffle re-seed bug would break this relationship.
  const shorter = runMonteCarlo({ trades, account: ACCOUNT, seed: 7, shuffleCount: 50 });
  const longer = runMonteCarlo({ trades, account: ACCOUNT, seed: 7, shuffleCount: 100 });
  assert.equal(shorter.failureCount, 24);
  assert.equal(longer.failureCount, 48);
  assert.ok(longer.failureCount >= shorter.failureCount);
});

test("14 - an all-winning trade sequence never breaches, regardless of seed", () => {
  const onlyWins = Array.from({ length: 20 }, () => ({ netPnl: 50 }));
  for (const seed of [1, 99, 123456]) {
    const result = runMonteCarlo({ trades: onlyWins, account: ACCOUNT, seed, shuffleCount: 20 });
    assert.equal(result.failureCount, 0);
    assert.equal(result.zeroFailures, true);
  }
});

test("15 - MIN_QUALIFYING_SHUFFLE_COUNT matches Section 9.4's stated minimum of 1,000", () => {
  assert.equal(MIN_QUALIFYING_SHUFFLE_COUNT, 1000);
});
