import { formatPrice } from "../format/price.js";
import { computeShift, firstOuterDistance, outerBoundaries } from "../strategies/anchorShift.js";

const utc = (value) => value ? new Date(value).toISOString().replace(".000Z", "Z") : "never";
const px = (value) => value == null ? "unavailable" : formatPrice(Number(value));
const multiplier = (value) => `×${Number(value).toFixed(4)}`;

function excursion(state, anchor, geometry) {
  const boundaries = outerBoundaries(anchor, geometry);
  const upper = state.upperExtreme === null ? null : { side: "UPPER", extreme: state.upperExtreme, startedAt: state.upperStartedAt, boundary: boundaries.upper };
  const lower = state.lowerExtreme === null ? null : { side: "LOWER", extreme: state.lowerExtreme, startedAt: state.lowerStartedAt, boundary: boundaries.lower };
  if (!upper && !lower) return null;
  if (!lower || (upper && ((upper.extreme / (state.upperBoundaryAtExtreme ?? upper.boundary)) - 1) >= ((state.lowerBoundaryAtExtreme ?? lower.boundary) / lower.extreme - 1))) return upper;
  return lower;
}

export function formatAnchorLine({ instrument, state, ma, price, geometry, historyCount = 0 }) {
  const anchor = ma * state.multiplier;
  const active = excursion(state, anchor, geometry);
  const suffix = active === null
    ? "excursion: none"
    : `excursion: ${active.side} since ${utc(active.startedAt)}, extreme ${px(active.extreme)} (${(((active.side === "UPPER" ? active.extreme / active.boundary : active.boundary / active.extreme) - 1) * 100).toFixed(1)}% past outer ring)`;
  return `${instrument}  ${multiplier(state.multiplier)}  anchor ${px(anchor)} (MA ${px(ma)})  ${suffix}  shifts: ${historyCount}${state.lastShiftAt ? ` (last ${utc(state.lastShiftAt)})` : ""}`;
}

export function formatAnchorDetail({ instrument, state, ma, price, geometry }) {
  const anchor = ma * state.multiplier;
  const boundaries = outerBoundaries(anchor, geometry);
  const dF = firstOuterDistance(geometry);
  const ringFUpper = anchor * (1 + dF);
  const ringFLower = anchor * (1 - dF);
  const firstBuy = anchor * (1 - geometry.band * (geometry.deadZoneBands + 1));
  const firstSell = anchor * (1 + geometry.band * (geometry.deadZoneBands + 1));
  const active = excursion(state, anchor, geometry);
  const lines = [
    `${instrument} ANCHOR DETAIL`,
    `200d MA: ${px(ma)} · multiplier: ${multiplier(state.multiplier)} · effective anchor: ${px(anchor)}`,
    `Outer boundaries: BUY ${px(boundaries.lower)} · SELL ${px(boundaries.upper)}`,
    `First outer ring (F=${geometry.innerLevels + 1}): BUY ${px(ringFLower)} · SELL ${px(ringFUpper)}`,
    `Ring 1: BUY ${px(firstBuy)} · SELL ${px(firstSell)}`,
    ""
  ];
  if (active === null) {
    lines.push("Excursion: none", "Projected shift: none — no recorded extreme.");
  } else {
    const currentPast = active.side === "UPPER" ? (price / boundaries.upper) - 1 : (boundaries.lower / price) - 1;
    const projection = computeShift(state, { maNow: ma, geometry, shiftedAt: new Date().toISOString() });
    lines.push(
      `Excursion: ${active.side} · extreme ${px(active.extreme)} since ${utc(active.startedAt)}`,
      `Current price: ${px(price)} (${(currentPast * 100).toFixed(2)}% ${currentPast >= 0 ? "past" : "inside"} outer boundary)`,
      `Projected shift if flat now: ${multiplier(projection.multiplier)} · anchor ${px(projection.anchor)}`,
      `Projected ring F: ${px(projection.anchor * (projection.side === "UPPER" ? 1 + dF : 1 - dF))} · ring 1 BUY ${px(projection.anchor * (1 - geometry.band * (geometry.deadZoneBands + 1)))} · SELL ${px(projection.anchor * (1 + geometry.band * (geometry.deadZoneBands + 1)))}`
    );
  }
  return lines.join("\n");
}

export function formatAnchorHistory(rows, instrument = null) {
  if (rows.length === 0) return instrument ? `${instrument} ANCHOR HISTORY\nNo shifts recorded.` : "ANCHOR HISTORY\nNo shifts recorded.";
  return [instrument ? `${instrument} ANCHOR HISTORY` : "ANCHOR HISTORY", ...rows.map((row) => row.source === "SAVED_STATE_WITHOUT_HISTORY"
    ? `${utc(row.shiftedAt)} · ${row.instrument} · RECONCILED SAVED STATE · saved multiplier ×${row.savedMultiplier} · recorded ${utc(row.reconciledAt)} · original side/extreme/MA/old multiplier unknown`
    : `${utc(row.shiftedAt)} · ${row.instrument} · ${row.side} · extreme ${px(row.extreme)} · MA ${px(row.maNow)} · ${multiplier(row.oldMultiplier)} → ${multiplier(row.newMultiplier)}`)].join("\n");
}

export function formatAnchorStats({ instrument, state, orders, gridState, price }) {
  const since = state.lastShiftAt ?? state.createdAt;
  const entries = orders.filter((row) => row.actionType === "ENTRY");
  const exits = orders.filter((row) => row.actionType === "EXIT");
  const entryByLot = new Map(entries.map((row) => [row.lotId, row]));
  let realised = 0;
  for (const row of exits) {
    const entry = entryByLot.get(row.lotId);
    if (!entry || !Number.isFinite(row.fillPrice) || !Number.isFinite(entry.fillPrice)) continue;
    const qty = Number(row.filledQuantity ?? 0);
    realised += entry.side === "BUY" ? (row.fillPrice - entry.fillPrice) * qty : (entry.fillPrice - row.fillPrice) * qty;
  }
  const lots = [...(gridState?.rings ?? []).flatMap((ring) => ring.lots ?? []), ...(gridState?.adopted ?? [])];
  const openPnl = lots.reduce((sum, lot) => sum + (lot.side === "BUY" ? price - lot.entryPrice : lot.entryPrice - price) * lot.remainingUnits, 0);
  return [
    `${instrument} ANCHOR STATS`,
    `Since: ${utc(since)}${state.lastShiftAt ? " (last shift)" : " (feature deployment)"}`,
    `Entries: ${entries.length} · exits: ${exits.length} · realised P&L: ${realised < 0 ? "-" : ""}$${Math.abs(realised).toFixed(2)}`,
    `Open lots: ${lots.length} · unrealised P&L now: ${openPnl < 0 ? "-" : ""}$${Math.abs(openPnl).toFixed(2)}`,
    `Price range since: low ${px(state.postShiftLow)} · high ${px(state.postShiftHigh)}`
  ].join("\n");
}
