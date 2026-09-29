// Broker-authoritative ticket recovery.
//
// This is deliberately separate from order-history absorption.  When a broker
// ticket snapshot remains unchanged for ten minutes, the broker is the source
// of truth for actual open inventory.  We rebuild virtual lots from those exact
// tickets; we never substitute an aggregate net position for a ticket list.

import { positionRows, positionSymbol, signedPositionQuantity } from "../account/dxtradeSignedNet.js";

const QUANTITY_TOLERANCE = 1e-8;

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function canonicalTime(value) {
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function brokerPositionCode(row) {
  return text(row?.positionCode ?? row?.code ?? row?.id);
}

function brokerEntryPrice(row) {
  return positive(row?.avgOpenPrice ?? row?.openPrice ?? row?.price ?? row?.averagePrice);
}

export function brokerTicketsFromOpenPositions(payload, instruments) {
  if (!Array.isArray(instruments) || instruments.length === 0) {
    throw new TypeError("broker rematch requires enabled instruments");
  }
  const enabled = new Set(instruments);
  const byInstrument = Object.fromEntries(instruments.map((instrument) => [instrument, []]));
  const codes = new Set();
  let failure = null;

  for (const row of positionRows(payload)) {
    const signedQuantity = signedPositionQuantity(row);
    if (Math.abs(signedQuantity) <= QUANTITY_TOLERANCE) continue;
    const instrument = positionSymbol(row);
    if (!enabled.has(instrument)) {
      failure = `DXtrade returned a position outside the enabled books: ${instrument || "unnamed instrument"}`;
      break;
    }
    const positionCode = brokerPositionCode(row);
    const entryPrice = brokerEntryPrice(row);
    if (positionCode === "") {
      failure = `${instrument} has an open DXtrade ticket without a positionCode`;
      break;
    }
    if (entryPrice === null) {
      failure = `${instrument} ticket ${positionCode} has no usable average open price`;
      break;
    }
    if (codes.has(positionCode)) {
      failure = `DXtrade returned duplicate positionCode ${positionCode}`;
      break;
    }
    codes.add(positionCode);
    byInstrument[instrument].push(Object.freeze({
      positionCode,
      side: signedQuantity > 0 ? "BUY" : "SELL",
      remainingUnits: Math.abs(signedQuantity),
      entryPrice,
      openedAt: canonicalTime(row?.openedAt ?? row?.openTime ?? row?.createdAt ?? row?.creationTime),
      raw: row
    }));
  }

  if (failure !== null) return Object.freeze({ ok: false, error: failure, byInstrument: null });
  for (const instrument of instruments) {
    const sides = new Set(byInstrument[instrument].map((ticket) => ticket.side));
    if (sides.size > 1) {
      return Object.freeze({
        ok: false,
        error: `${instrument} has opposing DXtrade tickets; automatic rematch is refused`,
        byInstrument: null
      });
    }
    byInstrument[instrument].sort((left, right) => left.positionCode.localeCompare(right.positionCode));
  }
  return Object.freeze({ ok: true, error: null, byInstrument: Object.freeze(byInstrument) });
}

export function virtualTickets(grid, state) {
  const normalized = grid.normalizeState(state);
  const rows = [];
  for (const ring of normalized.rings) for (const lot of ring.lots) {
    rows.push(Object.freeze({
      positionCode: lot.positionCode == null ? null : String(lot.positionCode),
      side: lot.side,
      remainingUnits: lot.remainingUnits,
      entryPrice: lot.entryPrice,
      scope: "RING",
      ringTag: ring.tag
    }));
  }
  for (const lot of normalized.adopted) {
    rows.push(Object.freeze({
      positionCode: String(lot.positionCode),
      side: lot.side,
      remainingUnits: lot.remainingUnits,
      entryPrice: lot.entryPrice,
      scope: "ADOPTED",
      ringTag: null
    }));
  }
  return Object.freeze(rows.sort((left, right) => String(left.positionCode).localeCompare(String(right.positionCode))));
}

export function ticketFingerprint(tickets) {
  return tickets
    .map((ticket) => `${ticket.positionCode ?? "<missing>"}|${ticket.side}|${Number(ticket.remainingUnits).toFixed(8)}`)
    .sort()
    .join(";");
}

export function ticketsMatch(virtual, broker) {
  if (virtual.length !== broker.length) return false;
  for (let index = 0; index < virtual.length; index += 1) {
    const left = virtual[index];
    const right = broker[index];
    if (left.positionCode === null || left.positionCode !== right.positionCode || left.side !== right.side) return false;
    if (Math.abs(Number(left.remainingUnits) - Number(right.remainingUnits)) > QUANTITY_TOLERANCE) return false;
  }
  return true;
}

function reportRow(instrument, outcome, details = {}) {
  return Object.freeze({ instrument, outcome, ...details });
}

/**
 * Observe every broker book once, and rematch any unchanged discrepancy whose
 * persisted observation window has reached minStableMs.  A caller must supply
 * a read that obtains one full, fresh DXtrade ticket snapshot.
 */
export async function runBrokerAuthoritativeRematchPass({
  books,
  readBrokerTickets,
  loadStability,
  observeStability,
  clearStability,
  now = () => Date.now(),
  minStableMs = 10 * 60 * 1000
}) {
  const entries = books instanceof Map ? [...books.entries()] : Object.entries(books ?? {});
  const instruments = entries.map(([instrument]) => instrument);
  const observedAtMs = Number(now());
  if (!Number.isFinite(observedAtMs)) throw new TypeError("broker rematch clock is invalid");
  const observedAt = new Date(observedAtMs).toISOString();
  const broker = await readBrokerTickets(instruments);
  if (!broker?.ok) {
    for (const [instrument] of entries) await clearStability(instrument);
    return Object.freeze({
      ok: false,
      verifiedAll: false,
      rematched: Object.freeze([]),
      rows: Object.freeze(entries.map(([instrument]) => reportRow(instrument, "UNREAD", { reason: broker?.error ?? "broker ticket read failed" })))
    });
  }

  const rows = [];
  const rematchCandidates = [];
  for (const [instrument, book] of entries) {
    let state;
    try {
      state = await book.stateStore.load();
    } catch (error) {
      await clearStability(instrument);
      rows.push(reportRow(instrument, "STATE_UNREAD", { reason: text(error?.message ?? error) }));
      continue;
    }
    if (!state) {
      await clearStability(instrument);
      rows.push(reportRow(instrument, "STATE_UNREAD", { reason: "grid state is missing" }));
      continue;
    }
    const virtual = virtualTickets(book.grid, state);
    const tickets = broker.byInstrument?.[instrument] ?? [];
    if (ticketsMatch(virtual, tickets)) {
      await clearStability(instrument);
      rows.push(reportRow(instrument, "MATCH", { virtual, tickets }));
      continue;
    }
    const fingerprint = `${ticketFingerprint(virtual)}=>${ticketFingerprint(tickets)}`;
    const stability = await observeStability({ instrument, fingerprint, observedAt });
    const stableSinceMs = Date.parse(stability?.firstObservedAt ?? observedAt);
    const stableForMs = Number.isFinite(stableSinceMs) ? Math.max(0, observedAtMs - stableSinceMs) : 0;
    if (stableForMs < minStableMs) {
      rows.push(reportRow(instrument, "WAITING", { virtual, tickets, stableForMs, remainingMs: minStableMs - stableForMs }));
      continue;
    }
    rematchCandidates.push({ instrument, book, state, tickets, virtual });
  }

  const rematched = [];
  for (const candidate of rematchCandidates) {
    const needsMovingAverage = candidate.tickets.some((ticket) => !candidate.virtual.some((lot) =>
      lot.positionCode === ticket.positionCode && lot.side === ticket.side
    ));
    let ma = null;
    if (needsMovingAverage) {
      try {
        ma = await (typeof candidate.book.movingAverage === "function" ? candidate.book.movingAverage() : candidate.book.movingAverage);
      } catch {
        ma = null;
      }
      if (!(Number(ma) > 0)) {
        rows.push(reportRow(candidate.instrument, "MA_UNREAD", { reason: "current completed-day moving average is unavailable" }));
        continue;
      }
    }
    try {
      const next = candidate.book.grid.rematchBrokerTickets(candidate.state, candidate.tickets, { movingAverage: Number(ma), observedAt });
      await candidate.book.stateStore.save(candidate.state.version, next);
      rematched.push(candidate.instrument);
      rows.push(reportRow(candidate.instrument, "REMATCHED", { tickets: candidate.tickets }));
    } catch (error) {
      rows.push(reportRow(candidate.instrument, "WRITE_FAILED", { reason: text(error?.message ?? error) }));
    }
  }

  if (rematched.length === 0) {
    return Object.freeze({ ok: true, verifiedAll: false, rematched: Object.freeze([]), rows: Object.freeze(rows) });
  }

  // A second DXtrade read is mandatory after writes.  The safety halt may only
  // be released when all five live ticket books agree with the rebuilt state.
  const confirmed = await readBrokerTickets(instruments);
  if (!confirmed?.ok) {
    return Object.freeze({ ok: false, verifiedAll: false, rematched: Object.freeze(rematched), rows: Object.freeze(rows) });
  }
  let verifiedAll = true;
  for (const [instrument, book] of entries) {
    const state = await book.stateStore.load();
    const exact = state !== null && ticketsMatch(virtualTickets(book.grid, state), confirmed.byInstrument?.[instrument] ?? []);
    if (!exact) verifiedAll = false;
    if (exact) await clearStability(instrument);
  }
  return Object.freeze({ ok: true, verifiedAll, rematched: Object.freeze(rematched), rows: Object.freeze(rows) });
}
