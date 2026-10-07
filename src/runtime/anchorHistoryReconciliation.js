// Audit-only recovery of saved state whose original shift history is missing.
// No broker orders, runtime mutations or anchor-state writes are exposed here.
export function createAnchorHistoryReconciliation({ persistence, books, accountMonitor, coordinator, isExecutionEnabled, now = () => Date.now() }) {
  let busy = false;
  function safe() {
    const status = accountMonitor.getSnapshot();
    const s = status.snapshot;
    const recovery = coordinator.getSnapshot();
    return isExecutionEnabled() === false && status.healthy === true &&
      typeof s?.fetchedAtMs === "number" && s.fetchedAtMs <= now() && now() - s.fetchedAtMs <= 6_000 &&
      s.accountLocked !== true && s.positionsReadFailed !== true && s.signedNetReadOk === true &&
      Number(s.openPositionsCount) === 0 && recovery.pending !== true && !recovery.failure &&
      books.every((b) => b.hasVirtualLots() === false && b.hasOrderInFlight() === false);
  }
  async function run(confirm = false) {
    if (busy) return "Anchor history reconciliation is already in progress.";
    busy = true;
    try {
      const gaps = await persistence.inspectAnchorHistoryGaps(books.map((b) => b.instrument));
      if (!gaps.length) return "ANCHOR HISTORY RECONCILIATION\nNo saved anchors are missing audit history. No anchor changed.";
      const lines = gaps.map((g) => `${g.instrument}: saved multiplier ×${g.savedMultiplier}, shift timestamp ${g.shiftedAt}`);
      if (!confirm) return ["ANCHOR HISTORY RECONCILIATION — PREVIEW", ...lines,
        "Original side, extreme, MA and old multiplier are unavailable and will remain unknown.",
        "To record this saved-state evidence only: /anchorreconcile CONFIRM", "No anchor changed."].join("\n");
      await accountMonitor.pollOnce();
      const unchanged = () => gaps.every((g) => {
        const state = books.find((b) => b.instrument === g.instrument).getAnchorState();
        return state?.lastShiftAt === g.shiftedAt && state?.multiplier === Number(g.savedMultiplier);
      });
      const validateSafe = () => safe() && unchanged();
      if (!validateSafe()) return "ANCHOR HISTORY RECONCILIATION REFUSED\nExecution must be OFF, the account freshly broker-flat and virtual-flat, no orders in flight or anchor recovery active, and runtime anchors must match saved state. No audit records or anchors changed.";
      const recorded = await persistence.reconcileAnchorHistory(gaps, validateSafe);
      return ["ANCHOR HISTORY RECONCILED", ...recorded.map((g) => `${g.instrument}: saved state recorded at ${g.shiftedAt}.`),
        "Entries are labeled RECONCILED SAVED STATE; original shift details remain unknown.",
        "Anchors, excursions, execution and entry holds are unchanged. Pending excursions require separate recovery."].join("\n");
    } catch {
      return "ANCHOR HISTORY RECONCILIATION FAILED\nPersistence or verification failed. No anchor was changed. Audit commit outcome may be uncertain; inspect /anchorreconcile and /anchorhistory before retrying. No automatic retry.";
    } finally { busy = false; }
  }
  return Object.freeze({ run });
}
