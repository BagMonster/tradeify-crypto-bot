import { createSolanaTradeifyService } from "./solanaTradeifyService.js";
import { createRematchHandlers } from "./state/solanaRematch.js";

export function brokerSnapshotLines(accountMonitor) {
  const status = accountMonitor?.getSnapshot?.() ?? null;
  const snapshot = status?.snapshot ?? null;
  const failed = snapshot?.positionsReadFailed === true;
  const net = !failed && Number.isFinite(snapshot?.signedNetUnits) ? snapshot.signedNetUnits : null;
  const source = failed
    ? "unavailable (positions read failed)"
    : (snapshot?.positionSource ?? "unavailable");
  const freshness = status == null
    ? "unavailable"
    : status.healthy === true
      ? "YES"
      : status.fresh === true
        ? "NO (unhealthy)"
        : "NO";
  const age = Number.isFinite(status?.ageMs) && status.ageMs !== Infinity
    ? ` (${Math.round(status.ageMs)}ms)`
    : "";
  return [
    `DXtrade broker net SOL: ${net == null ? "unavailable" : net.toFixed(2)}`,
    `DXtrade net source: ${source}`,
    `DXtrade account data fresh: ${freshness}${age}`
  ];
}

export function createSolanaOwnerService(opts) {
  const tradeify = createSolanaTradeifyService(opts);
  async function statusText() {
    const base = await tradeify.statusText();
    return `${base}\n${brokerSnapshotLines(opts.accountMonitor).join("\n")}`;
  }
  return Object.freeze({
    ...tradeify,
    ...createRematchHandlers(opts),
    statusText
  });
}
