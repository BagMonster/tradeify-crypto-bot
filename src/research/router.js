import { isRegimeTradable, regimeAtDecisionTime } from "./regime.js";
import {
  SIGNAL_STRATEGY_ID as MEAN_REVERSION_STRATEGY_ID,
  evaluateMeanReversion
} from "./strategies/meanReversion.js";
import {
  DONCHIAN_STRATEGY_ID,
  checkDonchianChannelExit,
  evaluateDonchian
} from "./strategies/donchian.js";
import {
  TS_MOMENTUM_STRATEGY_ID,
  checkTsMomentumEmaCrossExit,
  evaluateTsMomentum
} from "./strategies/tsMomentum.js";
import {
  COMPRESSION_BREAKOUT_STRATEGY_ID,
  COMPRESSION_VARIANTS,
  evaluateCompressionBreakout
} from "./strategies/compressionBreakout.js";

export {
  MEAN_REVERSION_STRATEGY_ID,
  DONCHIAN_STRATEGY_ID,
  TS_MOMENTUM_STRATEGY_ID,
  COMPRESSION_BREAKOUT_STRATEGY_ID
};

/**
 * Section 5.3's four slots, by strategyId, in the order Section 3 lists
 * them (1 Donchian, 2 TS momentum, 3 mean reversion, 4 compression
 * breakout).
 */
export const ALL_STRATEGY_IDS = Object.freeze([
  DONCHIAN_STRATEGY_ID,
  TS_MOMENTUM_STRATEGY_ID,
  MEAN_REVERSION_STRATEGY_ID,
  COMPRESSION_BREAKOUT_STRATEGY_ID
]);

/**
 * [INTERPRETATION, flagged to the owner - Step 26.5, provisional]. Section
 * 9.3 says the combined router permits "only the approved winner" when more
 * than one route could control a trade, and Section 9.4 ranks passing
 * routes by "governed net profit after costs -> profit relative to drawdown
 * -> parameter stability -> holdout behaviour." That ranking is a RESULT of
 * route qualification (Steps 26.6/26.7), which has not run yet - there is
 * no qualified ranking for this router to consume today. Until one exists,
 * something deterministic is still required so a backtest is reproducible
 * on the rare bar where more than one enabled strategy confirms a candidate
 * at once. This default order (slot 1 -> 2 -> 3 -> 4, the order Section 3
 * lists the slots in) is a placeholder, not a claim that Donchian is
 * "better" than compression breakout - createSignalRouter's priorityOrder
 * option lets a later step override it with the real qualification ranking
 * once one exists, without editing this file. Only one position may ever be
 * open regardless of which candidate wins; the strategies that did not win
 * are reported back as `shadowCandidates` on that bar's result rather than
 * silently discarded, echoing Section 9.3's "other candidates continue in
 * shadow mode" - though full shadow-mode evidence collection across an
 * entire run is a later step's job, not this one's.
 */
export const DEFAULT_STRATEGY_PRIORITY = ALL_STRATEGY_IDS;

/**
 * Maps a strategyId to its dynamic per-bar exit-check function, in exactly
 * the shape src/research/backtestEngine.js's resolveOpenPosition expects
 * for its `dynamicExitFns` option: ({bars15m, decisionIndex, direction}) =>
 * {exit: boolean}. Slot 3 (mean reversion) and slot 4 (compression
 * breakout) are intentionally absent - both exit only through
 * backtestEngine.js's static bracket (protective stop / target / time stop
 * / hard-flat), per Section 3's exit tables for those two slots.
 */
export const DYNAMIC_EXIT_FNS_BY_STRATEGY_ID = Object.freeze({
  [DONCHIAN_STRATEGY_ID]: checkDonchianChannelExit,
  [TS_MOMENTUM_STRATEGY_ID]: checkTsMomentumEmaCrossExit
});

function requireNonEmptyArray(name, value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty array`);
  }
  return value;
}

/**
 * Accepts either one of COMPRESSION_VARIANTS's frozen objects or a plain
 * `{id: "L10-N20"}` (or bare string id) and resolves it to the canonical
 * frozen variant - never trusts caller-supplied breakoutPeriod/percentile
 * numbers directly, so a typo'd variant fails closed instead of silently
 * running an unintended parameter combination.
 */
function resolveCompressionVariant(compressionVariant) {
  const requestedId = typeof compressionVariant === "string"
    ? compressionVariant
    : compressionVariant?.id;
  const resolved = COMPRESSION_VARIANTS.find((variant) => variant.id === requestedId);
  if (!resolved) {
    throw new Error(
      `compressionVariant must be one of: ${COMPRESSION_VARIANTS.map((variant) => variant.id).join(", ")}`
    );
  }
  return resolved;
}

function noRouteSignal(regimeLabel, reasonCode, reason, extra = {}) {
  return Object.freeze({
    status: "NO_SIGNAL",
    strategyId: null,
    direction: null,
    reasonCode,
    reason,
    regimeLabel,
    ...extra
  });
}

/**
 * Section 5.3 route selection. Builds a single signalFn (and matching
 * dynamicExitFns map) shaped exactly for src/research/backtestEngine.js's
 * runBacktest to call directly - this module owns WHICH strategy or regime
 * a candidate comes from; runBacktest itself stays strategy-agnostic (see
 * its own doc comment, which names router.js as the caller responsible for
 * this assembly).
 *
 * `enabledStrategyIds`: which of ALL_STRATEGY_IDS this router evaluates on
 * every decision bar. Passing a single id reproduces an isolated
 * single-slot backtest (e.g. Step 26.6's fold-by-fold slot 4 variant
 * comparison, or slot-by-slot qualification in Steps 26.6/26.7) through the
 * exact same code path as a full combined run - never a second, divergent
 * execution loop. Passing all four is Section 7's "one open position across
 * the entire router, all strategies, all directions."
 *
 * `compressionVariant`: required, and only meaningful, when
 * COMPRESSION_BREAKOUT_STRATEGY_ID is in enabledStrategyIds - one of
 * COMPRESSION_VARIANTS, by object or by id string. Slot 4's variant has not
 * been selected yet (Section 6.2's freeze order makes that Step 26.6's
 * job), so this router evaluates whichever single variant the caller
 * supplies for that one run - never more than one at a time, since only one
 * variant can ever be "live" for slot 4.
 *
 * `regimeTimeline`: the Section 5 daily regime label timeline, as produced
 * by regime.js's calculateDailyRegimeTimeline. A decision bar whose regime
 * is null (still inside the D-013 burn-in), EXCLUDED_VOL, or TRANSITIONAL
 * produces NO_SIGNAL before any strategy is evaluated at all - Section
 * 5.2's global no-trade guards are checked ahead of, and independently of,
 * every per-strategy signal.
 *
 * `priorityOrder`: see DEFAULT_STRATEGY_PRIORITY's doc comment above - the
 * deterministic tie-break used on the rare bar where more than one enabled
 * strategy produces a CANDIDATE at once. Must supply a rank for every id in
 * enabledStrategyIds (it may omit ids that are not enabled).
 */
export function createSignalRouter({
  regimeTimeline,
  enabledStrategyIds,
  compressionVariant = null,
  priorityOrder = DEFAULT_STRATEGY_PRIORITY
} = {}) {
  requireNonEmptyArray("regimeTimeline", regimeTimeline);
  requireNonEmptyArray("enabledStrategyIds", enabledStrategyIds);
  requireNonEmptyArray("priorityOrder", priorityOrder);

  if (new Set(enabledStrategyIds).size !== enabledStrategyIds.length) {
    throw new Error("enabledStrategyIds must not contain duplicates");
  }
  for (const id of enabledStrategyIds) {
    if (!ALL_STRATEGY_IDS.includes(id)) {
      throw new Error(`enabledStrategyIds contains an unknown strategyId: ${id}`);
    }
  }
  for (const id of enabledStrategyIds) {
    if (!priorityOrder.includes(id)) {
      throw new Error(`priorityOrder must rank every enabled strategy (missing ${id})`);
    }
  }

  const resolvedVariant = enabledStrategyIds.includes(COMPRESSION_BREAKOUT_STRATEGY_ID)
    ? resolveCompressionVariant(compressionVariant)
    : null;

  function evaluateEnabledStrategies({ bars15m, bars4h, bars1d, decisionIndex, strategy }) {
    const candidates = [];
    if (enabledStrategyIds.includes(DONCHIAN_STRATEGY_ID)) {
      candidates.push(evaluateDonchian({ bars15m, decisionIndex, strategy }));
    }
    if (enabledStrategyIds.includes(TS_MOMENTUM_STRATEGY_ID)) {
      candidates.push(evaluateTsMomentum({ bars15m, decisionIndex, strategy }));
    }
    if (enabledStrategyIds.includes(MEAN_REVERSION_STRATEGY_ID)) {
      candidates.push(evaluateMeanReversion({ bars15m, bars4h, bars1d, decisionIndex, strategy }));
    }
    if (enabledStrategyIds.includes(COMPRESSION_BREAKOUT_STRATEGY_ID)) {
      candidates.push(evaluateCompressionBreakout({
        bars15m,
        decisionIndex,
        strategy,
        variant: resolvedVariant
      }));
    }
    return candidates;
  }

  /**
   * signalFn, matching src/research/backtestEngine.js's runBacktest
   * contract exactly: ({bars15m, bars4h, bars1d, decisionIndex, strategy})
   * => an evaluateSignal-shaped result. decisionIndex must be an integer
   * >= 1 with a prior bar - the same requirement every wrapped evaluate*
   * function already enforces on its own, so that check is not duplicated
   * here; the first wrapped call's own thrown error surfaces unmodified.
   */
  function signalFn({ bars15m, bars4h, bars1d, decisionIndex, strategy }) {
    const decisionBar = bars15m[decisionIndex];
    const regimeEntry = regimeAtDecisionTime(regimeTimeline, decisionBar.closeTime);
    const regimeLabel = regimeEntry ? regimeEntry.label : null;

    if (regimeLabel === null) {
      return noRouteSignal(
        null,
        "REGIME_BURN_IN",
        "No regime label exists yet at or before this decision time"
      );
    }
    if (!isRegimeTradable(regimeLabel)) {
      return noRouteSignal(
        regimeLabel,
        "REGIME_NOT_TRADABLE",
        `${regimeLabel} permits no route (Section 5.2)`
      );
    }

    const candidates = evaluateEnabledStrategies({ bars15m, bars4h, bars1d, decisionIndex, strategy });
    const firing = candidates.filter((candidate) => candidate.status === "CANDIDATE");
    if (firing.length === 0) {
      return noRouteSignal(
        regimeLabel,
        "NO_QUALIFYING_SETUP",
        "No enabled strategy produced a candidate on this bar"
      );
    }

    const ranked = [...firing].sort(
      (a, b) => priorityOrder.indexOf(a.strategyId) - priorityOrder.indexOf(b.strategyId)
    );
    const winner = ranked[0];
    const shadowed = ranked.slice(1).map((candidate) => Object.freeze({
      strategyId: candidate.strategyId,
      direction: candidate.direction
    }));

    return Object.freeze({
      ...winner,
      // Section 5.3: the route's regime label is research's daily-bar
      // taxonomy (regime.js), never a strategy's own internal regime check
      // (e.g. mean reversion's production ADX4h/ATR1d gate inside
      // evaluateSignal, preserved below under productionSignalRegime for
      // slot 3 candidates only - it is a different, narrower check that
      // evaluateMeanReversion runs unmodified and independently). This
      // `regime.classification` field is what
      // src/research/backtestEngine.js's tryEnter reads via
      // `candidate.regime?.classification` to set position.regimeLabel -
      // the value metrics.js's per-route breakdown (Section 9.4) depends
      // on, and one leg of regime.js's routeId() triple.
      regime: Object.freeze({ classification: regimeLabel }),
      routeRegimeLabel: regimeLabel,
      ...(winner.regime ? { productionSignalRegime: winner.regime } : {}),
      ...(shadowed.length > 0 ? { shadowCandidates: Object.freeze(shadowed) } : {})
    });
  }

  const dynamicExitFns = {};
  for (const id of enabledStrategyIds) {
    if (DYNAMIC_EXIT_FNS_BY_STRATEGY_ID[id]) {
      dynamicExitFns[id] = DYNAMIC_EXIT_FNS_BY_STRATEGY_ID[id];
    }
  }

  return Object.freeze({
    signalFn,
    dynamicExitFns: Object.freeze(dynamicExitFns),
    enabledStrategyIds: Object.freeze([...enabledStrategyIds]),
    priorityOrder: Object.freeze([...priorityOrder]),
    compressionVariant: resolvedVariant
  });
}
