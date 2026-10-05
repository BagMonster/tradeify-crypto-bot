// Pure anchor-shift maths.  This deliberately knows nothing about DXtrade,
// PostgreSQL, or execution: a shift only changes the reference point used by
// the existing ring grid after the account-level coordinator proves flatness.

function positive(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`${name} must be positive`);
  return n;
}

function timestamp(value) {
  const text = typeof value === "string" ? value : new Date(value).toISOString();
  if (!Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) throw new TypeError("timestamp must be canonical UTC");
  return text;
}

export function firstOuterDistance(geometry) {
  const band = positive("geometry.band", geometry?.band);
  const dead = Number(geometry?.deadZoneBands);
  const inner = Number(geometry?.innerLevels);
  if (!Number.isInteger(dead) || dead < 0 || !Number.isInteger(inner) || inner < 0) throw new TypeError("geometry is invalid");
  return band * (dead + inner + 1);
}

export function outerBoundaries(anchor, geometry) {
  const base = positive("anchor", anchor);
  const band = positive("geometry.band", geometry?.band);
  const dead = Number(geometry?.deadZoneBands);
  const levels = Number(geometry?.activeLevelsPerSide);
  if (!Number.isInteger(dead) || dead < 0 || !Number.isInteger(levels) || levels < 1) throw new TypeError("geometry is invalid");
  const distance = band * (dead + levels);
  return Object.freeze({ upper: base * (1 + distance), lower: base * (1 - distance), distance });
}

export function initialAnchorShiftState() {
  return Object.freeze({
    multiplier: 1,
    upperExtreme: null,
    lowerExtreme: null,
    upperStartedAt: null,
    lowerStartedAt: null,
    upperBoundaryAtExtreme: null,
    lowerBoundaryAtExtreme: null,
    lastShiftAt: null,
    postShiftHigh: null,
    postShiftLow: null
  });
}

export function normalizeAnchorShiftState(input = {}) {
  const base = initialAnchorShiftState();
  const multiplier = positive("anchor multiplier", input.multiplier ?? base.multiplier);
  const numberOrNull = (name, value) => value == null ? null : positive(name, value);
  const timeOrNull = (value) => value == null ? null : timestamp(value);
  return Object.freeze({
    multiplier,
    upperExtreme: numberOrNull("upper extreme", input.upperExtreme),
    lowerExtreme: numberOrNull("lower extreme", input.lowerExtreme),
    upperStartedAt: timeOrNull(input.upperStartedAt),
    lowerStartedAt: timeOrNull(input.lowerStartedAt),
    upperBoundaryAtExtreme: numberOrNull("upper boundary", input.upperBoundaryAtExtreme),
    lowerBoundaryAtExtreme: numberOrNull("lower boundary", input.lowerBoundaryAtExtreme),
    lastShiftAt: timeOrNull(input.lastShiftAt),
    postShiftHigh: numberOrNull("post-shift high", input.postShiftHigh),
    postShiftLow: numberOrNull("post-shift low", input.postShiftLow)
  });
}

// A trade inside the span never clears an earlier excursion.  The caller may
// persist this result asynchronously; the returned value is complete state.
export function trackExcursion(input, { price, anchor, geometry, occurredAt }) {
  const state = normalizeAnchorShiftState(input);
  const px = positive("price", price);
  const at = timestamp(occurredAt);
  const boundaries = outerBoundaries(anchor, geometry);
  let next = { ...state };
  let startedSide = null;
  if (px > boundaries.upper) {
    if (state.upperExtreme === null) {
      next.upperStartedAt = at;
      startedSide = "UPPER";
    }
    if (state.upperExtreme === null || px > state.upperExtreme) {
      next.upperExtreme = px;
      next.upperBoundaryAtExtreme = boundaries.upper;
    }
  }
  if (px < boundaries.lower) {
    if (state.lowerExtreme === null && startedSide === null) startedSide = "LOWER";
    if (state.lowerExtreme === null) next.lowerStartedAt = at;
    if (state.lowerExtreme === null || px < state.lowerExtreme) {
      next.lowerExtreme = px;
      next.lowerBoundaryAtExtreme = boundaries.lower;
    }
  }
  // This feeds /anchorstats. It starts after a shift (or feature deployment)
  // and is intentionally independent of whether the price is in an excursion.
  next.postShiftHigh = next.postShiftHigh === null ? px : Math.max(next.postShiftHigh, px);
  next.postShiftLow = next.postShiftLow === null ? px : Math.min(next.postShiftLow, px);
  return Object.freeze({ state: normalizeAnchorShiftState(next), startedSide, boundaries });
}

function selectedExcursion(state) {
  const upper = state.upperExtreme === null ? null : (state.upperExtreme / state.upperBoundaryAtExtreme) - 1;
  const lower = state.lowerExtreme === null ? null : (state.lowerBoundaryAtExtreme / state.lowerExtreme) - 1;
  if (upper === null && lower === null) return null;
  if (lower === null || (upper !== null && upper >= lower)) return Object.freeze({ side: "UPPER", extreme: state.upperExtreme, startedAt: state.upperStartedAt, excess: upper });
  return Object.freeze({ side: "LOWER", extreme: state.lowerExtreme, startedAt: state.lowerStartedAt, excess: lower });
}

export function computeShift(input, { maNow, geometry, shiftedAt }) {
  const state = normalizeAnchorShiftState(input);
  const ma = positive("MA", maNow);
  const selected = selectedExcursion(state);
  if (selected === null) return null;
  const d = firstOuterDistance(geometry);
  const anchor = selected.side === "UPPER"
    ? selected.extreme / (1 + d)
    : selected.extreme / (1 - d);
  const multiplier = anchor / ma;
  const at = timestamp(shiftedAt);
  const next = normalizeAnchorShiftState({
    multiplier,
    lastShiftAt: at,
    postShiftHigh: null,
    postShiftLow: null
  });
  return Object.freeze({
    side: selected.side,
    extreme: selected.extreme,
    startedAt: selected.startedAt,
    excess: selected.excess,
    oldMultiplier: state.multiplier,
    multiplier,
    anchor,
    maNow: ma,
    firstOuterDistance: d,
    state: next
  });
}
