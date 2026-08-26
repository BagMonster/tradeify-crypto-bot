import { expectedNetUnits, normalizeSolanaState } from "../strategies/solanaGrid.js";

export function resetVirtualInventoryToEmpty(state) {
  const normalized = normalizeSolanaState(state);
  return normalizeSolanaState({
    version: normalized.version + 1,
    strategyId: normalized.strategyId,
    instrument: normalized.instrument,
    rings: normalized.rings.map((ring) => ({
      ...ring,
      lots: [],
      armed: true
    })),
    lastFillAt: null,
    lastFillSide: null,
    lastFillPrice: null
  });
}

export function describeVirtualBook(state) {
  const normalized = normalizeSolanaState(state);
  const openLots = normalized.rings.reduce((n, ring) => n + ring.lots.length, 0);
  const occupied = normalized.rings.filter((ring) => ring.lots.length > 0).map((ring) => ring.tag);
  return Object.freeze({
    version: normalized.version,
    netUnits: expectedNetUnits(normalized),
    openLots,
    occupiedRings: occupied
  });
}
