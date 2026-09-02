export const SOL_INSTRUMENT = "SOL/USD";
export const NET_TOLERANCE = 0.0050001;

export function positionSymbol(position) {
  return String(position?.symbol ?? position?.instrument ?? "").trim();
}

export function signedPositionQuantity(position) {
  const qty = Number(position?.quantity ?? position?.qty);
  if (!Number.isFinite(qty)) throw new Error("DXtrade position quantity is invalid");
  const side = String(position?.side ?? position?.direction ?? "").toUpperCase();
  if (["SELL", "SHORT"].includes(side)) return -Math.abs(qty);
  if (["BUY", "LONG"].includes(side)) return Math.abs(qty);
  return qty;
}

export function positionRows(payload) {
  if (payload == null) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "object") {
    throw new Error("DXtrade open-positions response does not contain a positions array");
  }
  for (const key of ["positions", "positionList", "openPositions", "open_positions"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  if (payload.position && typeof payload.position === "object" && !Array.isArray(payload.position)) {
    return [payload.position];
  }
  throw new Error("DXtrade open-positions response does not contain a positions array");
}

export function netsMatch(expected, actual) {
  return Number.isFinite(expected) && Number.isFinite(actual) && Math.abs(expected - actual) <= NET_TOLERANCE;
}

function aggregateInstrumentPosition(rows, instrument) {
  if (rows.length === 0) return null;
  if (rows.length === 1) {
    const row = rows[0];
    return Object.freeze({
      symbol: row.symbol,
      quantity: row.quantity,
      markPrice: Number.isFinite(row.markPrice) ? row.markPrice : 0,
      openPl: Number.isFinite(row.openPl) ? row.openPl : 0,
      dayClosedPl: Number.isFinite(row.dayClosedPl) ? row.dayClosedPl : 0,
      avgOpenPrice: Number.isFinite(row.avgOpenPrice) ? row.avgOpenPrice : 0
    });
  }
  const quantity = rows.reduce((sum, row) => sum + row.quantity, 0);
  const openPl = rows.reduce((sum, row) => sum + (Number.isFinite(row.openPl) ? row.openPl : 0), 0);
  const dayClosedPl = rows.reduce((sum, row) => sum + (Number.isFinite(row.dayClosedPl) ? row.dayClosedPl : 0), 0);
  const markPrice = rows.find((row) => Number.isFinite(row.markPrice))?.markPrice ?? 0;
  return Object.freeze({
    symbol: instrument,
    quantity,
    markPrice: Number.isFinite(markPrice) ? markPrice : 0,
    openPl,
    dayClosedPl,
    avgOpenPrice: Number.isFinite(rows[0].avgOpenPrice) ? rows[0].avgOpenPrice : 0,
    ticketCount: rows.length
  });
}

export function signedNetFromOpenPositions(payload, instrument = SOL_INSTRUMENT) {
  const rows = positionRows(payload);
  const active = [];
  for (const row of rows) {
    const quantity = signedPositionQuantity(row);
    if (Math.abs(quantity) <= 1e-12) continue;
    active.push({
      symbol: positionSymbol(row),
      quantity,
      markPrice: Number(row?.markPrice ?? row?.price ?? row?.avgOpenPrice ?? 0),
      openPl: Number(row?.openPl ?? 0),
      dayClosedPl: Number(row?.dayClosedPl ?? 0),
      avgOpenPrice: Number(row?.avgOpenPrice ?? 0),
      raw: row
    });
  }

  const foreign = active.filter((row) => row.symbol && row.symbol !== instrument);
  const instrumentRows = active.filter((row) => row.symbol === instrument);
  if (foreign.length > 0) {
    return Object.freeze({
      ok: false,
      error: `A non-${instrument} position exists on the Tradeify account`,
      netUnits: null,
      openPositionsCount: active.length,
      instrumentPosition: null
    });
  }

  const row = aggregateInstrumentPosition(instrumentRows, instrument);
  return Object.freeze({
    ok: true,
    error: null,
    netUnits: row ? row.quantity : 0,
    openPositionsCount: active.length,
    instrumentPosition: row,
    instrumentTicketCount: instrumentRows.length
  });
}

// D-060 account reconciliation groups a readable broker book before handing each
// grid its own net. A ticket in another enabled instrument is not foreign to that
// grid; only a symbol outside the configured allowlist is a lockout condition.

export function signedNetByInstrument(payload, instruments) {

  if (!Array.isArray(instruments) || instruments.length === 0) {
    throw new TypeError("signedNetByInstrument requires a non-empty instrument list");
  }
  const allowed = new Set(instruments);
  const rows = positionRows(payload);

  const active = [];
  for (const row of rows) {
    const quantity = signedPositionQuantity(row);
    if (Math.abs(quantity) <= 1e-12) continue;
    active.push({
      symbol: positionSymbol(row),
      quantity,
      markPrice: Number(row?.markPrice ?? row?.price ?? row?.avgOpenPrice ?? 0),
      openPl: Number(row?.openPl ?? 0),
      dayClosedPl: Number(row?.dayClosedPl ?? 0),
      avgOpenPrice: Number(row?.avgOpenPrice ?? 0),
      raw: row
    });
  }

  const foreign = active.filter((row) => row.symbol && !allowed.has(row.symbol));
  if (foreign.length > 0) {
    const names = [...new Set(foreign.map((row) => row.symbol))].join(", ");
    return Object.freeze({
      ok: false,
      error: `A foreign position exists on the Tradeify account: ${names}`,
      byInstrument: null,
      openPositionsCount: active.length,
      foreignInstruments: Object.freeze([...new Set(foreign.map((row) => row.symbol))])
    });
  }

  const byInstrument = {};
  for (const instrument of instruments) {
    const own = active.filter((row) => row.symbol === instrument);
    const netUnits = own.reduce((sum, row) => sum + row.quantity, 0);
    const notional = own.reduce((sum, row) => sum + Math.abs(row.quantity * row.markPrice), 0);
    byInstrument[instrument] = Object.freeze({
      instrument,
      netUnits,
      ticketCount: own.length,
      openPl: own.reduce((sum, row) => sum + (Number.isFinite(row.openPl) ? row.openPl : 0), 0),
      dayClosedPl: own.reduce((sum, row) => sum + (Number.isFinite(row.dayClosedPl) ? row.dayClosedPl : 0), 0),
      notional: Number.isFinite(notional) ? notional : 0,
      // D-059: both directions open on ONE instrument is the prohibited state.
      // Across different instruments it is not hedging and is expected.
      hedged: own.some((row) => row.quantity > 0) && own.some((row) => row.quantity < 0)
    });
  }

  const hedgedInstruments = Object.values(byInstrument).filter((entry) => entry.hedged).map((entry) => entry.instrument);
  if (hedgedInstruments.length > 0) {
    return Object.freeze({
      ok: false,
      error: `Opposing positions are open on the same instrument: ${hedgedInstruments.join(", ")}`,
      byInstrument: Object.freeze(byInstrument),
      openPositionsCount: active.length,
      hedgedInstruments: Object.freeze(hedgedInstruments)
    });
  }

  return Object.freeze({
    ok: true,
    error: null,
    byInstrument: Object.freeze(byInstrument),
    openPositionsCount: active.length,
    totalNotional: Object.values(byInstrument).reduce((sum, entry) => sum + entry.notional, 0)
  });
}

/**
 * D-060 replacement for trustedSignedNet(accountStatus).
 *
 * Returns the net for ONE instrument, or null when the book could not be read.
 * Null means "unknown", never "flat" — D-054. Callers must treat null as a reason
 * to block, not as zero.
 *
 * Back-compatible: called without an instrument it returns the single-instrument
 * signedNetUnits exactly as before.
 */
export function trustedSignedNetFor(accountStatus, instrument) {
  const snapshot = accountStatus?.snapshot ?? null;
  if (!snapshot || snapshot.positionsReadFailed === true) return null;

  if (instrument === undefined || instrument === null) {
    return Number.isFinite(snapshot.signedNetUnits) ? snapshot.signedNetUnits : null;
  }

  const table = snapshot.signedNetByInstrument;
  if (!table || typeof table !== "object") return null;
  const entry = table[instrument];
  if (!entry) {
    // The instrument is enabled and the book was read, but this instrument has no
    // position. That is a genuine flat, not an unknown.
    return snapshot.signedNetReadOk === true ? 0 : null;
  }
  return Number.isFinite(entry.netUnits) ? entry.netUnits : null;
}

export function netsMatchWithin(expected, actual, tolerance = NET_TOLERANCE) {
  return Number.isFinite(expected) && Number.isFinite(actual) && Math.abs(expected - actual) <= tolerance;
}

// Existing single-instrument callers retain the original unknown-versus-flat
// contract. Multi-instrument callers use trustedSignedNetFor above.
export function trustedSignedNet(accountStatus) {
  const snapshot = accountStatus?.snapshot ?? null;
  if (!snapshot || snapshot.positionsReadFailed === true) return null;
  if (!Number.isFinite(snapshot.signedNetUnits)) return null;
  return snapshot.signedNetUnits;
}

export function applyOpenPositionsOverlay(snapshot, payload, instrument = SOL_INSTRUMENT) {
  if (!snapshot || typeof snapshot !== "object") throw new TypeError("account snapshot is required");
  const overlay = signedNetFromOpenPositions(payload, instrument);
  const metricsNet = snapshot.instrumentPosition
    ? signedPositionQuantity(snapshot.instrumentPosition)
    : 0;
  const metricsCount = Number(snapshot.openPositionsCount ?? 0);
  const metricsEmpty = Math.abs(metricsNet) <= 1e-12 && metricsCount === 0;

  if (!overlay.ok) {
    return Object.freeze({
      ...snapshot,
      signedNetUnits: null,
      positionSource: "open-positions-invalid",
      overlayError: overlay.error,
      invariantError: overlay.error,
      accountLocked: true
    });
  }

  const useOverlay = metricsEmpty || !netsMatch(overlay.netUnits, metricsNet);
  if (!useOverlay) {
    return Object.freeze({
      ...snapshot,
      signedNetUnits: metricsNet,
      positionSource: "metrics"
    });
  }

  const instrumentPosition = overlay.instrumentPosition;
  const currentNotional = instrumentPosition
    ? Math.abs(instrumentPosition.quantity * instrumentPosition.markPrice)
    : 0;

  return Object.freeze({
    ...snapshot,
    openPositionsCount: overlay.openPositionsCount,
    instrumentPosition,
    currentNotional: Number.isFinite(currentNotional) ? currentNotional : 0,
    signedNetUnits: overlay.netUnits,
    invariantError: overlay.error,
    accountLocked: overlay.error != null,
    positionSource: "open-positions"
  });
}
