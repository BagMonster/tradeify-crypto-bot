import { createSolanaTradeifyService } from "./solanaTradeifyService.js";
import { createRematchHandlers } from "./state/solanaRematch.js";

export function brokerSnapshotLines(accountMonitor) {
  const status = accountMonitor?.getSnapshot?.() ?? null;
  const snapshot = status?.snapshot ?? null;
  const failed = snapshot?.positionsReadFailed === true;
  const net = !failed && Number.isFinite(snapshot?.signedNetUnits) ? snapshot.signedNetUnits : null;
  const source = failed
    ? "unavailable (positions read failed)"
    : (snapshot?.positionSource ?? (snapshot ? "metrics" : "no-snapshot"));
  const freshness = status == null
    ? "unavailable"
    : status.healthy === true
      ? "YES"
      : status.fresh === true
        ? "NO (unhealthy)"
        : "NO";
  const age = Number.isFinite(status?.ageMs) && status.ageMs !== Infinity
    ? ` (${Math.round(status.ageMs)}ms)`
    : snapshot == null
      ? " (monitor has not published a snapshot)"
      : "";
  const lines = [
    `DXtrade broker net SOL: ${net == null ? "unavailable" : net.toFixed(2)}`,
    `DXtrade net source: ${source}`,
    `DXtrade account data fresh: ${freshness}${age}`
  ];
  if (snapshot?.overlayError) lines.push(`DXtrade positions overlay: ${snapshot.overlayError}`);
  if (status?.error) lines.push(`DXtrade monitor error: ${status.error}`);
  return lines;
}

export function createSolanaOwnerService(opts) {
  const tradeify = createSolanaTradeifyService(opts);
  async function refreshBrokerSnapshot() {
    if (typeof opts.accountMonitor?.pollOnce === "function") {
      try {
        await opts.accountMonitor.pollOnce();
      } catch {
        // /status still prints the last known monitor state
      }
    }
  }
  async function statusText() {
    await refreshBrokerSnapshot();
    const base = await tradeify.statusText();
    return `${base}\n${brokerSnapshotLines(opts.accountMonitor).join("\n")}`;
  }
  async function healthText() {
    await refreshBrokerSnapshot();
    const base = await tradeify.healthText();
    return `${base}\n${brokerSnapshotLines(opts.accountMonitor).join("\n")}`;
  }
  return Object.freeze({
    ...tradeify,
    ...createRematchHandlers(opts),
    statusText,
    healthText
  });
}
