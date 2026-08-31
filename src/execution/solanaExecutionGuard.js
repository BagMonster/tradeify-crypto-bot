import { createHash } from "node:crypto";

const FINAL_NONFILL = ["REJECTED", "CANCELED", "EXPIRED", "PARTIAL", "FAILED"];
const LOT_STEP = 0.01;

function text(name, value, max = 128) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be non-empty`);
  const out = value.trim();
  if (out.length > max) throw new TypeError(`${name} is too long`);
  return out;
}

function positive(name, value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`${name} must be positive`);
  return n;
}

function fixed8(value) {
  return Number(value.toFixed(8));
}

function floorLot(value) {
  return fixed8(Math.floor((value + 1e-9) / LOT_STEP) * LOT_STEP);
}

function orderCode(intent) {
  const suffix = intent.type === "ENTRY" ? "E" : `X${intent.tranche}`;
  return `SOLGRID-${intent.stateVersion}-${intent.tag}-${suffix}`;
}

// Deterministic, format-agnostic per-leg order-code suffix. Derived from the broker
// position code so it is stable across retries and worker restarts, and stable even
// when other legs of the same protective action have already closed. Fixed 12-hex
// length keeps every derived order code inside the 64-character order-code limit
// regardless of how long the broker's position codes turn out to be.
function legSuffix(code) {
  return createHash("sha256").update(code).digest("hex").slice(0, 12);
}

function positionRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && Array.isArray(payload.positions)) return payload.positions;
  throw new Error("DXtrade open-positions response does not contain a positions array");
}

function positionSymbol(position) {
  return String(position?.symbol ?? position?.instrument ?? "").trim();
}

function positionQuantity(position) {
  const n = Number(position?.quantity ?? position?.qty);
  if (!Number.isFinite(n)) throw new Error("DXtrade SOL position quantity is invalid");
  return n;
}

function positionSide(position, quantity) {
  const raw = String(position?.side ?? position?.direction ?? "").toUpperCase();
  if (["SELL", "SHORT"].includes(raw)) return "SHORT";
  if (["BUY", "LONG"].includes(raw)) return "LONG";
  return quantity < 0 ? "SHORT" : "LONG";
}

function positionCode(position) {
  const code = position?.positionCode ?? position?.code ?? position?.id;
  return text("DXtrade position code", code == null ? "" : String(code), 128);
}

function compactDayKey(dayKey) {
  const key = text("dayKey", dayKey, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new TypeError("dayKey is invalid");
  return key.replaceAll("-", "");
}

function sameProtectiveOrder(row, { stateVersion, actionType, side, quantity, strategyId = "sol-outer-heavy-v1" }) {
  return row &&
    row.strategyId === strategyId &&
    row.instrument === "SOL/USD" &&
    row.stateVersion === stateVersion &&
    row.actionType === actionType &&
    row.side === side &&
    Math.abs(row.requestedQuantity - quantity) <= 1e-10;
}

// Distributes a requested aggregate cut quantity across the open broker legs in
// proportion to each leg's size, floored to the 0.01 SOL increment. Any shortfall
// created by flooring is redistributed one lot step at a time, largest-headroom
// first, with the position code breaking ties so the result is deterministic and
// reproducible after a restart.
function distributeCut(legs, requested) {
  const total = fixed8(legs.reduce((sum, leg) => sum + leg.quantity, 0));
  if (requested > total + 0.0050001) throw new Error("Protective cut quantity exceeds the total open SOL position");
  const target = Math.min(requested, total);

  const allocations = legs.map((leg) => ({
    leg,
    quantity: Math.min(floorLot(target * (leg.quantity / total)), leg.quantity)
  }));

  let shortfall = fixed8(target - allocations.reduce((sum, entry) => sum + entry.quantity, 0));
  const byHeadroom = [...allocations].sort((a, b) => {
    const diff = (b.leg.quantity - b.quantity) - (a.leg.quantity - a.quantity);
    if (Math.abs(diff) > 1e-12) return diff;
    return a.leg.positionCode < b.leg.positionCode ? -1 : 1;
  });

  let index = 0;
  while (shortfall >= LOT_STEP - 1e-9 && index < byHeadroom.length) {
    const entry = byHeadroom[index];
    if (fixed8(entry.leg.quantity - entry.quantity) >= LOT_STEP - 1e-9) {
      entry.quantity = fixed8(entry.quantity + LOT_STEP);
      shortfall = fixed8(shortfall - LOT_STEP);
      continue;
    }
    index += 1;
  }

  return allocations
    .filter((entry) => entry.quantity >= LOT_STEP - 1e-9)
    .map((entry) => Object.freeze({ ...entry.leg, cutQuantity: fixed8(entry.quantity) }));
}

function aggregateLegResults(results, orderCodes) {
  const filled = results.filter((result) => result.status === "FILLED");
  const failed = results.find((result) => result.status !== "FILLED");
  const filledQuantity = fixed8(filled.reduce((sum, result) => sum + (result.filledQuantity ?? 0), 0));
  const notional = filled.reduce((sum, result) => sum + (result.fillPrice ?? 0) * (result.filledQuantity ?? 0), 0);
  const filledAt = filled
    .map((result) => result.filledAt)
    .filter((value) => typeof value === "string")
    .sort()
    .at(-1) ?? null;

  return Object.freeze({
    status: failed ? failed.status : "FILLED",
    orderCode: orderCodes[0],
    orderCodes: Object.freeze([...orderCodes]),
    fillPrice: filledQuantity > 0 ? fixed8(notional / filledQuantity) : null,
    filledQuantity,
    filledAt,
    legs: Object.freeze(results.map((result) => Object.freeze({ ...result })))
  });
}
