import { GRID_DEFINITION } from "./strategies/solanaGrid.js";
import { describeVirtualBook } from "./state/solanaReconcile.js";
import { sanitizeLiveSnapshot } from "./devCompanionLiveSnapshot.js";

export async function captureSolanaLiveSnapshot({
  database,
  persistence,
  maProvider,
  execution,
  getLiveMarketSnapshot = () => null,
  getAccountStatus = () => ({ snapshot: null, fresh: false }),
  saveLiveSnapshot = null
}) {
  const [botState, gridState, maState, ladder, market, accountStatus] = await Promise.all([
    database.getState(),
    persistence.state.load(),
    maProvider.getCurrent(),
    typeof persistence?.getLatestRiskLadderState === "function" ? persistence.getLatestRiskLadderState() : null,
    Promise.resolve(getLiveMarketSnapshot()),
    Promise.resolve(getAccountStatus())
  ]);
  const book = gridState ? describeVirtualBook(gridState) : { netUnits: 0, openLots: 0, occupiedRings: [] };
  const brokerQty = accountStatus?.snapshot?.instrumentPosition?.quantity;
  const snapshot = sanitizeLiveSnapshot({
    capturedAt: new Date().toISOString(),
    binancePrice: market?.price,
    binanceTradeAt: market?.tradeTime,
    feedStale: botState.feed_stale === true || market?.stale === true,
    ma: maState?.ma,
    maCompletedThrough: maState?.completedThrough,
    virtualNetUnits: book.netUnits,
    openLots: book.openLots,
    occupiedRings: book.occupiedRings,
    armedRings: gridState?.rings.filter((ring) => ring.armed).length ?? 0,
    ringCount: GRID_DEFINITION.activeLevelsPerSide * 2,
    lastFillSide: gridState?.lastFillSide,
    lastFillPrice: gridState?.lastFillPrice,
    lastFillAt: gridState?.lastFillAt,
    brokerOpen: botState.has_open_position === true,
    brokerNetUnits: Number.isFinite(Number(brokerQty)) ? Number(brokerQty) : (botState.has_open_position ? null : 0),
    accountFresh: accountStatus?.fresh === true,
    accountLocked: accountStatus?.snapshot?.accountLocked === true,
    operatorPaused: botState.operator_killed === true,
    safetyHalt: botState.safety_halt === true,
    haltReason: botState.halt_reason,
    executionEnabled: execution.isEnabled() === true,
    ladder: {
      dayKey: ladder?.dayKey,
      brakeEngaged: ladder?.brakeEngaged,
      partialCutDone: ladder?.partialCutDone,
      flattenDone: ladder?.flattenDone,
      haltedForDay: ladder?.haltedForDay
    }
  });
  if (typeof saveLiveSnapshot === "function") {
    await saveLiveSnapshot(snapshot);
  }
  return snapshot;
}
