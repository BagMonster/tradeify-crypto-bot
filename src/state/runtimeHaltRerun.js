import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const RUNTIME_HALT_REASON_TAIL = "production runtime error; owner review required";
export const RUNTIME_HALT_REASON_MARKER = "production runtime error";
const NET_TOLERANCE = 1e-8;

export function isRuntimeErrorHalt(reason) {
  if (typeof reason !== "string") return false;
  const text = reason.trim().toLowerCase();
  // index.mjs writes "<INST> production runtime error: <detail>", which ends with
  // the error detail rather than the canonical tail. The tail-only test therefore
  // never matched a runtime halt the runtime itself had written, and /rerun could
  // not clear it — leaving the account paused with no command able to release it.
  // Match the marker anywhere as well. No other halt reason in this codebase
  // contains the phrase "production runtime error": reconciliation, 15-minute,
  // D-049 and D-064 halts all still return false.
  return text.endsWith(RUNTIME_HALT_REASON_TAIL) || text.includes(RUNTIME_HALT_REASON_MARKER);
}

export function hasRuntimeErrorHalt(state) {
  return state?.safety_halt === true && isRuntimeErrorHalt(state.halt_reason);
}

function hashRerunCode(code, salt) {
  return createHash("sha256").update(`${salt}:rerun:${code}`).digest("hex");
}

function safeHexEqual(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function formatNet(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "unavailable";
}

export function summarizeBookRows(rows) {
  return rows.map((row) => {
    const mark = row.match === true ? "MATCH" : "MISMATCH";
    return `  ${row.instrument}: virtual ${formatNet(row.virtualNet)}  broker ${formatNet(row.brokerNet)}  lots ${row.openLots}  ${mark}`;
  }).join("\n");
}

function instrumentCode(instrument) {
  return typeof instrument === "string" && instrument.includes("/")
    ? instrument.split("/")[0]
    : "<INSTRUMENT>";
}

function isFlatBrokerWithVirtualInventory(row) {
  if (row?.ok !== true || row?.match === true) return false;
  const virtualNet = Number(row?.virtualNet);
  const brokerNet = Number(row?.brokerNet);
  const openLots = Number(row?.openLots);
  return Number.isFinite(brokerNet) && Math.abs(brokerNet) <= NET_TOLERANCE &&
    ((Number.isFinite(virtualNet) && Math.abs(virtualNet) > NET_TOLERANCE) ||
      (Number.isInteger(openLots) && openLots > 0));
}

/**
 * Mismatches that have an exact, safe owner recovery: the broker is flat but
 * the bot still has virtual inventory. `/reconcile <instrument>` intentionally
 * clears only that virtual inventory after a fresh flat-broker check; it never
 * places a DXtrade order.
 */
export function flatBrokerVirtualInventoryRows(rows = []) {
  return rows.filter(isFlatBrokerWithVirtualInventory);
}

export function virtualInventoryRecoveryPlan(rows = []) {
  const recoverable = flatBrokerVirtualInventoryRows(rows);
  if (recoverable.length === 0) return "";

  const lines = [
    "VIRTUAL INVENTORY RECONCILIATION REQUIRED",
    ""
  ];
  for (const row of recoverable) {
    const code = instrumentCode(row.instrument);
    lines.push(
      `${row.instrument}: DXtrade is flat, but ${row.openLots} virtual lot${row.openLots === 1 ? "" : "s"} remain (virtual ${formatNet(row.virtualNet)}).`,
      `1. Send /reconcile ${code}`,
      `2. Send /confirmreconcile CODE ${code} using the returned six-digit code.`,
      "   This clears only the stale virtual lots and rearms their rings; it places no DXtrade order.",
      ""
    );
  }
  lines.push(
    "After every listed book shows virtual 0.00, broker 0.00, and 0 lots, send /rerun again.",
    "If /rerun returns a code, confirm it with /confirmrerun CODE."
  );
  return lines.join("\n");
}

export function createRuntimeHaltRerunHandlers({
  database,
  inspectBooks,
  onRuntimeHaltCleared = async () => {}
}) {
  if (!database || typeof database.getState !== "function") {
    throw new TypeError("database.getState is required");
  }
  if (typeof inspectBooks !== "function") throw new TypeError("inspectBooks is required");

  async function inspectOrThrow() {
    const rows = await inspectBooks();
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error("No enabled books to inspect");
    }
    return rows;
  }

  function refusalForHalt(state) {
    if (state?.safety_halt === true) {
      return [
        "RE-RUN REFUSED — ACTIVE HALT IS NOT A PRODUCTION RUNTIME ERROR",
        "",
        `Current halt: ${state.halt_reason}`,
        "",
        "Re-run only clears \"…production runtime error; owner review required\".",
        "A reconciliation mismatch is /rematch. A leftover virtual lot on a flat broker is /reconcile."
      ].join("\n");
    }
    return [
      "RE-RUN REFUSED — NO RUNTIME HALT",
      "",
      "There is no production runtime-error safety halt to clear.",
      "/status should already show RUNNING unless an operator pause is on."
    ].join("\n");
  }

  function booksDisagreeMessage(rows) {
    const recovery = virtualInventoryRecoveryPlan(rows);
    return [
      "RE-RUN REFUSED — A BOOK DOES NOT MATCH",
      "",
      summarizeBookRows(rows),
      "",
      "Re-run keeps every virtual lot. It does not invent a fill and does not flatten DXtrade.",
      recovery || "Fix the mismatched book first."
    ].join("\n");
  }

  function unreadMessage(rows) {
    const unread = rows.filter((row) => row.ok !== true).map((row) => row.instrument);
    return [
      "RE-RUN REFUSED — BROKER NET UNAVAILABLE",
      "",
      `Unread: ${unread.join(", ") || "unknown"}`,
      summarizeBookRows(rows),
      "",
      "A missing DXtrade net is not treated as flat."
    ].join("\n");
  }

  async function requestRerun() {
    const [botState, rows] = await Promise.all([
      database.getState(),
      inspectOrThrow()
    ]);
    if (!hasRuntimeErrorHalt(botState)) {
      return { code: null, message: refusalForHalt(botState) };
    }
    if (rows.some((row) => row.ok !== true)) {
      return { code: null, message: unreadMessage(rows) };
    }
    if (rows.some((row) => row.match !== true)) {
      return { code: null, message: booksDisagreeMessage(rows) };
    }

    const code = String(randomInt(100000, 1000000));
    const salt = randomBytes(16).toString("hex");
    const hash = hashRerunCode(code, salt);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await database.setResumeChallenge(hash, salt, expiresAt);
    await database.addEvent("WARN", "RUNTIME_HALT_RERUN_REQUESTED", {
      source: "telegram",
      haltReason: botState.halt_reason,
      books: rows.map((row) => ({
        instrument: row.instrument,
        virtualNet: row.virtualNet,
        brokerNet: row.brokerNet,
        openLots: row.openLots
      }))
    });
    return {
      code,
      message: [
        "RUNTIME HALT RE-RUN",
        "",
        `Current halt: ${botState.halt_reason}`,
        "",
        summarizeBookRows(rows),
        "",
        "This will clear that runtime safety halt only.",
        "It will NOT change virtual lots, NOT place a DXtrade order, and NOT lift an operator pause.",
        "",
        `To apply, send /confirmrerun ${code} within 10 minutes.`
      ].join("\n")
    };
  }

  async function confirmRerun(code) {
    const botState = await database.getState();
    if (!/^\d{6}$/.test(code ?? "")) return "Use /confirmrerun followed by the 6-digit code from /re-run.";
    if (!botState.resume_code_hash || !botState.resume_code_salt || !botState.resume_code_expires_at) {
      return "No re-run request is pending. Send /re-run first.";
    }
    if (new Date(botState.resume_code_expires_at).getTime() < Date.now()) {
      await database.clearResumeChallenge();
      return "That re-run code expired. Send /re-run for a new code.";
    }
    const suppliedHash = hashRerunCode(code, botState.resume_code_salt);
    if (!safeHexEqual(suppliedHash, botState.resume_code_hash)) {
      await database.addEvent("WARN", "RUNTIME_HALT_RERUN_CODE_REJECTED", { source: "telegram" });
      return "The re-run code is incorrect. A /resume, /reconcile, or /rematch code will not work here.";
    }

    const rows = await inspectOrThrow();
    if (rows.some((row) => row.ok !== true) || rows.some((row) => row.match !== true)) {
      await database.clearResumeChallenge();
      return rows.some((row) => row.ok !== true) ? unreadMessage(rows) : booksDisagreeMessage(rows);
    }
    if (!hasRuntimeErrorHalt(botState)) {
      await database.clearResumeChallenge();
      return refusalForHalt(botState);
    }
    if (typeof database.clearSafetyHaltIfReason !== "function") {
      await database.clearResumeChallenge();
      return "Re-run aborted: atomic halt clear is unavailable.";
    }
    const cleared = await database.clearSafetyHaltIfReason(botState.halt_reason);
    if (!cleared) {
      await database.clearResumeChallenge();
      return [
        "RE-RUN ABORTED — RUNTIME HALT WAS NO LONGER LATCHED",
        "",
        "The stored safety halt changed after the code was issued.",
        "Re-run did not clear a different halt."
      ].join("\n");
    }
    await database.clearResumeChallenge();
    if (typeof onRuntimeHaltCleared === "function") await onRuntimeHaltCleared();
    await database.addEvent("WARN", "RUNTIME_HALT_RERUN_APPLIED", {
      source: "telegram",
      clearedReason: botState.halt_reason,
      books: rows.map((row) => ({
        instrument: row.instrument,
        virtualNet: row.virtualNet,
        brokerNet: row.brokerNet,
        openLots: row.openLots
      }))
    });
    return [
      "RUNTIME HALT RE-RUN APPLIED",
      "",
      `Cleared: ${botState.halt_reason}`,
      "",
      summarizeBookRows(rows),
      "",
      "Virtual lots were not changed. No DXtrade order was placed.",
      "Operator pause is unchanged.",
      "",
      "Send /status. Bot should read RUNNING unless an operator pause is on."
    ].join("\n");
  }

  return Object.freeze({ requestRerun, confirmRerun });
}
