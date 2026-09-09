/**
 * D-064 session harvest predicate.
 *
 * Separated so the quota flatten cannot be confused with D-063 risk flatten.
 * This module does not place orders. The supervisor calls executeProtectiveFlatten
 * when this returns true, without setting flattenedToday or entry brakes.
 */
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
