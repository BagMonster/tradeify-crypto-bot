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
  "D049_FULL_FLATTEN",
  "HARVEST_PENDING",
  "HARVEST_CONFIRMED",
  "HARVEST_HALTED",
  "HARVEST_FRESHNESS_GRACE",
  "HARVEST_RESET",
  "HALT_WARNING",
  // Enqueued by riskSupervisor.js and index.mjs since the 2026-09-20 session-recovery
  // work, but missing from this list, so every one was rejected before delivery.
  "PROTECTION_FAILED",
  "PROTECTION_RECOVERED",
  "SESSION_ROTATION_FAILED",
  // Alerting build, 2026-09-20: blocked broker reads and an inert cut tier.
  "EXECUTION_BLOCKED",
  "EXECUTION_RECOVERED",
  "CUT_TIER_INERT",
  // Account-wide exposure pool (src/risk/exposureGate.js), 2026-09-21.
  "EXPOSURE_GATE_CLOSED",
  "EXPOSURE_GATE_REOPENED",
  "DUST_CLEANUP_SUMMARY"
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
  "D049_BASELINE_MISMATCH",
  "D060_ACCOUNT_FULL_FLATTEN",
  "RECONCILIATION_MISMATCH",
  "RUNTIME_ERROR",
  "ACCOUNT_LOCKOUT",
  "HYBRID_UNEXPLAINED_NET"
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

// Free text in a SAFETY alert must never cause the alert to be dropped. The strict
// safeText() above is right for structural fields (lot ids, ring tags, codes), where a
// bad value means a bad event. For human-readable reasons it was wrong: a "&" in
// "P&L" or a "[" in a runtime-error reason rejected the whole warning, and notify()
// swallows rejections, so the owner was told nothing.
//
// displayText() keeps the security property — nothing outside the allowlist is ever
// echoed, so no newlines, control characters, bidi overrides or "=" — but degrades
// to a fixed withheld line instead of throwing. Bracketed segments are removed first:
// by convention they carry raw exception detail, which alerts do not echo.
const DISPLAY_TEXT = /^[A-Za-z0-9_ .,:;'()/+$&%<>-]+$/;

function displayText(value, { max = 300, fallback } = {}) {
  if (typeof value !== "string") return fallback;
  let out = value.replace(/\[[^\]\n]*\]/g, "").replace(/ {2,}/g, " ").trim();
  if (out.length > max) out = `${out.slice(0, max - 3).trimEnd()}...`;
  if (out === "" || !DISPLAY_TEXT.test(out)) return fallback;
  return out;
}

const REASON_WITHHELD = "Reason text withheld from Telegram (unsafe characters). See /status and the Railway logs.";
const CORRECTION_WITHHELD = "Inspect /status and DXtrade before taking the halt's documented recovery path.";

function optionalFinite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function duration(ms) {
  const n = optionalFinite(ms);
  if (n === null || n < 0) return "unknown";
  const totalSeconds = Math.round(n / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function requiredInstrument(value) {
  return safeText("instrument", value, { max: 16, pattern: /^[A-Z0-9]+\/[A-Z]+$/ });
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

function oppositeSide(side) {
  return side === "BUY" ? "SELL" : "BUY";
}

function positionWord(side) {
  return side === "BUY" ? "LONG" : "SHORT";
}

function formatEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("notification event must be an object");
  const kind = safeText("kind", event.kind, { max: 48, pattern: /^[A-Z0-9_]+$/ });
  if (!KINDS.has(kind)) throw new TypeError("notification kind is unsupported");
  const eventKey = safeText("eventKey", event.eventKey, { max: 160, pattern: /^[A-Za-z0-9_.:-]+$/ });
  const instrument = headingInstrument(event.instrument);

  if (kind === "HARVEST_PENDING") {
    return { kind, eventKey, message: ["D-064 HARVEST PENDING", `Account-day P&L: ${signedMoney(event.combinedDayPnlUsd)}`, `Threshold: +${money(event.thresholdUsd)}`, "Flattening every enabled book. New entries and ordinary exits are paused until confirmation."].join("\n") };
  }
  if (kind === "HARVEST_CONFIRMED") {
    const confirmedAt = canonicalUtc("confirmedAt", event.confirmedAt);
    return { kind, eventKey, message: ["D-064 HARVEST CONFIRMED", `Account-day P&L: ${signedMoney(event.combinedDayPnlUsd)}`, `Threshold: +${money(event.thresholdUsd)}`, "Every enabled broker book is flat.", "New touch-cross entries may run. Ordinary tranche exits are disabled until 22:00 UTC.", `Confirmed: ${timestamp(confirmedAt)}`].join("\n") };
  }
  if (kind === "HARVEST_HALTED") {
    const freshnessFailure = typeof event.reason === "string" &&
      event.reason.trim().startsWith("D-064 harvest cannot verify fresh broker account data for ");
    const reason = displayText(event.reason, { max: 300, fallback: REASON_WITHHELD });
    return {
      kind,
      eventKey,
      message: [
        "🚨 D-064 HARVEST SAFETY HALT",
        reason,
        freshnessFailure
          ? "Correction: wait for /status to show fresh DXtrade data and matching virtual/broker nets, then send /harvestrecover and confirm its 6-digit code."
          : "Correction: when /status shows every book fresh and flat (virtual 0, broker 0, lots 0), send /harvestrecover and confirm its 6-digit code. Do not use /resume to bypass this halt."
      ].join("\n")
    };
  }
  if (kind === "HARVEST_FRESHNESS_GRACE") {
    if (!Array.isArray(event.instruments) || event.instruments.length === 0) throw new TypeError("freshness grace instruments are required");
    const instruments = event.instruments.map((value) => headingInstrument(value));
    const graceMs = positive("graceMs", event.graceMs);
    return {
      kind,
      eventKey,
      message: [
        "⚠️ D-064 FRESH-DATA GRACE",
        `DXtrade account data is temporarily unreadable for: ${instruments.join(", ")}.`,
        "Normal grid actions are blocked while broker data is stale; no durable halt has been latched yet.",
        `Grace window: ${Math.ceil(graceMs / 60000)} minutes.`,
        "Correction: wait for /status to show fresh DXtrade data. The gate clears automatically; do not use /resume."
      ].join("\n")
    };
  }
  if (kind === "HARVEST_RESET") {
    const dayKey = safeText("dayKey", event.dayKey, { max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ });
    return { kind, eventKey, message: ["D-064 ACCOUNT-DAY RESET", `New Tradeify account day: ${dayKey}`, "Harvest state cleared. Ordinary tranche exits are enabled again."].join("\n") };
  }
  if (kind === "HALT_WARNING") {
    const reasonCode = safeText("halt warning reason code", event.reasonCode, { max: 64, pattern: /^[A-Z0-9_]+$/ });
    if (!SAFETY_HALT_REASONS.has(reasonCode)) throw new TypeError("halt warning reason is unsupported");
    const reason = displayText(event.reason, { max: 300, fallback: REASON_WITHHELD });
    const correction = displayText(event.correction, { max: 400, fallback: CORRECTION_WITHHELD });
    const warningNumber = Number(event.warningNumber);
    const warningCount = Number(event.warningCount);
    if (!Number.isInteger(warningNumber) || !Number.isInteger(warningCount) || warningCount !== 5 || warningNumber < 1 || warningNumber > warningCount) {
      throw new TypeError("halt warning sequence is invalid");
    }
    const haltAt = canonicalUtc("haltAt", event.haltAt);
    const scope = event.instrument == null ? "TRADEIFY ACCOUNT" : headingInstrument(event.instrument);
    return {
      kind,
      eventKey,
      message: [
        `⚠️ ${scope} HALT WARNING ${warningNumber}/${warningCount} — ${reasonCode}`,
        `Reason: ${reason}`,
        "Trading is still running; no safety halt has fired.",
        `Automatic halt eligible: ${timestamp(haltAt)}.`,
        `Correction: ${correction}`,
        "To defer this exact halt for a new 25-minute warning cycle, send /pausehalt."
      ].join("\n")
    };
  }

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
        `Opening order: ${side} ${quantity(filledQuantity, event.instrument)}`,
        `Position opened: ${positionWord(side)}`,
        `Ring: ${tag}`,
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
        `Closing order: ${oppositeSide(virtualSide)} ${quantity(filledQuantity, event.instrument)}`,
        `Position: ${positionWord(virtualSide)}`,
        `Ring: ${tag}`,
        `Lot: ${lotId}`,
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
        `Closed with: ${oppositeSide(virtualSide)}`,
        `Position was: ${positionWord(virtualSide)}`,
        `Ring: ${tag}`,
        `Lot: ${lotId}`,
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
        `\uD83D\uDEA8 ${instrument} SAFETY HALT \u2014 RECONCILIATION MISMATCH`,
        `Virtual net: ${netLabel(expected, event.instrument)}`,
        `DXtrade net: ${netLabel(broker, event.instrument)}`,
        `State version: ${stateVersion}`,
        `Correction: once /status shows these nets match, send /rematch ${quantityUnit(event.instrument)} and confirm its code.`
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
          : reasonCode === "D060_ACCOUNT_FULL_FLATTEN"
            ? "The account-wide daily-loss flatten threshold was reached."
            : reasonCode === "RECONCILIATION_MISMATCH"
              ? "The virtual-lot position does not match the DXtrade net position."
              : reasonCode === "ACCOUNT_LOCKOUT"
                ? "DXtrade returned an unexpected or internally inconsistent account position state."
                : reasonCode === "HYBRID_UNEXPLAINED_NET"
                  ? "A book's virtual net diverged from the DXtrade book and no manual fill explains it."
              : "The production runtime encountered an internal processing error.";
    const correction = reasonCode === "SOL_RUNTIME_ERROR" || reasonCode === "RUNTIME_ERROR"
      ? "Correction: after /status shows every virtual/broker net matches, send /rerun and confirm its code."
      : reasonCode === "HYBRID_UNEXPLAINED_NET"
        ? "Correction: inspect /status and /rawhistory, reconcile in DXtrade, then send /rerun once every book matches."
      : reasonCode === "D060_ACCOUNT_FULL_FLATTEN"
        ? "Correction: inspect /status and DXtrade fills. This protective lock holds until the next 22:00 UTC account-day reset."
        : reasonCode === "RECONCILIATION_MISMATCH"
          ? `Correction: after /status shows matching virtual and DXtrade nets, send /rematch ${quantityUnit(event.instrument)} and confirm its code.`
          : reasonCode === "ACCOUNT_LOCKOUT"
            ? "Correction: inspect /status and DXtrade positions, then correct the unexpected broker position before a durable halt fires."
        : "Correction: inspect /status and DXtrade before taking the halt's documented recovery path. /resume cannot bypass it.";
    const scope = event.instrument == null ? "TRADEIFY ACCOUNT" : headingInstrument(event.instrument);
    return {
      kind,
      eventKey,
      message: [
        `\uD83D\uDEA8 ${scope} SAFETY HALT \u2014 ${reasonCode}`,
        detail,
        correction
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

  // ---- Protection and session alerts -------------------------------------------
  // These were enqueued without a matching branch. Only kind and eventKey are
  // required: a missing or malformed optional field drops its line, never the alert.

  if (kind === "PROTECTION_FAILED") {
    const failures = optionalFinite(event.consecutiveFailedCuts);
    const status = displayText(event.failureStatus, { max: 48, fallback: "UNKNOWN" });
    const combined = optionalFinite(event.combinedDayPnlUsd);
    const unrealised = optionalFinite(event.totalUnrealisedUsd);
    const lines = ["\uD83D\uDEA8 PROTECTIVE CUT FAILED \u2014 NOTHING FILLED"];
    if (failures !== null) lines.push(`Failed cut attempts in a row: ${Math.trunc(failures)}`);
    lines.push(`Broker result: ${status}`, `Outage so far: ${duration(event.outageMs)}`);
    if (combined !== null) lines.push(`Account-day P&L: ${signedMoney(combined)}`);
    if (unrealised !== null) lines.push(`Unrealised: ${signedMoney(unrealised)}`);
    lines.push(
      "New entries are braked on every book. The ladder cannot reduce risk while this lasts.",
      "Send /health (it exercises an execution client). If it fails, send /relogin.",
      "If the loss is still growing, flatten in the DXtrade platform directly: /flatall reads positions through the same broker path that is failing."
    );
    return { kind, eventKey, message: lines.join("\n") };
  }

  if (kind === "PROTECTION_RECOVERED") {
    const combined = optionalFinite(event.combinedDayPnlUsd);
    const unrealised = optionalFinite(event.totalUnrealisedUsd);
    const lines = ["\u2705 PROTECTIVE CUTS WORKING AGAIN", `Outage lasted: ${duration(event.outageMs)}`];
    if (combined !== null) lines.push(`Account-day P&L: ${signedMoney(combined)}`);
    if (unrealised !== null) lines.push(`Unrealised: ${signedMoney(unrealised)}`);
    lines.push("A protective cut has filled. Entry brakes return to their normal rules; check /status.");
    return { kind, eventKey, message: lines.join("\n") };
  }

  if (kind === "SESSION_ROTATION_FAILED") {
    // Session names only. The per-session error text can carry a raw broker body,
    // so it is never echoed; it is already in the Railway log line.
    const entries = Array.isArray(event.failed) ? event.failed : [];
    const names = entries
      .map((entry) => displayText(entry?.name, { max: 48, fallback: "unnamed session" }))
      .slice(0, 8);
    return {
      kind,
      eventKey,
      message: [
        "\uD83D\uDEA8 DAILY DXTRADE SESSION ROTATION FAILED",
        `Sessions that did not log back in: ${names.length > 0 ? names.join(", ") : "not reported"}`,
        "Error text is withheld from Telegram; it is in the Railway logs.",
        "A dead execution session blocks entries, exits and protective cuts alike.",
        "Send /health now. If an execution client fails, send /relogin."
      ].join("\n")
    };
  }

  // ---- Blocked broker reads (ringExecutionGuard.js) ----------------------------

  if (kind === "EXECUTION_BLOCKED") {
    const book = requiredInstrument(event.instrument);
    const path = safeText("path", event.path, { max: 5, pattern: /^(ENTRY|EXIT)$/ });
    const reasonCode = displayText(event.reasonCode, { max: 64, fallback: "ACCOUNT_DATA_UNAVAILABLE" });
    return {
      kind,
      eventKey,
      message: [
        `\uD83D\uDEA8 ${book} ${path} BLOCKED \u2014 BROKER READ FAILED`,
        path === "EXIT"
          ? "The bot cannot close anything on this book: tranche exits and profit-taking are stopped."
          : "The bot cannot open on this book.",
        `Reason: ${reasonCode}`,
        "Protective cuts read positions the same way, so they are very likely blocked too.",
        "Send /health (it exercises an execution client). If it fails, send /relogin.",
        "No further alert for this book until a broker read succeeds."
      ].join("\n")
    };
  }

  if (kind === "EXECUTION_RECOVERED") {
    const book = requiredInstrument(event.instrument);
    const blocked = optionalFinite(event.blockedCount);
    const lines = [`\u2705 ${book} BROKER READ RECOVERED`, `Outage lasted: ${duration(event.outageMs)}`];
    if (blocked !== null && blocked >= 0) lines.push(`Actions blocked during the outage: ${Math.trunc(blocked)}`);
    lines.push("Entry brakes set by the risk supervisor are not cleared by this. Check /status.");
    return { kind, eventKey, message: lines.join("\n") };
  }

  // ---- Inert cut tier (riskSupervisor.js) --------------------------------------

  if (kind === "CUT_TIER_INERT") {
    const combined = finite("combinedDayPnlUsd", event.combinedDayPnlUsd);
    const threshold = positive("thresholdUsd", event.thresholdUsd);
    return {
      kind,
      eventKey,
      message: [
        "\u26A0\uFE0F CUT TIER REACHED WITH NOTHING TO CUT",
        `Account-day P&L: ${signedMoney(combined)}`,
        `Tier threshold: \u2212${money(threshold)}`,
        "Every book is flat or winning on unrealised, so the proportional allocator has no loser to cut.",
        "The day's loss is most likely already realised. The ladder cannot reduce it further; only the full flatten remains.",
        "Check /status. One alert per episode; it resets when a cut becomes possible again."
      ].join("\n")
    };
  }

  // ---- Account-wide exposure pool (exposureGate.js) ----------------------------

  if (kind === "EXPOSURE_GATE_CLOSED") {
    const exposure = finite("exposureUsd", event.exposureUsd);
    const soft = positive("softUsd", event.softUsd);
    const hard = positive("hardUsd", event.hardUsd);
    const lines = [
      "\u26D4 EXPOSURE CEILING REACHED \u2014 NEW ENTRIES PAUSED",
      `Account exposure: ${money(exposure)}`,
      `Soft ceiling: ${money(soft)} (no new entries at or above)`,
      `Hard ceiling: ${money(hard)} (no single fill may cross)`
    ];
    const notional = optionalFinite(event.notionalUsd);
    if (typeof event.instrument === "string" && notional !== null) {
      lines.push(`First refused: ${requiredInstrument(event.instrument)} entry of ${money(notional)}`);
    }
    lines.push(
      "Exits, tranches, cuts, the flatten and harvest are not affected.",
      `Entries resume on their own once exposure falls below ${money(soft)}. One alert per episode.`
    );
    return { kind, eventKey, message: lines.join("\n") };
  }

  if (kind === "EXPOSURE_GATE_REOPENED") {
    const exposure = finite("exposureUsd", event.exposureUsd);
    const soft = positive("softUsd", event.softUsd);
    const refusals = optionalFinite(event.refusals);
    const lines = [
      "\u2705 EXPOSURE BELOW CEILING \u2014 ENTRIES RESUMED",
      `Account exposure: ${money(exposure)} (soft ceiling ${money(soft)})`,
      `Entries were paused for: ${duration(event.closedForMs)}`
    ];
    if (refusals !== null && refusals >= 0) lines.push(`Entries refused while paused: ${Math.trunc(refusals)}`);
    return { kind, eventKey, message: lines.join("\n") };
  }

  if (kind === "DUST_CLEANUP_SUMMARY") {
    const dayKey = safeText("dust cleanup dayKey", event.dayKey, { max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ });
    const candidateCount = Math.max(0, Math.trunc(nonNegative("dust cleanup candidateCount", event.candidateCount ?? 0)));
    const excludedCurrentAccountDay = Math.max(0, Math.trunc(nonNegative("dust cleanup current-account-day exclusions", event.excludedCurrentAccountDay ?? 0)));
    const excludedMissingPositionCode = Math.max(0, Math.trunc(nonNegative("dust cleanup missing-position-code exclusions", event.excludedMissingPositionCode ?? 0)));
    const excludedNoIntendedUnits = Math.max(0, Math.trunc(nonNegative("dust cleanup no-intent exclusions", event.excludedNoIntendedUnits ?? 0)));
    const excludedAboveMaximumFraction = Math.max(0, Math.trunc(nonNegative("dust cleanup above-fraction exclusions", event.excludedAboveMaximumFraction ?? 0)));
    const closedCount = Math.max(0, Math.trunc(nonNegative("dust cleanup closedCount", event.closedCount)));
    const deferredCount = Math.max(0, Math.trunc(nonNegative("dust cleanup deferredCount", event.deferredCount)));
    const failedCount = Math.max(0, Math.trunc(nonNegative("dust cleanup failedCount", event.failedCount)));
    const autoLossUsd = nonNegative("dust cleanup autoLossUsd", event.autoLossUsd);
    const lossBudgetUsd = positive("dust cleanup lossBudgetUsd", event.lossBudgetUsd);
    const lines = [
      "🧹 DAILY RING DUST CLEANUP",
      `Account day: ${dayKey}`,
      `Eligible bot-owned residual tickets: ${candidateCount}`,
      `Closed automatically: ${closedCount} bot-owned residual ticket${closedCount === 1 ? "" : "s"}`,
      `Auto-close realised loss today: ${money(autoLossUsd)} of ${money(lossBudgetUsd)} limit`
    ];
    const excluded = [];
    if (excludedCurrentAccountDay > 0) excluded.push(`${excludedCurrentAccountDay} opened this account day`);
    if (excludedMissingPositionCode > 0) excluded.push(`${excludedMissingPositionCode} without an exact broker ticket ID`);
    if (excludedNoIntendedUnits > 0) excluded.push(`${excludedNoIntendedUnits} without a usable original-size record`);
    if (excludedAboveMaximumFraction > 0) excluded.push(`${excludedAboveMaximumFraction} above the 10% size limit`);
    if (excluded.length > 0) lines.push(`Excluded: ${excluded.join("; ")}.`);
    if (Array.isArray(event.closed) && event.closed.length > 0) {
      const details = event.closed.slice(0, 20).map((close) => {
        try {
          const closeInstrument = requiredInstrument(close?.instrument);
          const closeRing = ringTag(close?.ringTag);
          const closeQuantity = quantity(positive("dust cleanup filledQuantity", close?.filledQuantity), closeInstrument);
          const closePnl = signedMoney(close?.realizedPnlUsd);
          return `• ${closeInstrument} ${closeRing} · ${closeQuantity} · ${closePnl}`;
        } catch {
          return "• One confirmed ticket detail was unavailable; see Railway logs.";
        }
      });
      lines.push("Confirmed closes:", ...details);
    }
    if (deferredCount > 0) lines.push(`Review required: ${deferredCount} losing residual ticket${deferredCount === 1 ? "" : "s"} exceeded the remaining loss allowance; no order was sent.`);
    if (failedCount > 0) lines.push(`Not closed: ${failedCount} ticket${failedCount === 1 ? "" : "s"} changed or could not be confirmed. Check /status and Railway logs.`);
    lines.push("New-account-day and manual/adopted positions were excluded. Released rings wait for a fresh later price crossing before re-entry.");
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
