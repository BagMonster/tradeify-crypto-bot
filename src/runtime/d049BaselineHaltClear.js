import { D049_BASELINE_MISMATCH_HALT_REASON } from "./d049BaselinePolicy.js";

export async function clearLatchedBaselineMismatchHalt(database) {
  if (typeof database?.clearSafetyHaltIfReason !== "function") return false;
  const cleared = await database.clearSafetyHaltIfReason(D049_BASELINE_MISMATCH_HALT_REASON);
  if (cleared && typeof database.addEvent === "function") {
    await database.addEvent("WARN", "SOL_D049_BASELINE_HALT_CLEARED", {
      reason: "mid-day DXtrade day-open wobble is not a book mismatch"
    });
  }
  return cleared === true;
}
