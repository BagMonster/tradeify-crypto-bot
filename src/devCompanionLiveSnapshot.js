const SNAPSHOT_VERSION = 1;
const RECONCILE_EPSILON = 0.0050001;
const STALE_AFTER_MS = 120_000;

function finiteOrNull(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function bool(value) {
  return value === true;
}

function textOrNull(value, max = 180) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.slice(0, max);
}

function isoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function tags(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((tag) => typeof tag === "string" && /^[A-Z]{3,6}\d{1,2}$/.test(tag.trim()))
    .map((tag) => tag.trim())
    .slice(0, 20);
}

export function sanitizeLiveSnapshot(input = {}, { now = Date.now() } = {}) {
  const virtualNetUnits = finiteOrNull(input.virtualNetUnits);
  const brokerNetUnits = finiteOrNull(input.brokerNetUnits);
  const capturedAt = isoOrNull(input.capturedAt) ?? new Date(now).toISOString();
  const mismatch = virtualNetUnits != null
    && brokerNetUnits != null
    && Math.abs(virtualNetUnits - brokerNetUnits) > RECONCILE_EPSILON;

  return Object.freeze({
    version: SNAPSHOT_VERSION,
    capturedAt,
    binancePrice: finiteOrNull(input.binancePrice),
    binanceTradeAt: isoOrNull(input.binanceTradeAt),
    feedStale: bool(input.feedStale),
    ma: finiteOrNull(input.ma),
    maCompletedThrough: textOrNull(input.maCompletedThrough, 32),
    virtualNetUnits,
    openLots: Number.isInteger(input.openLots) && input.openLots >= 0 ? input.openLots : 0,
    occupiedRings: tags(input.occupiedRings),
    armedRings: Number.isInteger(input.armedRings) && input.armedRings >= 0 ? input.armedRings : 0,
    ringCount: Number.isInteger(input.ringCount) && input.ringCount > 0 ? input.ringCount : 20,
    lastFillSide: input.lastFillSide === "BUY" || input.lastFillSide === "SELL" ? input.lastFillSide : null,
    lastFillPrice: finiteOrNull(input.lastFillPrice),
    lastFillAt: isoOrNull(input.lastFillAt),
    brokerOpen: bool(input.brokerOpen),
    brokerNetUnits,
    accountFresh: bool(input.accountFresh),
    accountLocked: bool(input.accountLocked),
    operatorPaused: bool(input.operatorPaused),
    safetyHalt: bool(input.safetyHalt),
    haltReason: textOrNull(input.haltReason, 180),
    executionEnabled: bool(input.executionEnabled),
    ladder: Object.freeze({
      dayKey: textOrNull(input.ladder?.dayKey, 16),
      brakeEngaged: bool(input.ladder?.brakeEngaged),
      partialCutDone: bool(input.ladder?.partialCutDone),
      flattenDone: bool(input.ladder?.flattenDone),
      haltedForDay: bool(input.ladder?.haltedForDay)
    }),
    mismatch
  });
}

export function snapshotAgeMs(snapshot, now = Date.now()) {
  const captured = Date.parse(snapshot?.capturedAt ?? "");
  if (!Number.isFinite(captured)) return Infinity;
  return Math.max(0, now - captured);
}

export function isLiveSnapshotStale(snapshot, now = Date.now()) {
  return !snapshot || snapshotAgeMs(snapshot, now) > STALE_AFTER_MS;
}

export function diagnoseLiveSnapshot(snapshot, now = Date.now()) {
  if (!snapshot) return ["LIVE BODY SNAPSHOT: missing. Run /status after the trading worker publishes one."];
  const lines = [];
  if (isLiveSnapshotStale(snapshot, now)) {
    lines.push(`LIVE BODY SNAPSHOT is stale (${Math.round(snapshotAgeMs(snapshot, now) / 1000)}s old). Prefer a fresh /status.`);
  }
  if (snapshot.safetyHalt) {
    lines.push(`Safety halt is ACTIVE${snapshot.haltReason ? `: ${snapshot.haltReason}` : "."}`);
  }
  if (snapshot.operatorPaused) lines.push("Operator pause is ACTIVE. Grid entries stay blocked until /resume.");
  if (snapshot.accountLocked) lines.push("Account lock is ACTIVE. New SOL actions are blocked.");
  if (snapshot.mismatch) {
    const virtual = snapshot.virtualNetUnits == null ? "?" : snapshot.virtualNetUnits.toFixed(2);
    const broker = snapshot.brokerNetUnits == null ? "?" : snapshot.brokerNetUnits.toFixed(2);
    const next = snapshot.brokerOpen
      ? "Flatten the broker first, then /status."
      : "Use /reconcile, then /confirmreconcile. Do not /resume until the books match.";
    lines.push(`Virtual/broker mismatch: virtual ${virtual} SOL vs broker ${broker} SOL. ${next}`);
  }
  if (snapshot.ladder?.haltedForDay) lines.push("D-049 ladder flatten halt is ACTIVE until the next 22:00 UTC rollover.");
  else if (snapshot.ladder?.brakeEngaged) lines.push("D-049 entry brake is ACTIVE.");
  return lines;
}

function moneyOrNa(value, digits = 2) {
  if (!Number.isFinite(value)) return "n/a";
  return value.toFixed(digits);
}

export function formatLiveSnapshot(snapshot, now = Date.now()) {
  const diagnosis = diagnoseLiveSnapshot(snapshot, now);
  if (!snapshot) {
    return ["LIVE BODY SNAPSHOT", "", ...diagnosis].join("\n");
  }
  const occupied = snapshot.occupiedRings.length ? snapshot.occupiedRings.join(", ") : "none";
  const lastFill = snapshot.lastFillAt
    ? `${snapshot.lastFillSide ?? "?"} @ ${moneyOrNa(snapshot.lastFillPrice, 4)} (${snapshot.lastFillAt})`
    : "none";
  const lines = [
    "LIVE BODY SNAPSHOT",
    `Captured: ${snapshot.capturedAt}${isLiveSnapshotStale(snapshot, now) ? " (STALE)" : ""}`,
    `Binance SOLUSDT: ${moneyOrNa(snapshot.binancePrice, 4)} at ${snapshot.binanceTradeAt ?? "n/a"}`,
    `Feed stale: ${snapshot.feedStale ? "YES" : "NO"}`,
    `200-day MA: ${moneyOrNa(snapshot.ma, 4)} through ${snapshot.maCompletedThrough ?? "n/a"}`,
    `Virtual net: ${moneyOrNa(snapshot.virtualNetUnits, 2)} SOL`,
    `Open virtual lots: ${snapshot.openLots}`,
    `Occupied rings: ${occupied}`,
    `Armed rings: ${snapshot.armedRings}/${snapshot.ringCount}`,
    `Last confirmed fill: ${lastFill}`,
    `Broker SOL open: ${snapshot.brokerOpen ? "YES" : "NO"}`,
    `Broker net: ${moneyOrNa(snapshot.brokerNetUnits, 2)} SOL`,
    `Account data fresh: ${snapshot.accountFresh ? "YES" : "NO"}`,
    `Account locked: ${snapshot.accountLocked ? "YES" : "NO"}`,
    `Operator pause: ${snapshot.operatorPaused ? "ACTIVE" : "OFF"}`,
    `Safety halt: ${snapshot.safetyHalt ? "ACTIVE" : "OFF"}`,
    snapshot.haltReason ? `Halt reason: ${snapshot.haltReason}` : null,
    `Auto-execution: ${snapshot.executionEnabled ? "ON" : "OFF"}`,
    `Books match: ${snapshot.mismatch ? "NO" : "YES"}`,
    `D-049 ladder: brake=${snapshot.ladder.brakeEngaged ? "ON" : "off"} cut=${snapshot.ladder.partialCutDone ? "DONE" : "ready"} flatten=${snapshot.ladder.flattenDone ? "DONE" : "ready"} dayHalt=${snapshot.ladder.haltedForDay ? "YES" : "NO"}`
  ].filter((line) => line != null);

  if (diagnosis.length) {
    lines.push("", "DIAGNOSIS", ...diagnosis.map((line) => `- ${line}`));
  }
  return lines.join("\n");
}

export const LIVE_SNAPSHOT_STALE_AFTER_MS = STALE_AFTER_MS;
export const LIVE_SNAPSHOT_VERSION = SNAPSHOT_VERSION;
