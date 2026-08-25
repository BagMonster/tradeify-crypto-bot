const STRATEGY_ID = "sol-outer-heavy-v1";
const INSTRUMENT = "SOL/USD";
const MARKET_SYMBOL = "SOLUSDT";
const BAND = 0.045;
const DEAD_ZONE_BANDS = 2;
const ACTIVE_LEVELS = 10;
const BASE_USD = 28.68;
const GROWTH = 1.5;
const PER_RING = 2;
const REARM_BANDS = 0.5;
const LOT_STEP = 0.01;
const ROUND_TRIP_COST_FLOOR = 0.0018;
const GROSS_EXPOSURE_CEILING_USD = 6600;
const TRANCHE_WEIGHTS = Object.freeze([1, 2, 3, 4]);
const TRANCHE_WEIGHT_SUM = 10;

function positive(name, value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`${name} must be a positive finite number`);
  return n;
}

function nonNegative(name, value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) throw new TypeError(`${name} must be a non-negative finite number`);
  return n;
}

function nonNegativeInteger(name, value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function canonicalUtc(name, value) {
  if (typeof value !== "string") throw new TypeError(`${name} must be a canonical UTC timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new TypeError(`${name} must be a canonical UTC timestamp`);
  }
  return value;
}

function floorLot(units) {
  const n = positive("units", units);
  return Math.floor((n + 1e-12) / LOT_STEP) * LOT_STEP;
}

function floorLotOrZero(units) {
  const n = nonNegative("units", units);
  if (n < LOT_STEP) return 0;
  return Math.floor((n + 1e-12) / LOT_STEP) * LOT_STEP;
}

function fixed8(value) {
  return Number(Number(value).toFixed(8));
}

function ringUsd(level) {
  return BASE_USD * (GROWTH ** (level - 1));
}

function ringDistance(level, side) {
  const bands = DEAD_ZONE_BANDS + level;
  const magnitude = BAND * bands;
  return side === "BUY" ? -magnitude : magnitude;
}

function ringLevel(ma, ring) {
  return positive("ma", ma) * (1 + ring.distance);
}

function cloneLot(lot) {
  const originalUnits = positive("lot.originalUnits", lot.originalUnits);
  const remainingUnits = positive("lot.remainingUnits", lot.remainingUnits);
  if (remainingUnits > originalUnits + 1e-8) throw new TypeError("lot.remainingUnits cannot exceed lot.originalUnits");
  return {
    id: String(lot.id),
    side: lot.side,
    ringTag: lot.ringTag,
    entryPrice: positive("lot.entryPrice", lot.entryPrice),
    originalUnits,
    remainingUnits,
    done: nonNegativeInteger("lot.done", lot.done),
    openedAt: canonicalUtc("lot.openedAt", lot.openedAt)
  };
}

function normalizeRing(ring) {
  if (!ring || typeof ring !== "object" || Array.isArray(ring)) throw new TypeError("ring must be an object");
  if (ring.side !== "BUY" && ring.side !== "SELL") throw new TypeError("ring.side must be BUY or SELL");
  const level = nonNegativeInteger("ring.level", ring.level);
  if (level < 1 || level > ACTIVE_LEVELS) throw new TypeError("ring.level is invalid");
  const expectedTag = `${ring.side}${level}`;
  if (ring.tag !== expectedTag) throw new TypeError("ring.tag does not match side/level");
  const lots = Array.isArray(ring.lots) ? ring.lots.map(cloneLot) : [];
  if (lots.length > PER_RING) throw new TypeError("ring exceeds per-ring virtual-lot capacity");
  return {
    tag: expectedTag,
    side: ring.side,
    level,
    distance: ringDistance(level, ring.side),
    usd: ringUsd(level),
    armed: ring.armed === true,
    lots
  };
}

function buildRings() {
  const rings = [];
  for (let level = 1; level <= ACTIVE_LEVELS; level += 1) {
    rings.push(normalizeRing({ tag: `BUY${level}`, side: "BUY", level, armed: true, lots: [] }));
    rings.push(normalizeRing({ tag: `SELL${level}`, side: "SELL", level, armed: true, lots: [] }));
  }
  return rings;
}

export const GRID_DEFINITION = Object.freeze({
  strategyId: STRATEGY_ID,
  instrument: INSTRUMENT,
  marketSymbol: MARKET_SYMBOL,
  anchor: "200-day-simple-moving-average-completed-utc-daily-closes",
  band: BAND,
  deadZoneBands: DEAD_ZONE_BANDS,
  activeLevelsPerSide: ACTIVE_LEVELS,
  baseUsd: BASE_USD,
  growth: GROWTH,
  perRing: PER_RING,
  rearmBands: REARM_BANDS,
  lotStep: LOT_STEP,
  trancheWeights: TRANCHE_WEIGHTS,
  roundTripCostFloor: ROUND_TRIP_COST_FLOOR,
  grossExposureCeilingUsd: GROSS_EXPOSURE_CEILING_USD,
  liveSemantics: "live-touch-exits-before-entries"
});

export function createInitialSolanaState() {
  return Object.freeze({
    version: 0,
    strategyId: STRATEGY_ID,
    instrument: INSTRUMENT,
    rings: Object.freeze(buildRings().map((ring) => Object.freeze({ ...ring, lots: Object.freeze([]) }))),
    lastFillAt: null,
    lastFillSide: null,
    lastFillPrice: null
  });
}

export function normalizeSolanaState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("SOL grid state must be an object");
  const version = nonNegativeInteger("state.version", input.version);
  if (input.strategyId !== STRATEGY_ID || input.instrument !== INSTRUMENT) {
    throw new TypeError("SOL grid state identity is invalid");
  }
  if (!Array.isArray(input.rings) || input.rings.length !== ACTIVE_LEVELS * 2) {
    throw new TypeError("SOL grid state must contain exactly 20 rings");
  }
  const rings = input.rings.map(normalizeRing);
  const expected = buildRings().map((ring) => ring.tag);
  if (rings.some((ring, index) => ring.tag !== expected[index])) throw new TypeError("SOL grid ring order is invalid");

  const hasFill = input.lastFillAt != null || input.lastFillSide != null || input.lastFillPrice != null;
  let lastFillAt = null;
  let lastFillSide = null;
  let lastFillPrice = null;
  if (hasFill) {
    lastFillAt = canonicalUtc("state.lastFillAt", input.lastFillAt);
    if (!["BUY", "SELL", "PROTECTIVE_FLAT", "PROTECTIVE_CUT"].includes(input.lastFillSide)) {
      throw new TypeError("state.lastFillSide is invalid");
    }
    lastFillSide = input.lastFillSide;
    lastFillPrice = positive("state.lastFillPrice", input.lastFillPrice);
  }

  return Object.freeze({
    version,
    strategyId: STRATEGY_ID,
    instrument: INSTRUMENT,
    rings: Object.freeze(rings.map((ring) => Object.freeze({ ...ring, lots: Object.freeze(ring.lots.map(Object.freeze)) }))),
    lastFillAt,
    lastFillSide,
    lastFillPrice
  });
}

function mutableState(state) {
  const normalized = normalizeSolanaState(state);
  return {
    ...normalized,
    rings: normalized.rings.map((ring) => ({ ...ring, lots: ring.lots.map((lot) => ({ ...lot })) }))
  };
}

function freezeNext(state) {
  return normalizeSolanaState(state);
}

function withVersionIncrement(state) {
  state.version += 1;
  return freezeNext(state);
}

export function expectedNetUnits(state) {
  const normalized = normalizeSolanaState(state);
  return fixed8(normalized.rings.reduce((sum, ring) => sum + ring.lots.reduce(
    (ringSum, lot) => ringSum + (lot.side === "BUY" ? lot.remainingUnits : -lot.remainingUnits),
    0
  ), 0));
}

export function grossVirtualExposureUsd(state, markPrice) {
  const normalized = normalizeSolanaState(state);
  const px = positive("markPrice", markPrice);
  return normalized.rings.reduce((sum, ring) => sum + ring.lots.reduce(
    (ringSum, lot) => ringSum + (lot.remainingUnits * px),
    0
  ), 0);
}

export function observeRearm(state, { price, ma }) {
  const px = positive("price", price);
  const movingAverage = positive("ma", ma);
  const next = mutableState(state);
  const away = movingAverage * BAND * REARM_BANDS;
  let changed = false;

  for (const ring of next.rings) {
    if (ring.armed || ring.lots.length >= PER_RING) continue;
    const level = ringLevel(movingAverage, ring);
    if (Math.abs(px - level) + 1e-12 >= away) {
      ring.armed = true;
      changed = true;
    }
  }

  return changed ? withVersionIncrement(next) : normalizeSolanaState(state);
}

function trancheTarget(lot, tranche, ma) {
  const movingAverage = positive("ma", ma);
  let target = lot.entryPrice + ((movingAverage - lot.entryPrice) * (tranche / 4));
  if (lot.side === "BUY") target = Math.max(target, lot.entryPrice * (1 + ROUND_TRIP_COST_FLOOR));
  else target = Math.min(target, lot.entryPrice * (1 - ROUND_TRIP_COST_FLOOR));
  return target;
}

function trancheUnits(lot, tranche) {
  if (tranche === 4) return lot.remainingUnits;
  return Math.min(lot.remainingUnits, floorLot(lot.originalUnits * (TRANCHE_WEIGHTS[tranche - 1] / TRANCHE_WEIGHT_SUM)));
}

export function nextExitAction(state, { price, ma }) {
  const normalized = normalizeSolanaState(state);
  const px = positive("price", price);
  const movingAverage = positive("ma", ma);

  for (const ring of normalized.rings) {
    for (let lotIndex = 0; lotIndex < ring.lots.length; lotIndex += 1) {
      const lot = ring.lots[lotIndex];
      const tranche = lot.done + 1;
      if (tranche > 4) continue;
      const target = trancheTarget(lot, tranche, movingAverage);
      const touched = lot.side === "BUY" ? px >= target : px <= target;
      if (!touched) continue;
      const units = trancheUnits(lot, tranche);
      if (tranche < 4 && units < LOT_STEP - 1e-12) {
        return Object.freeze({ type: "SKIP_EXIT", ringTag: ring.tag, lotId: lot.id, tranche, target });
      }
      return Object.freeze({
        type: "EXIT",
        strategyId: STRATEGY_ID,
        source: "binance",
        symbol: MARKET_SYMBOL,
        tag: ring.tag,
        ringTag: ring.tag,
        lotId: lot.id,
        tranche,
        side: lot.side === "BUY" ? "SELL" : "BUY",
        virtualSide: lot.side,
        quantity: fixed8(units),
        observedPrice: px,
        target,
        ma: movingAverage,
        stateVersion: normalized.version
      });
    }
  }
  return null;
}

export function applySkippedExit(state, action) {
  if (action?.type !== "SKIP_EXIT") throw new TypeError("action must be SKIP_EXIT");
  const next = mutableState(state);
  const ring = next.rings.find((candidate) => candidate.tag === action.ringTag);
  const lot = ring?.lots.find((candidate) => candidate.id === action.lotId);
  if (!lot || lot.done + 1 !== action.tranche || action.tranche >= 4) {
    throw new Error("skipped exit no longer matches SOL grid state");
  }
  lot.done = action.tranche;
  return withVersionIncrement(next);
}

export function entryCandidates(state, { previousPrice, price, ma }) {
  const normalized = normalizeSolanaState(state);
  const prior = previousPrice == null ? null : positive("previousPrice", previousPrice);
  const px = positive("price", price);
  const movingAverage = positive("ma", ma);
  if (prior == null || prior === px) return Object.freeze([]);

  const out = [];
  for (const ring of normalized.rings) {
    if (!ring.armed || ring.lots.length >= PER_RING) continue;
    const level = ringLevel(movingAverage, ring);
    const crossed = (prior < level && px >= level) || (prior > level && px <= level) || px === level;
    if (!crossed) continue;
    const quantity = floorLot(ring.usd / px);
    if (quantity < LOT_STEP - 1e-12) continue;
    out.push(Object.freeze({
      type: "ENTRY",
      strategyId: STRATEGY_ID,
      source: "binance",
      symbol: MARKET_SYMBOL,
      tag: ring.tag,
      ringTag: ring.tag,
      side: ring.side,
      virtualSide: ring.side,
      usd: ring.usd,
      quantity: fixed8(quantity),
      observedPrice: px,
      ringLevel: level,
      ma: movingAverage,
      stateVersion: normalized.version,
      lotId: `${ring.tag}-V${normalized.version}`
    }));
  }
  return Object.freeze(out);
}

function confirmedFill(fill, requestedQuantity) {
  if (!fill || typeof fill !== "object" || Array.isArray(fill)) throw new TypeError("confirmed fill must be an object");
  const fillPrice = positive("fill.fillPrice", fill.fillPrice);
  const filledAt = canonicalUtc("fill.filledAt", fill.filledAt);
  const filledQuantity = positive("fill.filledQuantity", fill.filledQuantity ?? requestedQuantity);
  if (Math.abs(filledQuantity - requestedQuantity) > Math.max(1e-8, requestedQuantity * 1e-6)) {
    throw new Error("confirmed SOL fill quantity does not match requested quantity");
  }
  return { fillPrice, filledAt, filledQuantity: fixed8(filledQuantity) };
}

export function applyConfirmedEntry(state, intent, fill) {
  if (intent?.type !== "ENTRY") throw new TypeError("intent must be ENTRY");
  const next = mutableState(state);
  if (intent.stateVersion !== next.version) throw new Error("entry intent state version is stale");
  const ring = next.rings.find((candidate) => candidate.tag === intent.ringTag);
  if (!ring || !ring.armed || ring.lots.length >= PER_RING) throw new Error("entry ring is no longer available");
  const confirmed = confirmedFill(fill, intent.quantity);
  ring.lots.push({
    id: intent.lotId,
    side: ring.side,
    ringTag: ring.tag,
    entryPrice: confirmed.fillPrice,
    originalUnits: confirmed.filledQuantity,
    remainingUnits: confirmed.filledQuantity,
    done: 0,
    openedAt: confirmed.filledAt
  });
  ring.armed = false;
  next.lastFillAt = confirmed.filledAt;
  next.lastFillSide = intent.side;
  next.lastFillPrice = confirmed.fillPrice;
  return withVersionIncrement(next);
}

export function applyConfirmedExit(state, intent, fill) {
  if (intent?.type !== "EXIT") throw new TypeError("intent must be EXIT");
  const next = mutableState(state);
  if (intent.stateVersion !== next.version) throw new Error("exit intent state version is stale");
  const ring = next.rings.find((candidate) => candidate.tag === intent.ringTag);
  const lotIndex = ring?.lots.findIndex((candidate) => candidate.id === intent.lotId) ?? -1;
  if (!ring || lotIndex < 0) throw new Error("exit lot no longer exists");
  const lot = ring.lots[lotIndex];
  if (lot.done + 1 !== intent.tranche) throw new Error("exit tranche no longer matches lot state");
  const confirmed = confirmedFill(fill, intent.quantity);
  lot.remainingUnits = fixed8(lot.remainingUnits - confirmed.filledQuantity);
  lot.done = intent.tranche;
  if (lot.remainingUnits <= 1e-8) ring.lots.splice(lotIndex, 1);
  if (ring.lots.length === 0) ring.armed = true;
  next.lastFillAt = confirmed.filledAt;
  next.lastFillSide = intent.side;
  next.lastFillPrice = confirmed.fillPrice;
  return withVersionIncrement(next);
}

export function buildProtectiveCutPlan(state, fraction) {
  const normalized = normalizeSolanaState(state);
  const cutFraction = positive("fraction", fraction);
  if (cutFraction >= 1) throw new TypeError("fraction must be less than 1");
  const legs = [];
  let virtualSide = null;

  for (const ring of normalized.rings) {
    for (const lot of ring.lots) {
      if (virtualSide !== null && virtualSide !== lot.side) {
        throw new Error("D-049 protective partial cut requires all open virtual lots to share one side");
      }
      virtualSide = lot.side;
      const quantity = fixed8(floorLotOrZero(lot.remainingUnits * cutFraction));
      if (quantity < LOT_STEP - 1e-12) continue;
      legs.push(Object.freeze({ lotId: lot.id, ringTag: ring.tag, side: lot.side, quantity }));
    }
  }

  const quantity = fixed8(legs.reduce((sum, leg) => sum + leg.quantity, 0));
  return Object.freeze({
    type: "PROTECTIVE_CUT",
    strategyId: STRATEGY_ID,
    instrument: INSTRUMENT,
    stateVersion: normalized.version,
    fraction: cutFraction,
    virtualSide,
    side: virtualSide === "BUY" ? "SELL" : virtualSide === "SELL" ? "BUY" : null,
    quantity,
    legs: Object.freeze(legs)
  });
}

export function applyConfirmedProtectiveCut(state, plan, fill) {
  if (plan?.type !== "PROTECTIVE_CUT") throw new TypeError("plan must be PROTECTIVE_CUT");
  const next = mutableState(state);
  if (plan.stateVersion !== next.version) throw new Error("protective cut plan state version is stale");
  if (!Array.isArray(plan.legs) || plan.legs.length === 0 || plan.quantity < LOT_STEP - 1e-12) {
    throw new Error("protective cut plan has no executable quantity");
  }
  const confirmed = confirmedFill(fill, plan.quantity);

  for (const leg of plan.legs) {
    const ring = next.rings.find((candidate) => candidate.tag === leg.ringTag);
    const lotIndex = ring?.lots.findIndex((candidate) => candidate.id === leg.lotId) ?? -1;
    if (!ring || lotIndex < 0) throw new Error("protective cut lot no longer exists");
    const lot = ring.lots[lotIndex];
    const quantity = positive("protective cut leg quantity", leg.quantity);
    if (quantity > lot.remainingUnits + 1e-8 || quantity > lot.originalUnits + 1e-8) {
      throw new Error("protective cut quantity exceeds virtual lot quantity");
    }
    lot.remainingUnits = fixed8(lot.remainingUnits - quantity);
    lot.originalUnits = fixed8(lot.originalUnits - quantity);
    if (lot.remainingUnits <= 1e-8 || lot.originalUnits <= 1e-8) ring.lots.splice(lotIndex, 1);
    if (ring.lots.length === 0) ring.armed = true;
  }

  next.lastFillAt = confirmed.filledAt;
  next.lastFillSide = "PROTECTIVE_CUT";
  next.lastFillPrice = confirmed.fillPrice;
  return withVersionIncrement(next);
}

export function resetAfterProtectiveFlatten(state, fill) {
  const next = mutableState(state);
  for (const ring of next.rings) {
    ring.lots = [];
    ring.armed = true;
  }
  next.lastFillAt = canonicalUtc("fill.filledAt", fill.filledAt);
  next.lastFillSide = "PROTECTIVE_FLAT";
  next.lastFillPrice = positive("fill.fillPrice", fill.fillPrice);
  return withVersionIncrement(next);
}
