import { createInitialFloorState, updateMll } from "../riskEngine.js";

function requireFiniteNumber(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

/**
 * Section 9.5: "seeded PRNG (mulberry32)." Public-domain reference
 * implementation (Tommy Ettinger), used verbatim rather than reinvented —
 * the whole point of naming a specific PRNG in the contract is that two
 * people running the same seed against the same algorithm get the same
 * numbers. Returns a generator function yielding floats in [0, 1),
 * matching Math.random()'s range so it drops directly into
 * fisherYatesShuffle below. seed must be an integer; it is folded into
 * unsigned 32-bit space with `>>> 0` exactly once, at construction.
 */
export function mulberry32(seed) {
  if (!Number.isInteger(seed)) throw new Error("seed must be an integer");
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates, driven by a caller-supplied `randomFn` rather than
 * Math.random() — Section 9.5's "No Math.random()" applies to every random
 * draw this module makes, not just the top-level seed. Returns a new array
 * (the input is never mutated), consistent with the codebase's immutable
 * style elsewhere in src/research/.
 */
export function fisherYatesShuffle(items, randomFn) {
  if (!Array.isArray(items)) throw new Error("items must be an array");
  if (typeof randomFn !== "function") throw new Error("randomFn must be a function");
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(randomFn() * (i + 1));
    const temp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = temp;
  }
  return shuffled;
}

/**
 * Replays one ordering of closed trades' netPnl against the account's MLL
 * (max-loss-limit) floor only, using riskEngine.js's own
 * createInitialFloorState/updateMll unmodified — the same ratchet
 * production and src/research/accountModel.js already use, so this can
 * never silently drift from the real floor formula.
 *
 * [INTERPRETATION, flagged to the owner]: this deliberately does NOT model
 * Section 9.2's calendar-bound DAILY floor (`prevDayClose -
 * dailyLossLimit`, reset each account day to that day's real closing
 * balance). A Monte Carlo shuffle reorders trades that really happened on
 * specific, real calendar days into a hypothetical sequence that has no
 * calendar at all — there is no principled way to say which "day" a
 * shuffled trade now falls on, so there is no principled way to decide
 * when the daily floor would have reset. Fabricating a reset schedule (one
 * reset per trade, or one per N trades) would invent calendar structure
 * that never existed and could just as easily understate or overstate the
 * real risk. The MLL floor has no such problem: it is a pure function of
 * the cumulative realized-balance high-water mark, well-defined under ANY
 * ordering of the same trades — which is exactly what Section 9.5 is
 * testing ("whether a different ordering of the same trades would have
 * breached the account floor"). The daily floor's real behavior is already
 * fully exercised by the ordinary, single, real-calendar-ordered backtest
 * (src/research/backtestEngine.js's own accountFailure detection, which
 * correctly resets prevDayClose every real 22:00 UTC boundary) — Monte
 * Carlo's job is to add the sequence-risk check that a single realized run
 * cannot: whether a worse-case ordering of the same trades would have
 * breached the floor that persists across the whole run.
 *
 * Matches src/research/backtestEngine.js's real per-trade ordering: update
 * closedBalance and ratchet the MLL floor first (a trade that sets a new
 * high can only ever raise the floor, never breach it — updateMll always
 * places the new floor at least `account.maxLossOffset` below the new
 * high), then check the resulting balance against that just-updated floor,
 * exactly mirroring runBacktest's recordTradeClose-then-checkAccountFailure
 * sequence.
 */
export function replayShuffledSequence(trades, account) {
  if (!Array.isArray(trades)) throw new Error("trades must be an array");
  let floorState = createInitialFloorState(account);
  let closedBalance = requireFiniteNumber("account.startingBalance", account.startingBalance);

  for (let index = 0; index < trades.length; index += 1) {
    const netPnl = requireFiniteNumber(`trades[${index}].netPnl`, trades[index]?.netPnl);
    closedBalance += netPnl;
    floorState = updateMll(closedBalance, floorState, account);
    if (closedBalance <= floorState.mllFloor) {
      return Object.freeze({
        breached: true,
        breachedAtIndex: index,
        closedBalance,
        mllFloor: floorState.mllFloor
      });
    }
  }

  return Object.freeze({
    breached: false,
    breachedAtIndex: null,
    closedBalance,
    mllFloor: floorState.mllFloor
  });
}

/** Section 9.4's stated minimum: "≥ 1,000 shuffled trade-sequence Monte Carlo simulations." */
export const MIN_QUALIFYING_SHUFFLE_COUNT = 1000;

/**
 * Section 9.5: runs `shuffleCount` independent Fisher-Yates reorderings of
 * `trades` from ONE continuous mulberry32(seed) stream (constructed once,
 * advanced across every shuffle — never re-seeded per shuffle, which would
 * make every "shuffle" identical) and replays each ordering via
 * replayShuffledSequence. `shuffleCount` is a caller-supplied parameter,
 * not hardcoded to MIN_QUALIFYING_SHUFFLE_COUNT here, so tests can run a
 * handful of shuffles quickly — enforcing the >= 1,000 qualification
 * threshold is a later step's job (Steps 26.6/26.7), at the point results
 * are actually used to qualify a route.
 *
 * Returns aggregate figures only (seed, shuffleCount, failureCount,
 * zeroFailures) — Section 10's evidence-export schema asks for "Monte
 * Carlo failure count" per route, not a full per-shuffle trace; per-shuffle
 * detail is available by calling replayShuffledSequence directly in a loop
 * if a future step needs it.
 *
 * Determinism (Section 9.5: "Re-running with the same seed reproduces
 * identical results"): calling this twice with the same trades/account/seed
 * always produces byte-identical (JSON.stringify-equal) output, since
 * mulberry32 is a pure deterministic function of its seed and this module
 * makes no other source of randomness or ambient state available to it.
 */
export function runMonteCarlo({ trades, account, seed, shuffleCount }) {
  if (!Array.isArray(trades)) throw new Error("trades must be an array");
  if (!account || typeof account !== "object") throw new Error("account must be an object");
  if (!Number.isInteger(seed)) throw new Error("seed must be an integer");
  if (!Number.isInteger(shuffleCount) || shuffleCount < 1) {
    throw new Error("shuffleCount must be a positive integer");
  }

  const random = mulberry32(seed);
  let failureCount = 0;
  for (let run = 0; run < shuffleCount; run += 1) {
    const shuffled = fisherYatesShuffle(trades, random);
    const outcome = replayShuffledSequence(shuffled, account);
    if (outcome.breached) failureCount += 1;
  }

  return Object.freeze({
    seed,
    shuffleCount,
    failureCount,
    zeroFailures: failureCount === 0
  });
}
