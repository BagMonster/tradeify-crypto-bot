import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { describeVirtualBook } from "./solanaReconcile.js";
import { netsMatch, signedNetFromOpenPositions, trustedSignedNetFor } from "../account/dxtradeSignedNet.js";

export const RECONCILIATION_HALT_REASON =
  "SOL virtual-lot state does not reconcile to the DXtrade net SOL position; owner review required";

const FIFTEEN_MINUTE_RECON_HALT =
  /^[A-Z0-9]+\/[A-Z]+ virtual-lot state does not reconcile to the DXtrade net position after 15 minutes; owner review required$/;

export function isReconciliationHalt(reason) {
  if (reason === RECONCILIATION_HALT_REASON) return true;
  return typeof reason === "string" && FIFTEEN_MINUTE_RECON_HALT.test(reason);
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
    "Rematch only clears a virtual-vs-broker reconciliation halt, including the 15-minute instrument halt.",
    "A runtime, D-049, or protective-order halt must be resolved on its own path."
  ].join("\n");
}

function noReconciliationHaltMessage(state) {
  if (state?.safety_halt === true) return otherHaltMessage(state.halt_reason);
  return [
    "REMATCH REFUSED — NO RECONCILIATION HALT",
    "",
    "Rematch is not an alternate /resume path.",
    "It is allowed only while a reconciliation-mismatch safety halt is latched."
  ].join("\n");
}

function hashRematchCode(code, salt) {
  return createHash("sha256").update(`${salt}:rematch:${code}`).digest("hex");
}

function safeHexEqual(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function resolveInstrument(opts) {
  const fromDefinition = opts?.gridDefinition?.instrument;
  if (typeof fromDefinition === "string" && fromDefinition.includes("/")) return fromDefinition;
  if (typeof opts?.instrument === "string" && opts.instrument.includes("/")) return opts.instrument;
  return "SOL/USD";
}

function describeBook(state, grid) {
  if (grid && typeof grid.expectedNetUnits === "function" && state?.rings) {
    const openLots = state.rings.reduce((n, ring) => n + (Array.isArray(ring.lots) ? ring.lots.length : 0), 0);
    const occupied = state.rings.filter((ring) => Array.isArray(ring.lots) && ring.lots.length > 0).map((ring) => ring.tag);
    return Object.freeze({
      version: state.version,
      netUnits: grid.expectedNetUnits(state),
      openLots,
      occupiedRings: occupied
    });
  }
  return describeVirtualBook(state);
}

export function createRematchHandlers({
  database,
  persistence,
  dxtradeClient = null,
  accountMonitor = null,
  gridDefinition = null,
  instrument = null,
  grid = null,
  stateStore = null,
  onBooksRematched = async () => {}
}) {
  const bookInstrument = resolveInstrument({ gridDefinition, instrument });

  async function loadGridState() {
    if (stateStore && typeof stateStore.load === "function") return stateStore.load();
    if (persistence?.state && typeof persistence.state.load === "function") return persistence.state.load();
    return null;
  }

  async function readFreshBrokerNet() {
    if (dxtradeClient && typeof dxtradeClient.login === "function") {
      await dxtradeClient.login();
    }

    let fromPositions = null;
    if (dxtradeClient && typeof dxtradeClient.getOpenPositions === "function") {
      try {
        fromPositions = signedNetFromOpenPositions(await dxtradeClient.getOpenPositions(), bookInstrument);
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

    const accountStatus = accountMonitor?.getSnapshot?.() ?? null;
    const snapshot = accountStatus?.snapshot ?? null;
    const fromTrusted = trustedSignedNetFor(accountStatus, bookInstrument);

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
    if (Number.isFinite(fromTrusted)) {
      return Object.freeze({
        ok: true,
        netUnits: fromTrusted,
        source: snapshot?.positionSource ?? "metrics",
        error: null
      });
    }
    if (Number.isFinite(snapshot?.signedNetUnits) && bookInstrument === "SOL/USD") {
      return Object.freeze({
        ok: true,
        netUnits: snapshot.signedNetUnits,
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
      loadGridState()
    ]);
    if (!gridState) return { code: null, message: `${bookInstrument} grid state is not initialized. Rematch is unavailable.` };
    if (!hasReconciliationHalt(botState)) {
      return { code: null, message: noReconciliationHaltMessage(botState) };
    }
    const book = describeBook(gridState, grid);
    const broker = await readFreshBrokerNet();
    if (!broker.ok) {
      return {
        code: null,
        message: `Rematch refused: could not read a fresh DXtrade ${bookInstrument} position (${broker.error}).`
      };
    }
    if (!netsMatch(book.netUnits, broker.netUnits)) {
      return {
        code: null,
        message: [
          "REMATCH REFUSED — BOOKS STILL DISAGREE",
          "",
          `Virtual net: ${book.netUnits.toFixed(2)} ${bookInstrument}`,
          `Fresh DXtrade net: ${broker.netUnits.toFixed(2)} ${bookInstrument} (${broker.source})`,
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
      instrument: bookInstrument,
      virtualNet: book.netUnits,
      brokerNet: broker.netUnits,
      brokerSource: broker.source,
      openLots: book.openLots,
      occupiedRings: book.occupiedRings,
      stateVersion: book.version,
      haltReason: botState.halt_reason
    });
    return {
      code,
      message: [
        "AUDITED BOOK REMATCH",
        "",
        `Instrument: ${bookInstrument}`,
        `Halt: ${botState.halt_reason}`,
        `Virtual net: ${book.netUnits.toFixed(2)}`,
        `Fresh DXtrade net: ${broker.netUnits.toFixed(2)} (${broker.source})`,
        `Open virtual lots: ${book.openLots}`,
        `Occupied rings: ${book.occupiedRings.join(", ") || "none"}`,
        "",
        "This will keep the current virtual lots, clear that reconciliation halt, and lift the operator pause.",
        "It will NOT place a DXtrade order and will NOT flatten anything.",
        "",
        `To apply, send /confirmrematch ${code} ${bookInstrument.split("/")[0]} within 10 minutes.`
      ].join("\n")
    };
  }

  async function confirmRematch(code) {
    const [botState, gridState] = await Promise.all([
      database.getState(),
      loadGridState()
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
      await database.addEvent("WARN", "SOL_REMATCH_CODE_REJECTED", { source: "telegram", instrument: bookInstrument });
      return "The rematch code is incorrect. A /resume or /reconcile code will not work here.";
    }
    if (!gridState) {
      await database.clearResumeChallenge();
      return `Rematch aborted: ${bookInstrument} grid state is missing.`;
    }

    const book = describeBook(gridState, grid);
    const broker = await readFreshBrokerNet();
    if (!broker.ok || !netsMatch(book.netUnits, broker.netUnits)) {
      await database.clearResumeChallenge();
      return [
        "Rematch aborted: the books no longer agree on a fresh DXtrade read.",
        `Virtual net: ${book.netUnits.toFixed(2)} ${bookInstrument}`,
        `Fresh DXtrade net: ${broker.ok ? broker.netUnits.toFixed(2) : "unavailable"} ${bookInstrument}`
      ].join("\n");
    }
    const liveState = await database.getState();
    if (!hasReconciliationHalt(liveState)) {
      await database.clearResumeChallenge();
      return noReconciliationHaltMessage(liveState);
    }
    if (typeof database.clearSafetyHaltIfReason !== "function") {
      await database.clearResumeChallenge();
      return "Rematch aborted: atomic reconciliation-halt clear is unavailable.";
    }
    const cleared = await database.clearSafetyHaltIfReason(liveState.halt_reason);
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
    if (typeof onBooksRematched === "function") await onBooksRematched({ instrument: bookInstrument, virtualNet: book.netUnits, brokerNet: broker.netUnits });
    await database.addEvent("WARN", "SOL_BOOKS_REMATCHED", {
      source: "telegram",
      instrument: bookInstrument,
      reason: "owner-audited halt clear after matching broker and virtual nets",
      haltReason: liveState.halt_reason,
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
      `Instrument: ${bookInstrument}`,
      `Matched net: ${book.netUnits.toFixed(2)}`,
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
