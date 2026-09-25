import { buildGridDefinition } from "./ringGridDefinition.js";

// D-060 parameterised form of the SOL outer-heavy grid. Every mutable grid has a
// separate factory instance; no state or geometry is shared between instruments.

function positive(name, value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`${name} must be a positive finite number`);
  return n;
}

function integer(name, value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name} must be an integer >= ${minimum}`);
  return value;
}

function timestamp(name, value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${name} must be a canonical UTC timestamp`);
  }
  return value;
}

function fixed8(value) {
  return Number(Number(value).toFixed(8));
}

function definitionFrom(config) {
  if (config?.rings && config?.instrument && config?.strategyId) {
    const legacyPerRing = Number(config.perRing ?? config.positionsPerRing ?? 1);
    const capacityForLevel = typeof config.capacityForLevel === "function"
      ? config.capacityForLevel
      : () => legacyPerRing;
    return Object.freeze({
      ...config,
      trancheWeightSum: config.trancheWeightSum ?? config.trancheDenominator,
      roundTripCostFloor: config.roundTripCostFloor,
      grossExposureCeilingUsd: config.grossExposureCeilingUsd ?? config.capUsd,
      capacityForLevel
    });
  }
  const derived = buildGridDefinition(config);
  return Object.freeze({
    ...derived,
    strategyId: String(config.strategyId ?? derived.strategyId),
    trancheWeightSum: derived.trancheDenominator,
    roundTripCostFloor: derived.roundTripCostFloorPct ?? derived.roundTripCostFloor,
    grossExposureCeilingUsd: derived.grossExposureCeilingUsd ?? derived.capUsd
  });

  if (!config || typeof config !== "object" || Array.isArray(config)) throw new TypeError("ring grid config must be an object");
  const strategyId = String(config.strategyId ?? "multi-asset-ring-grid-v1").trim();
  const instrument = String(config.instrument ?? "").trim();
  const marketSymbol = String(config.marketSymbol ?? "").trim();
  const orderPrefix = String(config.orderPrefix ?? "").trim();
  if (!strategyId || !/^[A-Za-z0-9._-]{1,128}$/.test(strategyId)) throw new TypeError("strategyId is invalid");
  if (!/^[A-Z0-9]+\/[A-Z]+$/.test(instrument)) throw new TypeError("instrument is invalid");
  if (!/^[A-Z0-9]{5,20}$/.test(marketSymbol)) throw new TypeError("marketSymbol is invalid");
  if (!/^[A-Z0-9]{2,12}$/.test(orderPrefix)) throw new TypeError("orderPrefix is invalid");
  const geometry = config.geometry;
  const sizing = config.sizing;
  const tranches = config.tranches;
  if (!geometry || !sizing || !tranches) throw new TypeError("ring grid geometry, sizing, and tranches are required");
  const band = positive("geometry.bandPct", geometry.bandPct);
  const deadZoneBands = integer("geometry.deadZoneBands", geometry.deadZoneBands);
  const activeLevelsPerSide = integer("geometry.activeLevelsPerSide", geometry.activeLevelsPerSide, 1);
  const growth = positive("geometry.growth", geometry.growth);
  const perRing = integer("geometry.positionsPerRing", geometry.positionsPerRing, 1);
  const rearmBands = positive("geometry.rearmBands", geometry.rearmBands);
  const lotStep = positive("sizing.lotStep", sizing.lotStep);
  const capUsd = positive("sizing.capUsd", sizing.capUsd);
  const roundTripCostFloor = positive("sizing.roundTripCostFloorPct", sizing.roundTripCostFloorPct);
  if (!Array.isArray(tranches.weights) || tranches.weights.length !== 4) throw new TypeError("tranches.weights must have four values");
  const trancheWeights = tranches.weights.map((value, index) => integer(`tranches.weights[${index}]`, value, 1));
  const trancheWeightSum = integer("tranches.denominator", tranches.denominator, 1);
  if (trancheWeights.reduce((sum, value) => sum + value, 0) !== trancheWeightSum) throw new TypeError("tranche denominator must equal weight sum");
  let unitGross = 0;
  for (let level = 1; level <= activeLevelsPerSide; level += 1) unitGross += 2 * (growth ** (level - 1));
  return Object.freeze({ strategyId, instrument, marketSymbol, orderPrefix, anchor: "200-day-simple-moving-average-completed-utc-daily-closes", band, deadZoneBands, activeLevelsPerSide, baseUsd: capUsd / unitGross, growth, perRing, rearmBands, lotStep, trancheWeights: Object.freeze(trancheWeights), trancheWeightSum, roundTripCostFloor, grossExposureCeilingUsd: capUsd, liveSemantics: "live-touch-exits-before-entries" });
}

export function createRingGrid(config) {
  const def = definitionFrom(config);
  const floorLot = (value) => fixed8(Math.floor((positive("units", value) + 1e-12) / def.lotStep) * def.lotStep);
  const floorLotOrZero = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new TypeError("units must be non-negative");
    return n < def.lotStep ? 0 : fixed8(Math.floor((n + 1e-12) / def.lotStep) * def.lotStep);
  };
  const ringUsd = (level) => def.baseUsd * (def.growth ** (level - 1));
  const capacityForLevel = (level) => integer("ring capacity", Number(def.capacityForLevel?.(level) ?? def.perRing), 1);
  const ringDistance = (level, side) => (side === "BUY" ? -1 : 1) * def.band * (def.deadZoneBands + level);
  const ringPrice = (ma, ring) => positive("ma", ma) * (1 + ring.distance);

  function cloneLot(lot) {
    const originalUnits = positive("lot.originalUnits", lot.originalUnits);
    const remainingUnits = positive("lot.remainingUnits", lot.remainingUnits);
    if (remainingUnits > originalUnits + 1e-8) throw new TypeError("lot remaining units exceed original units");
    const done = integer("lot.done", lot.done);
    const normalExitTranches = integer("lot.normalExitTranches", lot.normalExitTranches ?? done);
    if (normalExitTranches > done) throw new TypeError("lot normal exits exceed completed tranches");
    const intendedUnits = lot.intendedUnits == null ? null : positive("lot.intendedUnits", lot.intendedUnits);
    return { id: String(lot.id), side: lot.side, ringTag: lot.ringTag, entryPrice: positive("lot.entryPrice", lot.entryPrice), originalUnits, intendedUnits, remainingUnits, done, normalExitTranches, openedAt: timestamp("lot.openedAt", lot.openedAt), positionCode: lot.positionCode == null || String(lot.positionCode).trim() === "" ? null : String(lot.positionCode) };
  }

  function cloneAdoptedLot(lot) {
    if (!lot || typeof lot !== "object" || !["BUY", "SELL"].includes(lot.side)) throw new TypeError("adopted lot side is invalid");
    const originalUnits = positive("adopted.originalUnits", lot.originalUnits);
    const remainingUnits = positive("adopted.remainingUnits", lot.remainingUnits);
    if (remainingUnits > originalUnits + 1e-8) throw new TypeError("adopted lot remaining units exceed original units");
    const positionCode = lot.positionCode == null || String(lot.positionCode).trim() === "" ? null : String(lot.positionCode);
    if (positionCode === null) throw new TypeError("adopted lot requires a broker positionCode");
    return { id: String(lot.id), side: lot.side, ringTag: null, adopted: true, positionCode, entryPrice: positive("adopted.entryPrice", lot.entryPrice), originalUnits, remainingUnits, done: integer("adopted.done", lot.done), openedAt: timestamp("adopted.openedAt", lot.openedAt), ma: positive("adopted.ma", lot.ma) };
  }

  function buildRings() {
    const rings = [];
    for (let level = 1; level <= def.activeLevelsPerSide; level += 1) {
      for (const side of ["BUY", "SELL"]) rings.push({ tag: `${side}${level}`, side, level, distance: ringDistance(level, side), usd: ringUsd(level), capacity: capacityForLevel(level), armed: true, lots: [] });
    }
    return rings;
  }

  function normalizeRing(ring) {
    if (!ring || typeof ring !== "object" || !["BUY", "SELL"].includes(ring.side)) throw new TypeError("ring side is invalid");
    const level = integer("ring.level", ring.level, 1);
    if (level > def.activeLevelsPerSide || ring.tag !== `${ring.side}${level}`) throw new TypeError("ring identity is invalid");
    const lots = Array.isArray(ring.lots) ? ring.lots.map(cloneLot) : [];
    if (lots.length > def.perRing) throw new TypeError("ring exceeds virtual-lot capacity");
    return { tag: ring.tag, side: ring.side, level, distance: ringDistance(level, ring.side), usd: ringUsd(level), capacity: capacityForLevel(level), armed: ring.armed === true, lots };
  }

  function normalizeState(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("grid state must be an object");
    if (input.strategyId !== def.strategyId || input.instrument !== def.instrument) throw new TypeError("grid state identity is invalid");
    const version = integer("state.version", input.version);
    if (!Array.isArray(input.rings) || input.rings.length !== def.activeLevelsPerSide * 2) throw new TypeError("grid state ring count is invalid");
    const rings = input.rings.map(normalizeRing);
    const expected = buildRings().map((ring) => ring.tag);
    if (rings.some((ring, index) => ring.tag !== expected[index])) throw new TypeError("grid state ring order is invalid");
    const hasFill = input.lastFillAt != null || input.lastFillSide != null || input.lastFillPrice != null;
    const lastFillAt = hasFill ? timestamp("state.lastFillAt", input.lastFillAt) : null;
    const lastFillSide = hasFill ? String(input.lastFillSide) : null;
    const lastFillPrice = hasFill ? positive("state.lastFillPrice", input.lastFillPrice) : null;
    if (hasFill && !["BUY", "SELL", "PROTECTIVE_FLAT", "PROTECTIVE_CUT"].includes(lastFillSide)) throw new TypeError("state.lastFillSide is invalid");
    const adopted = Array.isArray(input.adopted) ? input.adopted.map(cloneAdoptedLot) : [];
    const adoptedIds = new Set(adopted.map((lot) => lot.positionCode));
    if (adoptedIds.size !== adopted.length) throw new TypeError("adopted lots must have unique positionCodes");
    return Object.freeze({ version, strategyId: def.strategyId, instrument: def.instrument, rings: Object.freeze(rings.map((ring) => Object.freeze({ ...ring, lots: Object.freeze(ring.lots.map(Object.freeze)) }))), adopted: Object.freeze(adopted.map(Object.freeze)), lastFillAt, lastFillSide, lastFillPrice });
  }

  function mutable(state) {
    const normalized = normalizeState(state);
    return { ...normalized, rings: normalized.rings.map((ring) => ({ ...ring, lots: ring.lots.map((lot) => ({ ...lot })) })), adopted: normalized.adopted.map((lot) => ({ ...lot })) };
  }
  function increment(state) { state.version += 1; return normalizeState(state); }
  function validatedFill(fill, quantity) {
    const fillPrice = positive("fill.fillPrice", fill?.fillPrice);
    const filledAt = timestamp("fill.filledAt", fill?.filledAt);
    const filledQuantity = positive("fill.filledQuantity", fill?.filledQuantity ?? quantity);
    if (Math.abs(filledQuantity - quantity) > Math.max(1e-8, quantity * 1e-6)) throw new Error("confirmed fill quantity does not match request");
    const positionCode = fill?.positionCode == null || String(fill.positionCode).trim() === "" ? null : String(fill.positionCode);
    return { fillPrice, filledAt, filledQuantity: fixed8(filledQuantity), positionCode };
  }

  function createInitialState() { return normalizeState({ version: 0, strategyId: def.strategyId, instrument: def.instrument, rings: buildRings(), adopted: [], lastFillAt: null, lastFillSide: null, lastFillPrice: null }); }
  function expectedNetUnits(state) { const normalized = normalizeState(state); const ringUnits = normalized.rings.reduce((sum, ring) => sum + ring.lots.reduce((total, lot) => total + (lot.side === "BUY" ? lot.remainingUnits : -lot.remainingUnits), 0), 0); const adoptedUnits = normalized.adopted.reduce((total, lot) => total + (lot.side === "BUY" ? lot.remainingUnits : -lot.remainingUnits), 0); return fixed8(ringUnits + adoptedUnits); }
  function grossVirtualExposureUsd(state, markPrice) { const px = positive("markPrice", markPrice); const normalized = normalizeState(state); const ringUsd = normalized.rings.reduce((sum, ring) => sum + ring.lots.reduce((total, lot) => total + lot.remainingUnits * px, 0), 0); const adoptedUsd = normalized.adopted.reduce((total, lot) => total + lot.remainingUnits * px, 0); return ringUsd + adoptedUsd; }
  function adoptedExposureUsd(state, markPrice) { const px = positive("markPrice", markPrice); return normalizeState(state).adopted.reduce((total, lot) => total + lot.remainingUnits * px, 0); }
  function entryGateAllows(normalized, ring) {
    // A manual/adopted position is exit-only itself, but it does not freeze
    // the normal same-side ring strategy. It still prevents a directional
    // flip while that manual inventory remains open.
    if (normalized.adopted.some((lot) => lot.side !== ring.side)) return false;
    // One instrument may never carry both directional books.
    if (normalized.rings.some((candidate) => candidate.side !== ring.side && candidate.lots.length > 0)) return false;
    // Inner single-fill rings wait on every deeper same-side lot. Outer
    // two-fill rings start their gate two levels deeper and continue outward.
    const levelOffset = ring.capacity === 1 ? 1 : 2;
    const controllingLots = normalized.rings
      .filter((candidate) => candidate.side === ring.side && candidate.level >= ring.level + levelOffset)
      .flatMap((candidate) => candidate.lots);
    return controllingLots.every((lot) => lot.normalExitTranches >= 1);
  }
  function observeRearm(state, { price, ma }) {
    const next = mutable(state); const px = positive("price", price); const away = positive("ma", ma) * def.band * def.rearmBands; let changed = false;
    const normalized = normalizeState(next);
    for (const ring of next.rings) if (!ring.armed && ring.lots.length < ring.capacity && Math.abs(px - ringPrice(ma, ring)) + 1e-12 >= away && entryGateAllows(normalized, ring)) { ring.armed = true; changed = true; }
    return changed ? increment(next) : normalizeState(state);
  }
  function nextMovingAverageExitAction(state, { price, ma }) {
    const normalized = normalizeState(state); const px = positive("price", price); const movingAverage = positive("ma", ma);
    const atOrPastMa = (lot) => lot.side === "BUY" ? px >= movingAverage : px <= movingAverage;
    const ringPair = normalized.rings
      .slice()
      .sort((left, right) => right.level - left.level)
      .flatMap((ring) => ring.lots.map((lot) => ({ ring, lot })))
      .find(({ lot }) => atOrPastMa(lot));
    if (ringPair) {
      const { ring, lot } = ringPair;
      return Object.freeze({ type: "EXIT", forcedAtMovingAverage: true, strategyId: def.strategyId, instrument: def.instrument, source: "binance", symbol: def.marketSymbol, tag: ring.tag, ringTag: ring.tag, lotId: lot.id, tranche: lot.done + 1, side: lot.side === "BUY" ? "SELL" : "BUY", virtualSide: lot.side, quantity: fixed8(lot.remainingUnits), observedPrice: px, target: movingAverage, ma: movingAverage, stateVersion: normalized.version, adopted: false, positionCode: lot.positionCode ?? null, excludePositionCodes: Object.freeze(normalized.adopted.map((candidate) => candidate.positionCode)) });
    }
    const adopted = normalized.adopted.find(atOrPastMa);
    if (!adopted) return null;
    return Object.freeze({ type: "EXIT", forcedAtMovingAverage: true, strategyId: def.strategyId, instrument: def.instrument, source: "binance", symbol: def.marketSymbol, tag: "ADOPTED", ringTag: null, lotId: adopted.id, tranche: adopted.done + 1, side: adopted.side === "BUY" ? "SELL" : "BUY", virtualSide: adopted.side, quantity: fixed8(adopted.remainingUnits), observedPrice: px, target: movingAverage, ma: movingAverage, stateVersion: normalized.version, adopted: true, positionCode: adopted.positionCode, excludePositionCodes: Object.freeze([]) });
  }
  function nextExitAction(state, { price, ma }) {
    const normalized = normalizeState(state); const px = positive("price", price); const movingAverage = positive("ma", ma);
    const adoptedCodes = Object.freeze(normalized.adopted.map((lot) => lot.positionCode));
    for (const ring of normalized.rings) for (const lot of ring.lots) {
      const tranche = lot.done + 1; if (tranche > 4) continue;
      let target = lot.entryPrice + ((movingAverage - lot.entryPrice) * (tranche / 4));
      target = lot.side === "BUY" ? Math.max(target, lot.entryPrice * (1 + def.roundTripCostFloor)) : Math.min(target, lot.entryPrice * (1 - def.roundTripCostFloor));
      if (!(lot.side === "BUY" ? px >= target : px <= target)) continue;
      const quantity = tranche === 4 ? lot.remainingUnits : Math.min(lot.remainingUnits, floorLot(lot.originalUnits * (def.trancheWeights[tranche - 1] / def.trancheWeightSum)));
      if (tranche < 4 && quantity < def.lotStep - 1e-12) return Object.freeze({ type: "SKIP_EXIT", ringTag: ring.tag, lotId: lot.id, tranche, target });
      return Object.freeze({ type: "EXIT", strategyId: def.strategyId, instrument: def.instrument, source: "binance", symbol: def.marketSymbol, tag: ring.tag, ringTag: ring.tag, lotId: lot.id, tranche, side: lot.side === "BUY" ? "SELL" : "BUY", virtualSide: lot.side, quantity: fixed8(quantity), observedPrice: px, target, ma: movingAverage, stateVersion: normalized.version, adopted: false, positionCode: lot.positionCode ?? null, excludePositionCodes: adoptedCodes });
    }
    for (const lot of normalized.adopted) {
      const tranche = lot.done + 1; if (tranche > 4) continue;
      let target = lot.entryPrice + ((lot.ma - lot.entryPrice) * (tranche / 4));
      target = lot.side === "BUY" ? Math.max(target, lot.entryPrice * (1 + def.roundTripCostFloor)) : Math.min(target, lot.entryPrice * (1 - def.roundTripCostFloor));
      if (!(lot.side === "BUY" ? px >= target : px <= target)) continue;
      const quantity = tranche === 4 ? lot.remainingUnits : Math.min(lot.remainingUnits, floorLot(lot.originalUnits * (def.trancheWeights[tranche - 1] / def.trancheWeightSum)));
      if (tranche < 4 && quantity < def.lotStep - 1e-12) return Object.freeze({ type: "SKIP_EXIT", ringTag: null, adopted: true, lotId: lot.id, tranche, target });
      return Object.freeze({ type: "EXIT", strategyId: def.strategyId, instrument: def.instrument, source: "binance", symbol: def.marketSymbol, tag: "ADOPTED", ringTag: null, lotId: lot.id, tranche, side: lot.side === "BUY" ? "SELL" : "BUY", virtualSide: lot.side, quantity: fixed8(quantity), observedPrice: px, target, ma: lot.ma, stateVersion: normalized.version, adopted: true, positionCode: lot.positionCode, excludePositionCodes: Object.freeze([]) });
    }
    return null;
  }
  function applySkippedExit(state, action) {
    if (action?.type !== "SKIP_EXIT") throw new TypeError("action must be SKIP_EXIT"); const next = mutable(state);
    if (action.adopted === true) { const lot = next.adopted.find((candidate) => candidate.id === action.lotId); if (!lot || lot.done + 1 !== action.tranche || action.tranche >= 4) throw new Error("skipped exit no longer matches state"); lot.done = action.tranche; return increment(next); }
    const ring = next.rings.find((candidate) => candidate.tag === action.ringTag); const lot = ring?.lots.find((candidate) => candidate.id === action.lotId);
    if (!lot || lot.done + 1 !== action.tranche || action.tranche >= 4) throw new Error("skipped exit no longer matches state"); lot.done = action.tranche; return increment(next);
  }
  function entryCandidates(state, { previousPrice, price, ma }) {
    const normalized = normalizeState(state); const prior = previousPrice == null ? null : positive("previousPrice", previousPrice); const px = positive("price", price); const movingAverage = positive("ma", ma); if (prior == null || prior === px) return Object.freeze([]); const out = [];
    for (const ring of normalized.rings) { if (!ring.armed || ring.lots.length >= ring.capacity || !entryGateAllows(normalized, ring)) continue; const level = ringPrice(movingAverage, ring); const crossed = (prior < level && px >= level) || (prior > level && px <= level) || px === level; if (!crossed) continue; const quantity = floorLot(ring.usd / px); if (quantity < def.lotStep - 1e-12) continue; out.push(Object.freeze({ type: "ENTRY", strategyId: def.strategyId, instrument: def.instrument, source: "binance", symbol: def.marketSymbol, tag: ring.tag, ringTag: ring.tag, side: ring.side, virtualSide: ring.side, usd: ring.usd, quantity, observedPrice: px, ringLevel: level, ma: movingAverage, stateVersion: normalized.version, lotId: `${ring.tag}-V${normalized.version}` })); }
    return Object.freeze(out);
  }
  // Protective cuts intentionally shrink originalUnits because the remaining
  // tranche plan must shrink too. For dust, use the immutable entry intent when
  // present, and derive legacy intent from the ring's USD allocation instead.
  // Manual/adopted inventory and unmatchable broker tickets are excluded here.
  function dustCleanupCandidates(state, { openedBeforeMs, maxRemainingFraction }) {
    const normalized = normalizeState(state);
    const cutoff = Number(openedBeforeMs);
    const fraction = Number(maxRemainingFraction);
    if (!Number.isFinite(cutoff)) throw new TypeError("openedBeforeMs is invalid");
    if (!(fraction > 0 && fraction <= 1)) throw new TypeError("maxRemainingFraction is invalid");
    const candidates = [];
    for (const ring of normalized.rings) for (const lot of ring.lots) {
      if (lot.positionCode === null || Date.parse(lot.openedAt) >= cutoff) continue;
      const intendedUnits = lot.intendedUnits ?? floorLotOrZero(ring.usd / lot.entryPrice);
      if (intendedUnits < def.lotStep - 1e-12) continue;
      const remainingFraction = lot.remainingUnits / intendedUnits;
      if (remainingFraction > fraction + 1e-10) continue;
      candidates.push(Object.freeze({ lotId: lot.id, ringTag: ring.tag, virtualSide: lot.side, positionCode: lot.positionCode, entryPrice: lot.entryPrice, remainingUnits: lot.remainingUnits, intendedUnits, remainingFraction, openedAt: lot.openedAt }));
    }
    return Object.freeze(candidates);
  }
  function applyConfirmedEntry(state, intent, fill) {
    if (intent?.type !== "ENTRY") throw new TypeError("intent must be ENTRY"); const next = mutable(state); if (intent.stateVersion !== next.version) throw new Error("entry intent state version is stale"); const ring = next.rings.find((candidate) => candidate.tag === intent.ringTag); if (!ring || !ring.armed || ring.lots.length >= ring.capacity || !entryGateAllows(normalizeState(next), ring)) throw new Error("entry ring is unavailable"); const confirmed = validatedFill(fill, intent.quantity); ring.lots.push({ id: intent.lotId, side: ring.side, ringTag: ring.tag, entryPrice: confirmed.fillPrice, originalUnits: confirmed.filledQuantity, intendedUnits: intent.quantity, remainingUnits: confirmed.filledQuantity, done: 0, normalExitTranches: 0, openedAt: confirmed.filledAt, positionCode: confirmed.positionCode ?? null }); ring.armed = false; next.lastFillAt = confirmed.filledAt; next.lastFillSide = intent.side; next.lastFillPrice = confirmed.fillPrice; return increment(next);
  }
  function applyConfirmedExit(state, intent, fill) {
    if (intent?.type !== "EXIT") throw new TypeError("intent must be EXIT"); const next = mutable(state); if (intent.stateVersion !== next.version) throw new Error("exit intent state version is stale");
    if (intent.adopted === true) { const index = next.adopted.findIndex((candidate) => candidate.id === intent.lotId); if (index < 0) throw new Error("exit lot does not exist"); const lot = next.adopted[index]; if (lot.done + 1 !== intent.tranche) throw new Error("exit tranche does not match"); const confirmed = validatedFill(fill, intent.quantity); lot.remainingUnits = fixed8(lot.remainingUnits - confirmed.filledQuantity); lot.done = intent.tranche; if (lot.remainingUnits <= 1e-8) next.adopted.splice(index, 1); next.lastFillAt = confirmed.filledAt; next.lastFillSide = intent.side; next.lastFillPrice = confirmed.fillPrice; return increment(next); }
    const ring = next.rings.find((candidate) => candidate.tag === intent.ringTag); const index = ring?.lots.findIndex((candidate) => candidate.id === intent.lotId) ?? -1; if (!ring || index < 0) throw new Error("exit lot does not exist"); const lot = ring.lots[index]; if (lot.done + 1 !== intent.tranche) throw new Error("exit tranche does not match"); const confirmed = validatedFill(fill, intent.quantity); lot.remainingUnits = fixed8(lot.remainingUnits - confirmed.filledQuantity); lot.done = intent.tranche; if (intent.forcedAtMovingAverage !== true) lot.normalExitTranches = Math.max(lot.normalExitTranches, intent.tranche); if (lot.remainingUnits <= 1e-8) ring.lots.splice(index, 1); if (ring.lots.length === 0) ring.armed = true; next.lastFillAt = confirmed.filledAt; next.lastFillSide = intent.side; next.lastFillPrice = confirmed.fillPrice; return increment(next);
  }
  function buildProtectiveCutPlan(state, fraction) {
    const normalized = normalizeState(state); const cutFraction = positive("fraction", fraction); if (cutFraction >= 1) throw new TypeError("fraction must be less than one"); const legs = []; let virtualSide = null;
    for (const ring of normalized.rings) for (const lot of ring.lots) { if (virtualSide !== null && virtualSide !== lot.side) throw new Error("protective partial cut requires all virtual lots to share one side"); virtualSide = lot.side; const quantity = floorLotOrZero(lot.remainingUnits * cutFraction); if (quantity >= def.lotStep - 1e-12) legs.push(Object.freeze({ lotId: lot.id, ringTag: ring.tag, side: lot.side, quantity })); }
    for (const lot of normalized.adopted) { if (virtualSide !== null && virtualSide !== lot.side) throw new Error("protective partial cut requires all virtual lots to share one side"); virtualSide = lot.side; const quantity = floorLotOrZero(lot.remainingUnits * cutFraction); if (quantity >= def.lotStep - 1e-12) legs.push(Object.freeze({ lotId: lot.id, ringTag: null, adopted: true, positionCode: lot.positionCode, side: lot.side, quantity })); }
    const quantity = fixed8(legs.reduce((sum, leg) => sum + leg.quantity, 0)); return Object.freeze({ type: "PROTECTIVE_CUT", strategyId: def.strategyId, instrument: def.instrument, stateVersion: normalized.version, fraction: cutFraction, virtualSide, side: virtualSide === "BUY" ? "SELL" : virtualSide === "SELL" ? "BUY" : null, quantity, legs: Object.freeze(legs) });
  }
  function applyConfirmedProtectiveCut(state, plan, fill) {
    if (plan?.type !== "PROTECTIVE_CUT") throw new TypeError("plan must be PROTECTIVE_CUT"); const next = mutable(state); if (plan.stateVersion !== next.version || !plan.legs?.length || plan.quantity < def.lotStep) throw new Error("protective cut plan is invalid or stale"); const confirmed = validatedFill(fill, plan.quantity); for (const leg of plan.legs) { if (leg.adopted === true) { const index = next.adopted.findIndex((candidate) => candidate.id === leg.lotId); if (index < 0) throw new Error("protective cut adopted lot does not exist"); const lot = next.adopted[index]; if (leg.quantity > lot.remainingUnits + 1e-8) throw new Error("protective cut quantity exceeds adopted lot"); lot.remainingUnits = fixed8(lot.remainingUnits - leg.quantity); lot.originalUnits = fixed8(lot.originalUnits - leg.quantity); if (lot.remainingUnits <= 1e-8) next.adopted.splice(index, 1); continue; } const ring = next.rings.find((candidate) => candidate.tag === leg.ringTag); const index = ring?.lots.findIndex((candidate) => candidate.id === leg.lotId) ?? -1; if (!ring || index < 0) throw new Error("protective cut lot does not exist"); const lot = ring.lots[index]; if (leg.quantity > lot.remainingUnits + 1e-8) throw new Error("protective cut quantity exceeds virtual lot"); lot.remainingUnits = fixed8(lot.remainingUnits - leg.quantity); lot.originalUnits = fixed8(lot.originalUnits - leg.quantity); if (lot.remainingUnits <= 1e-8) ring.lots.splice(index, 1); if (ring.lots.length === 0) ring.armed = true; } next.lastFillAt = confirmed.filledAt; next.lastFillSide = "PROTECTIVE_CUT"; next.lastFillPrice = confirmed.fillPrice; return increment(next);
  }
  function resetAfterProtectiveFlatten(state, fill) { const next = mutable(state); for (const ring of next.rings) { ring.lots = []; ring.armed = true; } next.adopted = []; next.lastFillAt = timestamp("fill.filledAt", fill?.filledAt); next.lastFillSide = "PROTECTIVE_FLAT"; next.lastFillPrice = positive("fill.fillPrice", fill?.fillPrice); return increment(next); }

  function adoptPosition(state, record) {
    const next = mutable(state);
    const candidate = cloneAdoptedLot({ ...record, id: record?.id ?? `ADOPT-${record?.positionCode}`, done: record?.done ?? 0 });
    if (next.adopted.some((lot) => lot.positionCode === candidate.positionCode)) throw new Error("position is already adopted");
    if (next.rings.some((ring) => ring.lots.some((lot) => lot.positionCode === candidate.positionCode))) throw new Error("position already belongs to a ring lot");
    next.adopted.push(candidate);
    next.lastFillAt = candidate.openedAt;
    next.lastFillSide = candidate.side;
    next.lastFillPrice = candidate.entryPrice;
    return increment(next);
  }

  function findLotByPositionCode(state, code) {
    const normalized = normalizeState(state);
    const wanted = String(code);
    for (const ring of normalized.rings) for (const lot of ring.lots) if (lot.positionCode === wanted) return Object.freeze({ scope: "RING", ringTag: ring.tag, lot });
    for (const lot of normalized.adopted) if (lot.positionCode === wanted) return Object.freeze({ scope: "ADOPTED", ringTag: null, lot });
    return null;
  }

  function reduceLotByPositionCode(state, code, units, fallbackSide = null) {
    const next = mutable(state);
    const wanted = String(code);
    const reduction = positive("units", units);
    const adoptedIndex = next.adopted.findIndex((lot) => lot.positionCode === wanted);
    if (adoptedIndex >= 0) {
      const lot = next.adopted[adoptedIndex];
      if (reduction > lot.remainingUnits + 1e-8) throw new Error("reduction exceeds adopted lot remaining units");
      lot.remainingUnits = fixed8(lot.remainingUnits - reduction);
      if (lot.remainingUnits <= 1e-8) next.adopted.splice(adoptedIndex, 1);
      return increment(next);
    }
    for (const ring of next.rings) {
      const index = ring.lots.findIndex((lot) => lot.positionCode === wanted);
      if (index < 0) continue;
      const lot = ring.lots[index];
      if (reduction > lot.remainingUnits + 1e-8) throw new Error("reduction exceeds virtual lot remaining units");
      lot.remainingUnits = fixed8(lot.remainingUnits - reduction);
      if (lot.remainingUnits <= 1e-8) { ring.lots.splice(index, 1); ring.armed = true; }
      return increment(next);
    }
    // Lots opened before positionCode was recorded carry null and cannot be
    // matched by broker id. Reduce those oldest-first on the named side rather
    // than stranding the book until every legacy lot has cycled out.
    if (fallbackSide === "BUY" || fallbackSide === "SELL") {
      const legacy = [];
      for (const ring of next.rings) for (const lot of ring.lots) {
        if (lot.side === fallbackSide && (lot.positionCode === null || lot.positionCode === undefined)) legacy.push({ ring, lot });
      }
      legacy.sort((a, b) => Date.parse(a.lot.openedAt) - Date.parse(b.lot.openedAt));
      const available = legacy.reduce((sum, entry) => sum + entry.lot.remainingUnits, 0);
      if (available + 1e-8 >= reduction) {
        let outstanding = reduction;
        for (const entry of legacy) {
          if (outstanding <= 1e-8) break;
          const take = Math.min(entry.lot.remainingUnits, outstanding);
          entry.lot.remainingUnits = fixed8(entry.lot.remainingUnits - take);
          outstanding = fixed8(outstanding - take);
          if (entry.lot.remainingUnits <= 1e-8) {
            const index = entry.ring.lots.indexOf(entry.lot);
            if (index >= 0) entry.ring.lots.splice(index, 1);
            if (entry.ring.lots.length === 0) entry.ring.armed = true;
          }
        }
        return increment(next);
      }
    }
    throw new Error("no virtual or adopted lot carries that positionCode");
  }

  return Object.freeze({ definition: def, createInitialState, normalizeState, expectedNetUnits, grossVirtualExposureUsd, adoptedExposureUsd, observeRearm, nextMovingAverageExitAction, nextExitAction, applySkippedExit, entryCandidates, dustCleanupCandidates, applyConfirmedEntry, applyConfirmedExit, buildProtectiveCutPlan, applyConfirmedProtectiveCut, resetAfterProtectiveFlatten, adoptPosition, findLotByPositionCode, reduceLotByPositionCode });
}
