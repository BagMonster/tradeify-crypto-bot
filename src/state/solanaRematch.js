import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { describeVirtualBook } from "./solanaReconcile.js";
import { netsMatch, signedNetFromOpenPositions } from "../account/dxtradeSignedNet.js";

export const RECONCILIATION_HALT_REASON =
  "SOL virtual-lot state does not reconcile to the DXtrade net SOL position; owner review required";

export function isReconciliationHalt(reason) {
  return reason === RECONCILIATION_HALT_REASON;
}

export function hasReconciliationHalt(state) {
  return state?.safety_halt === true && isReconciliationHalt(state.halt_reason);
}

function otherHaltMessage(reason) {
  return [
    "REMATCH REFUSED — ACTIVE HALT IS NOT A RECONCILIATION MISMATCH",
    "",
    `Current halt: ${reason}`,
    "",
    "Rematch only clears the exact false-flat reconciliation halt.",
    "A runtime, D-049, or protective-order halt must be resolved on its own path."
  ].join("\n");
}

function noReconciliationHaltMessage(state) {
  if (state?.safety_halt === true) return otherHaltMessage(state.halt_reason);
  return [
    "REMATCH REFUSED — NO RECONCILIATION HALT",
    "",
    "Rematch is not an alternate /resume path.",
    "It is allowed only while the exact reconciliation-mismatch safety halt is latched."
  ].join("\n");
}

function hashRematchCode(code, salt) {
  return createHash("sha256").update(`${salt}:rematch:${code}`).digest("hex");
}

function safeHexEqual(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function createRematchHandlers({
  database,
  persistence,
  dxtradeClient = null,
  accountMonitor = null,
  onBooksRematched = async () => {}
}) {
  async function readFreshBrokerNet() {
    if (dxtradeClient && typeof dxtradeClient.login === "function") {
      await dxtradeClient.login();
    }

    let fromPositions = null;
    if (dxtradeClient && typeof dxtradeClient.getOpenPositions === "function") {
      try {
        fromPositions = signedNetFromOpenPositions(await dxtradeClient.getOpenPositions(), "SOL/USD");
      } catch (error) {
        fromPositions = Object.freeze({
          ok: false,
          error: error.message,
          netUnits: null
        });
      }
    }

    if (accountMonitor && typeof accountMonitor.pollOnce === "function") {
      try {
        await accountMonitor.pollOnce();
      } catch {
        // use any prior snapshot below
      }
    }

    const snapshot = accountMonitor?.getSnapshot?.()?.snapshot ?? null;
    const fromMetrics = snapshot && Number.isFinite(snapshot.signedNetUnits)
      ? snapshot.signedNetUnits
      : snapshot?.instrumentPosition
        ? Number(snapshot.instrumentPosition.quantity)
        : null;

    if (fromPositions?.ok) {
      return Object.freeze({
        ok: true,
        netUnits: fromPositions.netUnits,
        source: "open-positions",
        error: null
      });
    }
    if (snapshot?.positionsReadFailed === true || fromPositions?.ok === false) {
      return Object.freeze({
        ok: false,
        netUnits: null,
        source: "unavailable",
        error: fromPositions?.error ?? snapshot?.overlayError ?? "DXtrade /positions read failed; metrics flat is not trusted"
      });
    }
    if (Number.isFinite(fromMetrics)) {
      return Object.freeze({
        ok: true,
        netUnits: fromMetrics,
        source: snapshot?.positionSource ?? "metrics",
        error: null
      });
    }
    return Object.freeze({
      ok: false,
      netUnits: null,
      source: "unavailable",
      error: fromPositions?.error ?? "DXtrade position read is unavailable"
    });
  }

  async function requestRematch() {
    const [botState, gridState] = await Promise.all([
      database.getState(),
      persistence.state.load()
    ]);
    if (!gridState) return { code: null, message: "SOL grid state is not initialized. Rematch is unavailable." };
    if (!hasReconciliationHalt(botState)) {
      return { code: null, message: noReconciliationHaltMessage(botState) };
    }
    const book = describeVirtualBook(gridState);
    const broker = await readFreshBrokerNet();
    if (!broker.ok) {
      return {
        code: null,
        message: `Rematch refused: could not read a fresh DXtrade SOL position (${broker.error}).`
      };
    }
    if (!netsMatch(book.netUnits, broker.netUnits)) {
      return {
        code: null,
        message: [
          "REMATCH REFUSED — BOOKS STILL DISAGREE",
          "",
          `Virtual net: ${book.netUnits.toFixed(2)} SOL`,
          `Fresh DXtrade net: ${broker.netUnits.toFixed(2)} SOL (${broker.source})`,
          `Open virtual lots: ${book.openLots}`,
          "",
          "This command keeps the virtual lot. It does not invent a fill and does not flatten DXtrade.",
          "If DXtrade is actually flat, use /reconcile instead."
        ].join("\n")
      };
    }

    const code = String(randomInt(100000, 1000000));
    const salt = randomBytes(16).toString("hex");
    const hash = hashRematchCode(code, salt);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await database.setResumeChallenge(hash, salt, expiresAt);
    await database.addEvent("WARN", "SOL_REMATCH_REQUESTED", {
      source: "telegram",
      virtualNet: book.netUnits,
      brokerNet: broker.netUnits,
      brokerSource: broker.source,
      openLots: book.openLots,
      occupiedRings: book.occupiedRings,
      stateVersion: book.version
    });
    return {
      code,
      message: [
        "AUDITED BOOK REMATCH",
        "",
        `Virtual net: ${book.netUnits.toFixed(2)} SOL`,
        `Fresh DXtrade net: ${broker.netUnits.toFixed(2)} SOL (${broker.source})`,
        `Open virtual lots: ${book.openLots}`,
        `Occupied rings: ${book.occupiedRings.join(", ") || "none"}`,
        "",
        "This will keep the current virtual lots, clear the reconciliation halt, and lift the operator pause.",
        "It will NOT place a DXtrade order and will NOT flatten anything.",
        "",
        `To apply, send /confirmrematch ${code} within 10 minutes.`
      ].join("\n")
    };
  }

  async function confirmRematch(code) {
    const [botState, gridState] = await Promise.all([
      database.getState(),
      persistence.state.load()
    ]);
    if (!/^\d{6}$/.test(code ?? "")) return "Use /confirmrematch followed by the 6-digit code from /rematch.";
    if (!botState.resume_code_hash || !botState.resume_code_salt || !botState.resume_code_expires_at) {
      return "No rematch request is pending. Send /rematch first.";
    }
    if (new Date(botState.resume_code_expires_at).getTime() < Date.now()) {
      await database.clearResumeChallenge();
      return "That rematch code expired. Send /rematch for a new code.";
    }
    const suppliedHash = hashRematchCode(code, botState.resume_code_salt);
    if (!safeHexEqual(suppliedHash, botState.resume_code_hash)) {
      await database.addEvent("WARN", "SOL_REMATCH_CODE_REJECTED", { source: "telegram" });
      return "The rematch code is incorrect. A /resume or /reconcile code will not work here.";
    }
    if (!gridState) {
      await database.clearResumeChallenge();
      return "Rematch aborted: SOL grid state is missing.";
    }

    const book = describeVirtualBook(gridState);
    const broker = await readFreshBrokerNet();
    if (!broker.ok || !netsMatch(book.netUnits, broker.netUnits)) {
      await database.clearResumeChallenge();
      return [
        "Rematch aborted: the books no longer agree on a fresh DXtrade read.",
        `Virtual net: ${book.netUnits.toFixed(2)} SOL`,
        `Fresh DXtrade net: ${broker.ok ? broker.netUnits.toFixed(2) : "unavailable"} SOL`
      ].join("\n");
    }
    if (!hasReconciliationHalt(botState)) {
      await database.clearResumeChallenge();
      return noReconciliationHaltMessage(botState);
    }
    if (typeof database.clearSafetyHaltIfReason !== "function") {
      await database.clearResumeChallenge();
      return "Rematch aborted: atomic reconciliation-halt clear is unavailable.";
    }
    const cleared = await database.clearSafetyHaltIfReason(RECONCILIATION_HALT_REASON);
    if (!cleared) {
      await database.clearResumeChallenge();
      return [
        "REMATCH ABORTED — RECONCILIATION HALT WAS NO LONGER LATCHED",
        "",
        "The stored safety halt changed after the rematch code was issued.",
        "Rematch did not clear a different halt and did not lift the operator pause."
      ].join("\n");
    }
    if (typeof database.setOperatorKilled === "function") await database.setOperatorKilled(false);
    await database.clearResumeChallenge();
    if (typeof onBooksRematched === "function") await onBooksRematched({ virtualNet: book.netUnits, brokerNet: broker.netUnits });
    await database.addEvent("WARN", "SOL_BOOKS_REMATCHED", {
      source: "telegram",
      reason: "owner-audited halt clear after matching broker and virtual nets",
      virtualNet: book.netUnits,
      brokerNet: broker.netUnits,
      brokerSource: broker.source,
      openLots: book.openLots,
      occupiedRings: book.occupiedRings,
      stateVersion: book.version
    });
    return [
      "AUDITED BOOK REMATCH APPLIED",
      "",
      `Matched net: ${book.netUnits.toFixed(2)} SOL`,
      `Open virtual lots: ${book.openLots}`,
      `Occupied rings: ${book.occupiedRings.join(", ") || "none"}`,
      "Virtual lots: preserved",
      "Reconciliation safety halt: cleared",
      "Operator pause: lifted",
      "",
      "Send /status. The live lot stays in the notebook so the grid can manage the DXtrade position."
    ].join("\n");
  }

  return Object.freeze({ requestRematch, confirmRematch, readFreshBrokerNet });
}
