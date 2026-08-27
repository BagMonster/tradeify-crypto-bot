import { evaluateGridRisk } from "../risk/accountRules.js";
import {
  LADDER_ACTIONS,
  accountDayKey,
  createInitialLadderState,
  evaluateRiskLadder,
  markFlattenDone,
  markPartialCutDone,
  normalizeLadderState,
  rollAccountDay,
  withLadderObservation
} from "../risk/dailyRiskLadder.js";
import {
  GRID_DEFINITION,
  applyConfirmedEntry,
  applyConfirmedExit,
  applyConfirmedProtectiveCut,
  applySkippedExit,
  buildProtectiveCutPlan,
  createInitialSolanaState,
  entryCandidates,
  expectedNetUnits,
  grossVirtualExposureUsd,
  nextExitAction,
  normalizeSolanaState,
  observeRearm,
  resetAfterProtectiveFlatten
} from "../strategies/solanaGrid.js";

function positive(name, value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`${name} must be positive`);
  return n;
}
