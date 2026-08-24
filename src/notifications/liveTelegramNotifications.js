const KINDS = new Set([
  "ENTRY_CONFIRMED",
  "TRANCHE_EXIT_CONFIRMED",
  "LOT_CLOSED",
  "HEARTBEAT_CONFIRMED",
  "RECONCILIATION_MISMATCH",
  "ACCOUNT_LOCKOUT",
  "SAFETY_HALT",
  "PROTECTIVE_FLATTEN_CONFIRMED"
]);

const PROTECTIVE_REASONS = new Set([
  "Maximum-loss floor reached",
  "Daily-loss floor reached"
]);

const ACCOUNT_LOCK_REASONS = new Set([
  "FOREIGN_POSITION",
  "MULTIPLE_POSITIONS",
  "POSITION_COUNT_MISMATCH"
]);

const SAFETY_HALT_REASONS = new Set([
  "SOL_RUNTIME_ERROR"
]);

function finite(name, value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new TypeError(`${name} must be finite`);
  return n;
}

function positive(name, value) {
  const n = finite(name, value);
  if (n <= 0) throw new TypeError(`${name} must be positive`);
  return n;
}

function nonNegative(name, value) {
  const n = finite(name, value);
  if (n < 0) throw new TypeError(`${name} must be non-negative`);
  return n;
}

function safeText(name, value, { max = 96, pattern = /^[A-Za-z0-9_.:/+-]+$/ } = {}) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be non-empty`);
  const out = value.trim();
  if (out.length > max || !pattern.test(out)) throw new TypeError(`${name} is invalid`);
  return out;
}

function canonicalUtc(name, value) {
  if (typeof value !== "string") throw new TypeError(`${name} must be a canonical UTC timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) throw new TypeError(`${name} must be a canonical UTC timestamp`);
  return value;
}

function money(value) {
  return `$${finite("money", value).toFixed(2)}`;
}

function quantity(value) {
  const n = nonNegative("quantity", value);
  return `${Number(n.toFixed(8))} SOL`;
}

function timestamp(value) {
  return canonicalUtc("timestamp", value).replace("T", " ").replace(".000Z", "Z");
}

function formatEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("notification event must be an object");
  const kind = safeText("kind", event.kind, { max: 48, pattern: /^[A-Z_]+$/ });
  if (!KINDS.has(kind)) throw new TypeError("notification kind is unsupported");
  const eventKey = safeText("eventKey", event.eventKey, { max: 160, pattern: /^[A-Za-z0-9_.:-]+$/ });

  if (kind === "ENTRY_CONFIRMED") {
    const side = safeText("side", event.side, { max: 4, pattern: /^(BUY|SELL)$/ });
    const ringTag = safeText("ringTag", event.ringTag, { max: 16, pattern: /^(BUY|SELL)[1-8]$/ });
    const lotId = safeText("lotId", event.lotId, { max: 64 });
    const fillPrice = positive("fillPrice", event.fillPrice);
    const filledQuantity = positive("filledQuantity", event.filledQuantity);
    const ma = positive("ma", event.ma);
    const filledAt = canonicalUtc("filledAt", event.filledAt);
    return {
      kind,
      eventKey,
      message: [
        "🟢 SOL ENTRY CONFIRMED",
        `Ring: ${ringTag}`,
        `Side: ${side}`,
        `Fill: ${money(fillPrice)}`,
        `Quantity: ${quantity(filledQuantity)}`,
        `Virtual lot: ${lotId}`,
        `Current 200-day MA: ${money(ma)}`,
        `Confirmed: ${timestamp(filledAt)}`
      ].join("\n")
    };
  }

  if (kind === "TRANCHE_EXIT_CONFIRMED") {
    const ringTag = safeText("ringTag", event.ringTag, { max: 16, pattern: /^(BUY|SELL)[1-8]$/ });
    const virtualSide = safeText("virtualSide", event.virtualSide, { max: 4, pattern: /^(BUY|SELL)$/ });
    const lotId = safeText("lotId", event.lotId, { max: 64 });
    const tranche = Number(event.tranche);
    if (!Number.isInteger(tranche) || tranche < 1 || tranche > 4) throw new TypeError("tranche is invalid");
    const fillPrice = positive("fillPrice", event.fillPrice);
    const filledQuantity = positive("filledQuantity", event.filledQuantity);
    const remainingQuantity = nonNegative("remainingQuantity", event.remainingQuantity);
    const ma = positive("ma", event.ma);
    const target = positive("target", event.target);
    const filledAt = canonicalUtc("filledAt", event.filledAt);
    return {
      kind,
      eventKey,
      message: [
        "💰 SOL TRANCHE EXIT CONFIRMED",
        `Ring: ${ringTag}`,
        `Lot: ${lotId}`,
        `Position side: ${virtualSide}`,
        `Tranche: ${tranche}/4`,
        `Target touched: ${money(target)}`,
        `Broker fill: ${money(fillPrice)}`,
        `Closed: ${quantity(filledQuantity)}`,
        `Remaining: ${quantity(remainingQuantity)}`,
        `Current 200-day MA: ${money(ma)}`,
        `Confirmed: ${timestamp(filledAt)}`
      ].join("\n")
    };
  }

  if (kind === "LOT_CLOSED") {
    const ringTag = safeText("ringTag", event.ringTag, { max: 16, pattern: /^(BUY|SELL)[1-8]$/ });
    const virtualSide = safeText("virtualSide", event.virtualSide, { max: 4, pattern: /^(BUY|SELL)$/ });
    const lotId = safeText("lotId", event.lotId, { max: 64 });
    const entryPrice = positive("entryPrice", event.entryPrice);
    const originalQuantity = positive("originalQuantity", event.originalQuantity);
    const finalFillPrice = positive("finalFillPrice", event.finalFillPrice);
    const openedAt = canonicalUtc("openedAt", event.openedAt);
    const closedAt = canonicalUtc("closedAt", event.closedAt);
    return {
      kind,
      eventKey,
      message: [
        "✅ SOL LOT FULLY CLOSED",
        `Ring: ${ringTag}`,
        `Lot: ${lotId}`,
        `Position side: ${virtualSide}`,
        `Entry fill: ${money(entryPrice)}`,
        `Original quantity: ${quantity(originalQuantity)}`,
        `Final exit fill: ${money(finalFillPrice)}`,
        `Opened: ${timestamp(openedAt)}`,
        `Closed: ${timestamp(closedAt)}`
      ].join("\n")
    };
  }

  if (kind === "HEARTBEAT_CONFIRMED") {
    const heartbeatQuantity = positive("quantity", event.quantity);
    const openFillPrice = positive("openFillPrice", event.openFillPrice);
    const closeFillPrice = positive("closeFillPrice", event.closeFillPrice);
    const openedAt = canonicalUtc("openedAt", event.openedAt);
    const closedAt = canonicalUtc("closedAt", event.closedAt);
    return {
      kind,
      eventKey,
      message: [
        "✅ SOL INACTIVITY HEARTBEAT COMPLETE",
        `Quantity: ${quantity(heartbeatQuantity)}`,
        `Open fill: ${money(openFillPrice)}`,
        `Close fill: ${money(closeFillPrice)}`,
        `Opened: ${timestamp(openedAt)}`,
        `Closed: ${timestamp(closedAt)}`,
        "Ring state was not changed."
      ].join("\n")
    };
  }

  if (kind === "RECONCILIATION_MISMATCH") {
    const stateVersion = Number(event.stateVersion);
    if (!Number.isSafeInteger(stateVersion) || stateVersion < 0) throw new TypeError("stateVersion is invalid");
    const expected = finite("expectedVirtualNetUnits", event.expectedVirtualNetUnits);
    const broker = finite("brokerNetUnits", event.brokerNetUnits);
    return {
      kind,
      eventKey,
      message: [
        "🚨 SOL SAFETY HALT — RECONCILIATION MISMATCH",
        `Virtual net: ${quantity(Math.abs(expected))}${expected < 0 ? " SHORT" : expected > 0 ? " LONG" : ""}`,
        `DXtrade net: ${quantity(Math.abs(broker))}${broker < 0 ? " SHORT" : broker > 0 ? " LONG" : ""}`,
        `State version: ${stateVersion}`,
        "New strategy actions are blocked. Owner review is required."
      ].join("\n")
    };
  }

  if (kind === "ACCOUNT_LOCKOUT") {
    const reasonCode = safeText("reasonCode", event.reasonCode, { max: 32, pattern: /^[A-Z_]+$/ });
    if (!ACCOUNT_LOCK_REASONS.has(reasonCode)) throw new TypeError("account lock reason is unsupported");
    const reason = reasonCode === "FOREIGN_POSITION"
      ? "A non-SOL position exists on the Tradeify account."
      : reasonCode === "MULTIPLE_POSITIONS"
        ? "More than one open broker position exists on the Tradeify account."
        : "DXtrade position count does not match position metrics.";
    return {
      kind,
      eventKey,
      message: [
        "🚨 TRADEIFY ACCOUNT LOCKOUT",
        reason,
        "New SOL grid actions are blocked until the account state is reconciled."
      ].join("\n")
    };
  }

  if (kind === "SAFETY_HALT") {
    const reasonCode = safeText("reasonCode", event.reasonCode, { max: 32, pattern: /^[A-Z_]+$/ });
    if (!SAFETY_HALT_REASONS.has(reasonCode)) throw new TypeError("safety halt reason is unsupported");
    return {
      kind,
      eventKey,
      message: [
        "🚨 SOL SAFETY HALT — RUNTIME ERROR",
        "The production runtime encountered an internal processing error.",
        "New strategy actions are halted. Existing funded-account protections remain authoritative.",
        "Owner review of Railway logs is required."
      ].join("\n")
    };
  }

  if (kind === "PROTECTIVE_FLATTEN_CONFIRMED") {
    if (!PROTECTIVE_REASONS.has(event.reason)) throw new TypeError("protective reason is unsupported");
    const flattenQuantity = positive("quantity", event.quantity);
    const fillPrice = positive("fillPrice", event.fillPrice);
    const filledAt = canonicalUtc("filledAt", event.filledAt);
    return {
      kind,
      eventKey,
      message: [
        "🚨 PROTECTIVE FLATTEN CONFIRMED",
        `Reason: ${event.reason}`,
        `Quantity closed: ${quantity(flattenQuantity)}`,
        `Broker fill: ${money(fillPrice)}`,
        `Confirmed: ${timestamp(filledAt)}`,
        "SOL grid state was reset and new entries remain subject to all account locks."
      ].join("\n")
    };
  }

  throw new TypeError("notification kind is unsupported");
}

export function createLiveTelegramNotifications({ persistence, addEvent = async () => {} }) {
  for (const method of ["claimTelegramNotification", "markTelegramNotificationSent", "markTelegramNotificationFailed"]) {
    if (typeof persistence?.[method] !== "function") throw new TypeError(`persistence.${method} is required`);
  }
  if (typeof addEvent !== "function") throw new TypeError("addEvent must be a function");

  let sender = null;
  let deliveryChain = Promise.resolve();

  async function safeAudit(level, kind, payload) {
    try {
      await addEvent(level, kind, payload);
    } catch {
      // Notification auditing is observational and must never affect trading state.
    }
  }

  function setSender(fn) {
    if (typeof fn !== "function") throw new TypeError("notification sender must be a function");
    if (sender !== null) throw new Error("notification sender is already configured");
    sender = fn;
  }

  async function notify(input) {
    let prepared;
    try {
      prepared = formatEvent(input);
    } catch {
      await safeAudit("WARN", "TELEGRAM_NOTIFICATION_REJECTED", {
        kind: typeof input?.kind === "string" ? input.kind.slice(0, 48) : "UNKNOWN"
      });
      return Object.freeze({ status: "REJECTED" });
    }

    let claim;
    try {
      claim = await persistence.claimTelegramNotification({
        eventKey: prepared.eventKey,
        kind: prepared.kind
      });
    } catch {
      await safeAudit("WARN", "TELEGRAM_NOTIFICATION_CLAIM_FAILED", {
        kind: prepared.kind,
        eventKey: prepared.eventKey
      });
      return Object.freeze({ status: "CLAIM_FAILED" });
    }

    if (claim.claimed !== true) {
      return Object.freeze({ status: "DUPLICATE_SUPPRESSED", priorStatus: claim.status ?? null });
    }

    if (sender === null) {
      try { await persistence.markTelegramNotificationFailed(prepared.eventKey); } catch {}
      await safeAudit("WARN", "TELEGRAM_NOTIFICATION_SENDER_UNAVAILABLE", {
        kind: prepared.kind,
        eventKey: prepared.eventKey
      });
      return Object.freeze({ status: "FAILED" });
    }

    try {
      await sender(prepared.message);
      try {
        await persistence.markTelegramNotificationSent(prepared.eventKey);
      } catch {
        await safeAudit("WARN", "TELEGRAM_NOTIFICATION_STATUS_UPDATE_FAILED", {
          kind: prepared.kind,
          eventKey: prepared.eventKey
        });
        return Object.freeze({ status: "SENT_STATUS_UNCERTAIN" });
      }
      await safeAudit("INFO", "TELEGRAM_NOTIFICATION_SENT", {
        kind: prepared.kind,
        eventKey: prepared.eventKey
      });
      return Object.freeze({ status: "SENT" });
    } catch {
      try { await persistence.markTelegramNotificationFailed(prepared.eventKey); } catch {}
      await safeAudit("WARN", "TELEGRAM_NOTIFICATION_DELIVERY_FAILED", {
        kind: prepared.kind,
        eventKey: prepared.eventKey
      });
      return Object.freeze({ status: "FAILED" });
    }
  }

  function enqueue(input) {
    deliveryChain = deliveryChain.then(() => notify(input), () => notify(input));
    return Object.freeze({ status: "QUEUED" });
  }

  async function drain() {
    await deliveryChain;
  }

  return Object.freeze({ setSender, notify, enqueue, drain });
}

export { formatEvent as formatLiveTelegramNotification };
