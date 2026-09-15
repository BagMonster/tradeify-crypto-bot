/**
 * src/strategies/ringGridDefinition.js
 *
 * D-060: ring geometry derived from per-instrument config rather than module
 * constants. Import into ringGrid.js; the strategy logic is unchanged.
 *
 * Ring placement, unchanged from solanaGrid.js:
 *   distance(level) = bandPct * (deadZoneBands + level)      level 1..activeLevelsPerSide
 *   size(level)     = baseUsd * growth^(level-1)             level 1 = innermost
 *
 * baseUsd is DERIVED, never configured. It is chosen so a fully built active
 * side of the instrument equals the instrument's cap. BUY and SELL have the
 * same sizing, but only one side may carry inventory at a time.
 *
 *   unitGross = sum over l = 1..levels of capacity(l) * growth^(l-1)
 *   baseUsd   = capUsd / unitGross
 *
 * This is why the cap is the meaningful number: it is the gross virtual exposure
 * with every permitted lot on the active side filled.
 */

const REQUIRED_GEOMETRY = Object.freeze([
  "maDays", "bandPct", "deadZoneBands", "activeLevelsPerSide", "growth", "rearmBands"
]);

function requirePositive(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`${name} must be a positive number`);
  return n;
}

function requireNonNegativeInteger(name, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return n;
}

export function unitGross(growth, levels, capacityForLevel = () => 1) {
  let total = 0;
  for (let level = 1; level <= levels; level += 1) total += capacityForLevel(level) * (growth ** (level - 1));
  return total;
}

export function buildRingLadder({ bandPct, deadZoneBands, activeLevelsPerSide, growth, baseUsd }) {
  const rings = [];
  for (let level = 1; level <= activeLevelsPerSide; level += 1) {
    const magnitude = bandPct * (deadZoneBands + level);
    const usd = baseUsd * (growth ** (level - 1));
    for (const side of ["BUY", "SELL"]) {
      rings.push(Object.freeze({
        tag: `${side}${level}`,
        side,
        level,
        distance: side === "BUY" ? -magnitude : magnitude,
        usd
      }));
    }
  }
  // BUY1, SELL1, BUY2, SELL2 ... preserves the scan order solanaGrid.js relies on
  return Object.freeze(rings);
}

/**
 * @param {object} cfg  one entry from config/instruments.json
 * @param {number} [referencePrice]  latest price, used only to check that the
 *   innermost ring can buy at least one minimum lot. Pass the live price when
 *   validating at startup; omit for a pure geometry description.
 */
export function buildGridDefinition(cfg, referencePrice = null) {
  if (!cfg || typeof cfg !== "object") throw new TypeError("instrument config is required");
  const instrument = String(cfg.instrument ?? "").trim();
  const marketSymbol = String(cfg.marketSymbol ?? "").trim();
  const orderPrefix = String(cfg.orderPrefix ?? "").trim();
  if (!instrument || !marketSymbol || !orderPrefix) {
    throw new TypeError("instrument, marketSymbol and orderPrefix are required");
  }
  if (!/^[A-Z0-9]+$/.test(orderPrefix)) throw new TypeError(`orderPrefix "${orderPrefix}" must be A-Z0-9`);

  const g = cfg.geometry ?? {};
  for (const field of REQUIRED_GEOMETRY) {
    if (g[field] === undefined) throw new TypeError(`${instrument}: geometry.${field} is missing`);
  }
  const maDays = requireNonNegativeInteger(`${instrument} geometry.maDays`, g.maDays);
  const bandPct = requirePositive(`${instrument} geometry.bandPct`, g.bandPct);
  const deadZoneBands = requireNonNegativeInteger(`${instrument} geometry.deadZoneBands`, g.deadZoneBands);
  const activeLevelsPerSide = requireNonNegativeInteger(`${instrument} geometry.activeLevelsPerSide`, g.activeLevelsPerSide);
  const growth = requirePositive(`${instrument} geometry.growth`, g.growth);
  const legacyPositionsPerRing = g.positionsPerRing == null
    ? null
    : requireNonNegativeInteger(`${instrument} geometry.positionsPerRing`, g.positionsPerRing);
  const innerLevels = g.innerLevels == null
    ? 0
    : requireNonNegativeInteger(`${instrument} geometry.innerLevels`, g.innerLevels);
  if (innerLevels >= activeLevelsPerSide) throw new Error(`${instrument}: geometry.innerLevels must be below activeLevelsPerSide`);
  const innerPositionsPerRing = g.innerPositionsPerRing == null
    ? (legacyPositionsPerRing ?? 1)
    : requireNonNegativeInteger(`${instrument} geometry.innerPositionsPerRing`, g.innerPositionsPerRing);
  const outerPositionsPerRing = g.outerPositionsPerRing == null
    ? (legacyPositionsPerRing ?? innerPositionsPerRing)
    : requireNonNegativeInteger(`${instrument} geometry.outerPositionsPerRing`, g.outerPositionsPerRing);
  if (innerPositionsPerRing < 1 || outerPositionsPerRing < 1) throw new Error(`${instrument}: ring capacity must be at least one`);
  const rearmBands = requirePositive(`${instrument} geometry.rearmBands`, g.rearmBands);
  if (activeLevelsPerSide < 1) throw new TypeError(`${instrument}: activeLevelsPerSide must be at least 1`);
  if (growth < 1) throw new TypeError(`${instrument}: growth below 1 would make outer rings smaller than inner ones`);

  const s = cfg.sizing ?? {};
  const capUsd = requirePositive(`${instrument} sizing.capUsd`, s.capUsd);
  const lotStep = requirePositive(`${instrument} sizing.lotStep`, s.lotStep);
  const roundTripCostFloorPct = requirePositive(`${instrument} sizing.roundTripCostFloorPct`, s.roundTripCostFloorPct);

  const t = cfg.tranches ?? {};
  const trancheWeights = Array.isArray(t.weights) ? Object.freeze([...t.weights]) : Object.freeze([1, 2, 3, 4]);
  const trancheDenominator = requirePositive(`${instrument} tranches.denominator`, t.denominator ?? 10);
  if (trancheWeights.reduce((a, b) => a + b, 0) !== trancheDenominator) {
    throw new TypeError(`${instrument}: tranche weights must sum to the denominator`);
  }

  const capacityForLevel = (level) => level <= innerLevels ? innerPositionsPerRing : outerPositionsPerRing;
  const unit = unitGross(growth, activeLevelsPerSide, capacityForLevel);
  const baseUsd = capUsd / unit;
  const rings = buildRingLadder({ bandPct, deadZoneBands, activeLevelsPerSide, growth, baseUsd });
  const innermostDistance = bandPct * (deadZoneBands + 1);
  const outermostDistance = bandPct * (deadZoneBands + activeLevelsPerSide);
  const innermostRingUsd = baseUsd;
  const outermostRingUsd = baseUsd * (growth ** (activeLevelsPerSide - 1));

  const definition = Object.freeze({
    strategyId: `${orderPrefix.toLowerCase()}-ring-grid-v1`,
    instrument,
    marketSymbol,
    orderPrefix,
    anchor: `${maDays}-day-simple-moving-average-completed-utc-daily-closes`,
    maDays,
    band: bandPct,
    deadZoneBands,
    activeLevelsPerSide,
    levels: activeLevelsPerSide,
    baseUsd,
    growth,
    perRing: Math.max(innerPositionsPerRing, outerPositionsPerRing),
    innerLevels,
    innerPositionsPerRing,
    outerPositionsPerRing,
    capacityForLevel,
    rearmBands,
    lotStep,
    trancheWeights,
    trancheDenominator,
    roundTripCostFloor: roundTripCostFloorPct,
    grossExposureCeilingUsd: capUsd,
    capUsd,
    innermostDistance,
    outermostDistance,
    innermostRingUsd,
    outermostRingUsd,
    referencePrice,
    rings,
    liveSemantics: "live-touch-exits-before-entries"
  });

  // Startup guard: if one minimum lot at the current price costs more than the
  // innermost ring, that ring can never fill and the geometry does not fit.
  if (Number.isFinite(referencePrice) && referencePrice > 0) {
    const minLotNotional = lotStep * referencePrice;
    if (minLotNotional > innermostRingUsd) {
      throw new Error(
        `${instrument}: minimum lot ${lotStep} at ${referencePrice} costs $${minLotNotional.toFixed(2)}, ` +
        `above the innermost ring of $${innermostRingUsd.toFixed(2)}. Geometry does not fit this instrument.`
      );
    }
  }

  return definition;
}
