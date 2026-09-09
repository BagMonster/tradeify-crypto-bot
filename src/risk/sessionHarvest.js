/**
 * D-064 session harvest predicate + process-wide tranche-exit pause.
 *
 * The pause registry is keyed by instrument so ringGridInstance.process can
 * honor harvest without the D-060 wrapper exposing setTrancheExitsPaused.
 */
const pausedInstruments = new Set();

export function setTrancheExitsPausedFor(instrument, on) {
  const key = typeof instrument === "string" ? instrument : "";
  if (!key) return;
  if (on === true) pausedInstruments.add(key);
  else pausedInstruments.delete(key);
}

export function setTrancheExitsPausedAll(instruments, on) {
  if (!Array.isArray(instruments)) return;
  for (const instrument of instruments) setTrancheExitsPausedFor(instrument, on);
}

export function isTrancheExitsPaused(instrument) {
  return pausedInstruments.has(instrument);
}

export function shouldHarvest({
  enabled,
  thresholdUsd,
  flattenedToday,
  harvestedToday,
  combinedDayPnlUsd,
  readings
}) {
  if (enabled !== true) return false;
  if (flattenedToday === true || harvestedToday === true) return false;
  const threshold = Number(thresholdUsd);
  const combined = Number(combinedDayPnlUsd);
  if (!Number.isFinite(threshold) || threshold <= 0) return false;
  if (!Number.isFinite(combined) || combined < threshold) return false;
  if (!Array.isArray(readings) || readings.length === 0) return false;
  return readings.some((row) => Math.abs(Number(row?.exposureUsd) || 0) > 1e-8);
}

export function harvestReason(combinedDayPnlUsd, thresholdUsd) {
  const combined = Number(combinedDayPnlUsd);
  const threshold = Number(thresholdUsd);
  const combinedText = Number.isFinite(combined) ? combined.toFixed(2) : "unknown";
  const thresholdText = Number.isFinite(threshold) ? threshold.toFixed(2) : "unknown";
  return `D-064 SESSION_HARVEST at ${combinedText} (threshold +${thresholdText})`;
}
