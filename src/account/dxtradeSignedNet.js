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
  if (typeof payload === "object" && Array.isArray(payload.positions)) return payload.positions;
  throw new Error("DXtrade open-positions response does not contain a positions array");
}

export function netsMatch(expected, actual) {
  return Number.isFinite(expected) && Number.isFinite(actual) && Math.abs(expected - actual) <= NET_TOLERANCE;
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
  if (instrumentRows.length > 1) {
    return Object.freeze({
      ok: false,
      error: "More than one open position exists on the Tradeify account",
      netUnits: null,
      openPositionsCount: active.length,
      instrumentPosition: null
    });
  }

  const row = instrumentRows[0] ?? null;
  return Object.freeze({
    ok: true,
    error: null,
    netUnits: row ? row.quantity : 0,
    openPositionsCount: active.length,
    instrumentPosition: row
      ? Object.freeze({
        symbol: row.symbol,
        quantity: row.quantity,
        markPrice: Number.isFinite(row.markPrice) ? row.markPrice : 0,
        openPl: Number.isFinite(row.openPl) ? row.openPl : 0,
        dayClosedPl: Number.isFinite(row.dayClosedPl) ? row.dayClosedPl : 0,
        avgOpenPrice: Number.isFinite(row.avgOpenPrice) ? row.avgOpenPrice : 0
      })
      : null
  });
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
