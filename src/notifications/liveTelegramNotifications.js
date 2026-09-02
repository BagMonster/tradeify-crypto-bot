const KINDS = new Set([
  "ENTRY_CONFIRMED",
  "TRANCHE_EXIT_CONFIRMED",
  "LOT_CLOSED",
  "HEARTBEAT_CONFIRMED",
  "RECONCILIATION_MISMATCH",
  "ACCOUNT_LOCKOUT",
  "SAFETY_HALT",
  "PROTECTIVE_FLATTEN_CONFIRMED",
  "D049_PARTIAL_CUT",
  "D049_FULL_FLATTEN"
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
  "SOL_RUNTIME_ERROR",
  "D049_PARTIAL_CUT_UNCONFIRMED",
  "D049_FULL_FLATTEN_UNCONFIRMED",
  "D049_BASELINE_MISMATCH"
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

function signedMoney(value) {
  const n = finite("signed money", value);
  return `${n < 0 ? "\u2212" : "+"}$${Math.abs(n).toFixed(2)}`;
}

function headingInstrument(value) {
  if (typeof value !== "string" || value.trim() === "") return "SOL";
  return safeText("instrument", value.trim(), { max: 16, pattern: /^[A-Z0-9]+\/[A-Z]+$/ });
}

function quantityUnit(instrument) {
  if (typeof instrument === "string" && instrument.includes("/")) return instrument.split("/")[0];
  return "SOL";
}

function quantity(value, instrument) {
  const n = nonNegative("quantity", value);
  return `${Number(n.toFixed(8))} ${quantityUnit(instrument)}`;
}

function timestamp(value) {
  return canonicalUtc("timestamp", value).replace("T", " ").replace(".000Z", "Z");
}

function ringTag(value) {
  return safeText("ringTag", value, { max: 16, pattern: /^(BUY|SELL)([1-9]|[1-9][0-9])$/ });
}

function netLabel(value, instrument) {
  return `${quantity(Math.abs(value), instrument)}${value < 0 ? " SHORT" : value > 0 ? " LONG" : ""}`;
}

function formatEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("notification event must be an object");
  const kind = safeText("kind", event.kind, { max: 48, pattern: /^[A-Z0-9_]+$/ });
  if (!KINDS.has(kind)) throw new TypeError("notification kind is unsupported");
  const eventKey = safeText("eventKey", event.eventKey, { max: 160, pattern: /^[A-Za-z0-9_.:-]+$/ });
  const instrument = headingInstrument(event.instrument);

  if (kind === "ENTRY_CONFIRMED") {
    const side = safeText("side", event.side, { max: 4, pattern: /^(BUY|SELL)$/ });
    const tag = ringTag(event.ringTag);
    const lotId = safeText("lotId", event.lotId, { max: 64 });
    const fillPrice = positive("fillPrice", event.fillPrice);
    const filledQuantity = positive("filledQuantity", event.filledQuantity);
    const ma = positive("ma", event.ma);
    const filledAt = canonicalUtc("filledAt", event.filledAt);
    return {
      kind,
      eventKey,
      message: [
        `\uD83D\uDFE2 ${instrument} ENTRY CONFIRMED`,
        `Ring: ${tag}`,
        `Side: ${side}`,
        `Fill: ${money(fillPrice)}`,
        `Quantity: ${quantity(filledQuantity, event.instrument)}`,
        `Virtual lot: ${lotId}`,
        `Current 200-day MA: ${money(ma)}`,
        `Confirmed: ${timestamp(filledAt)}`
      ].join("\n")
    };
  }

  if (kind === "TRANCHE_EXIT_CONFIRMED") {
    const tag = ringTag(event.ringTag);
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
        `\uD83D\uDCB0 ${instrument} TRANCHE EXIT CONFIRMED`,
        `Ring: ${tag}`,
        `Lot: ${lotId}`,
        `Position side: ${virtualSide}`,
        `Tranche: ${tranche}/4`,
        `Target touched: ${money(target)}`,
        `Broker fill: ${money(fillPrice)}`,
        `Closed: ${quantity(filledQuantity, event.instrument)}`,
        `Remaining: ${quantity(remainingQuantity, event.instrument)}`,
        `Current 200-day MA: ${money(ma)}`,
        `Confirmed: ${timestamp(filledAt)}`
      ].join("\n")
    };
  }

  if (kind === "LOT_CLOSED") {
    const tag = ringTag(event.ringTag);
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
        `\u2705 ${instrument} LOT FULLY CLOSED`,
        `Ring: ${tag}`,
        `Lot: ${lotId}`,
        `Position side: ${virtualSide}`,
        `Entry fill: ${money(entryPrice)}`,
        `Original quantity: ${quantity(originalQuantity, event.instrument)}`,
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
        "\u2705 SOL INACTIVITY HEARTBEAT COMPLETE",
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
    if (event.stage === "WARNING") {
      const n = Number(event.warningNumber);
      const warningNumber = Number.isInteger(n) && n >= 1 && n <= 3 ? n : 1;
      const label = typeof event.instrument === "string" && event.instrument.trim()
        ? event.instrument.trim()
        : "GRID";
      return {
        kind,
        eventKey,
        message: [
          `\u26A0\uFE0F ${label} NET MISMATCH \u2014 WARNING ${warningNumber}/3`,
          `Virtual net: ${netLabel(expected, event.instrument)}`,
          `DXtrade net: ${netLabel(broker, event.instrument)}`,
          `State version: ${stateVersion}`,
          "This book is not taking new grid actions. Other books keep running.",
          "Safety halt in 15 minutes if the nets still disagree."
        ].join("\n")
      };
    }
    return {
      kind,
      eventKey,
      message: [
        "\uD83D\uDEA8 SOL SAFETY HALT \u2014 RECONCILIATION MISMATCH",
        `Virtual net: ${netLabel(expected, event.instrument)}`,
        `DXtrade net: ${netLabel(broker, event.instrument)}`,
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
        "\uD83D\uDEA8 TRADEIFY ACCOUNT LOCKOUT",
        reason,
        "New SOL grid actions are blocked until the account state is reconciled."
      ].join("\n")
    };
  }

  if (kind === "SAFETY_HALT") {
    const reasonCode = safeText("reasonCode", event.reasonCode, { max: 48, pattern: /^[A-Z0-9_]+$/ });
    if (!SAFETY_HALT_REASONS.has(reasonCode)) throw new TypeError("safety halt reason is unsupported");
    const detail = reasonCode === "D049_PARTIAL_CUT_UNCONFIRMED"
      ? "The D-049 50% protective cut did not reach a confirmed broker fill."
      : reasonCode === "D049_FULL_FLATTEN_UNCONFIRMED"
        ? "The D-049 emergency flatten did not confirm the account flat."
        : reasonCode === "D049_BASELINE_MISMATCH"
          ? "The persisted D-049 daily baseline does not match the fresh DXtrade account baseline."
          : "The production runtime encountered an internal processing error.";
    return {
      kind,
      eventKey,
      message: [
        `\uD83D\uDEA8 SOL SAFETY HALT \u2014 ${reasonCode}`,
        detail,
        "New strategy entries are halted. Owner review is required."
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
        "\uD83D\uDEA8 PROTECTIVE FLATTEN CONFIRMED",
        `Reason: ${event.reason}`,
        `Quantity closed: ${quantity(flattenQuantity, event.instrument)}`,
        `Broker fill: ${money(fillPrice)}`,
        `Confirmed: ${timestamp(filledAt)}`,
        "SOL grid state was reset and new entries remain subject to all account locks."
      ].join("\n")
    };
  }

  if (kind === "D049_PARTIAL_CUT") {
    const drawdownUsd = finite("drawdownUsd", event.drawdownUsd);
    const fraction = positive("fraction", event.fraction);
    if (fraction >= 1) throw new TypeError("fraction must be less than 1");
    const filledQuantity = positive("filledQuantity", event.filledQuantity);
    const fillPrice = positive("fillPrice", event.fillPrice);
    const lotsAffected = Number(event.lotsAffected);
    if (!Number.isSafeInteger(lotsAffected) || lotsAffected < 1) throw new TypeError("lotsAffected is invalid");
    const filledAt = canonicalUtc("filledAt", event.filledAt);
    return {
      kind,
      eventKey,
      message: [
        "\u26A0\uFE0F D-049 50% DE-RISK CUT CONFIRMED",
        `Daily drawdown at trigger: ${signedMoney(drawdownUsd)}`,
        `Fraction cut: ${(fraction * 100).toFixed(0)}% of each executable virtual lot`,
        `Broker quantity closed: ${quantity(filledQuantity, event.instrument)}`,
        `Broker fill: ${money(fillPrice)}`,
        `Virtual lots affected: ${lotsAffected}`,
        `Confirmed: ${timestamp(filledAt)}`,
        "New grid entries remain braked while the daily drawdown is below the entry-brake threshold."
      ].join("\n")
    };
  }

  if (kind === "D049_FULL_FLATTEN") {
    const drawdownUsd = finite("drawdownUsd", event.drawdownUsd);
    if (event.confirmedFlat !== true) throw new TypeError("D049 full flatten must confirm flat");
    const filledAt = canonicalUtc("filledAt", event.filledAt);
    const lines = [
      "\uD83D\uDEA8 D-049 DAILY FULL FLATTEN COMPLETE",
      `Daily drawdown at trigger: ${signedMoney(drawdownUsd)}`
    ];
    if (event.fillPrice != null) lines.push(`Broker fill: ${money(positive("fillPrice", event.fillPrice))}`);
    if (Number(event.filledQuantity) > 0) lines.push(`Quantity closed: ${quantity(event.filledQuantity, event.instrument)}`);
    lines.push(
      "Broker account: FLAT",
      `Confirmed: ${timestamp(filledAt)}`,
      "Automatic grid activity is halted until the next 22:00 UTC account-day rollover."
    );
    return { kind, eventKey, message: lines.join("\n") };
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
