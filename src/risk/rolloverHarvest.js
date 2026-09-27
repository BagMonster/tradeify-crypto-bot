import { realizedPnlUsd } from "./dailyDustCleanup.js";

function positive(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`${name} must be positive`);
  return n;
}

function fixed8(value) {
  return Number(Number(value).toFixed(8));
}

function floorToStep(value, step) {
  return fixed8(Math.floor((value + 1e-10) / step) * step);
}

/**
 * Builds the single account-day, profit-only rollover plan approved by the
 * owner. It sums profit across every open broker ticket in the account—never
 * per coin—then allocates that single $33 target proportionally. Candidate
 * collection is broker-first, so grid, manual, adopted, and current-day
 * inventory are all part of the same account-wide calculation.
 */
export function buildProportionalRolloverHarvestPlan({ thresholdUsd, candidates }) {
  const threshold = positive("rollover harvest threshold", thresholdUsd);
  if (!Array.isArray(candidates)) throw new TypeError("rollover harvest candidates are required");

  // Eligibility is account-wide: losses remain in this collection so a group
  // of winners cannot trigger a rollover harvest while the account as a whole
  // is below the configured profit threshold.  Only the profitable subset is
  // used later to distribute a harvest that has already qualified.
  const positions = candidates.map((candidate) => {
    if (!candidate || typeof candidate !== "object") throw new TypeError("rollover harvest candidate is invalid");
    if (typeof candidate.instrument !== "string" || candidate.instrument.trim() === "") throw new TypeError("rollover harvest candidate instrument is invalid");
    if (typeof candidate.lotId !== "string" || candidate.lotId.trim() === "") throw new TypeError("rollover harvest candidate lotId is invalid");
    if (typeof candidate.positionCode !== "string" || candidate.positionCode.trim() === "") throw new TypeError("rollover harvest candidate requires an exact positionCode");
    if (candidate.virtualSide !== "BUY" && candidate.virtualSide !== "SELL") throw new TypeError("rollover harvest candidate side is invalid");
    const entryPrice = positive("rollover harvest candidate entryPrice", candidate.entryPrice);
    const markPrice = positive("rollover harvest candidate markPrice", candidate.markPrice);
    const remainingUnits = positive("rollover harvest candidate remainingUnits", candidate.remainingUnits);
    const lotStep = positive("rollover harvest candidate lotStep", candidate.lotStep);
    const unrealisedPnlUsd = realizedPnlUsd({ virtualSide: candidate.virtualSide, entryPrice, fillPrice: markPrice, quantity: remainingUnits });
    return Object.freeze({
      instrument: candidate.instrument,
      lotId: candidate.lotId,
      ringTag: candidate.ringTag ?? null,
      positionCode: candidate.positionCode,
      virtualSide: candidate.virtualSide,
      entryPrice,
      markPrice,
      remainingUnits,
      lotStep,
      unrealisedPnlUsd,
      profitPerUnitUsd: unrealisedPnlUsd / remainingUnits
    });
  });

  const eligible = positions.filter((candidate) => candidate.unrealisedPnlUsd > 1e-8);
  const totalUnrealisedPnlUsd = fixed8(positions.reduce((sum, candidate) => sum + candidate.unrealisedPnlUsd, 0));
  const totalProfitablePnlUsd = fixed8(eligible.reduce((sum, candidate) => sum + candidate.unrealisedPnlUsd, 0));

  if (totalUnrealisedPnlUsd + 1e-8 < threshold) {
    return Object.freeze({
      positions: Object.freeze(positions),
      eligible: Object.freeze(eligible),
      totalUnrealisedPnlUsd,
      totalProfitablePnlUsd,
      targetUsd: threshold,
      allocations: Object.freeze([])
    });
  }

  const allocations = eligible.map((candidate) => {
    const targetProfitUsd = threshold * (candidate.unrealisedPnlUsd / totalProfitablePnlUsd);
    const quantity = Math.min(candidate.remainingUnits, floorToStep(targetProfitUsd / candidate.profitPerUnitUsd, candidate.lotStep));
    return { ...candidate, targetProfitUsd, quantity, estimatedProfitUsd: fixed8(quantity * candidate.profitPerUnitUsd) };
  });

  // Lot steps can leave a small unallocated remainder. Give each next increment
  // to the position furthest below its ideal proportional share, never allowing
  // the planned profit to exceed the $33 target.
  let plannedUsd = fixed8(allocations.reduce((sum, candidate) => sum + candidate.estimatedProfitUsd, 0));
  while (plannedUsd < threshold - 1e-8) {
    const next = allocations
      .filter((candidate) => candidate.quantity + candidate.lotStep <= candidate.remainingUnits + 1e-8)
      .filter((candidate) => plannedUsd + candidate.lotStep * candidate.profitPerUnitUsd <= threshold + 1e-8)
      .sort((a, b) => {
        const aGap = a.targetProfitUsd - a.estimatedProfitUsd;
        const bGap = b.targetProfitUsd - b.estimatedProfitUsd;
        if (Math.abs(bGap - aGap) > 1e-10) return bGap - aGap;
        return `${a.instrument}:${a.lotId}`.localeCompare(`${b.instrument}:${b.lotId}`);
      })[0];
    if (!next) break;
    next.quantity = fixed8(next.quantity + next.lotStep);
    next.estimatedProfitUsd = fixed8(next.quantity * next.profitPerUnitUsd);
    plannedUsd = fixed8(allocations.reduce((sum, candidate) => sum + candidate.estimatedProfitUsd, 0));
  }

  return Object.freeze({
    positions: Object.freeze(positions),
    eligible: Object.freeze(eligible),
    totalUnrealisedPnlUsd,
    totalProfitablePnlUsd,
    targetUsd: threshold,
    plannedUsd,
    allocations: Object.freeze(allocations
      .filter((candidate) => candidate.quantity >= candidate.lotStep - 1e-8)
      .map((candidate) => Object.freeze({
        instrument: candidate.instrument,
        lotId: candidate.lotId,
        ringTag: candidate.ringTag,
        positionCode: candidate.positionCode,
        virtualSide: candidate.virtualSide,
        entryPrice: candidate.entryPrice,
        remainingUnits: candidate.remainingUnits,
        quantity: candidate.quantity,
        estimatedProfitUsd: candidate.estimatedProfitUsd
      })))
  });
}
