import { readFile } from "node:fs/promises";
import { getSupportedInstrumentProfile } from "../instrumentProfile.js";

const REQUIRED_RISK_FIELDS = Object.freeze([
  "entryBrakeUsd",
  "entryBrakeScope",
  "partialCutUsd",
  "partialCutFraction",
  "partialCutAllocation",
  "fullFlattenUsd",
  "flattenHoldsUntilRollover",
  "dailyLossLimitUsd",
  "rolloverHourUtc"
]);

function object(name, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

function text(name, value, pattern = null) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
  const out = value.trim();
  if (pattern && !pattern.test(out)) throw new Error(`${name} is invalid`);
  return out;
}

function positive(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
  return value;
}

function integer(name, value, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return value;
}

function unitGross(levels, growth) {
  let total = 0;
  for (let level = 1; level <= levels; level += 1) total += 2 * (growth ** (level - 1));
  return total;
}

function validateInstrument(input, index, seenPrefixes) {
  const value = object(`instruments[${index}]`, input);
  const instrument = text(`instruments[${index}].instrument`, value.instrument, /^[A-Z0-9]+\/[A-Z]+$/);
  const profile = getSupportedInstrumentProfile(instrument);
  const marketSymbol = text(`${instrument}.marketSymbol`, value.marketSymbol, /^[A-Z0-9]{5,20}$/);
  if (marketSymbol !== profile.binanceSymbol) throw new Error(`${instrument} marketSymbol does not match instrumentProfile`);
  const orderPrefix = text(`${instrument}.orderPrefix`, value.orderPrefix, /^[A-Z0-9]{2,12}$/);
  if (seenPrefixes.has(orderPrefix)) throw new Error(`${instrument} duplicate orderPrefix ${orderPrefix}`);
  seenPrefixes.add(orderPrefix);
  if (typeof value.enabled !== "boolean") throw new Error(`${instrument}.enabled must be boolean`);

  const geometry = object(`${instrument}.geometry`, value.geometry);
  const sizing = object(`${instrument}.sizing`, value.sizing);
  const tranches = object(`${instrument}.tranches`, value.tranches);
  const maDays = integer(`${instrument}.geometry.maDays`, geometry.maDays, 1);
  const bandPct = positive(`${instrument}.geometry.bandPct`, geometry.bandPct);
  const deadZoneBands = integer(`${instrument}.geometry.deadZoneBands`, geometry.deadZoneBands, 0);
  const activeLevelsPerSide = integer(`${instrument}.geometry.activeLevelsPerSide`, geometry.activeLevelsPerSide, 1);
  const growth = positive(`${instrument}.geometry.growth`, geometry.growth);
  const positionsPerRing = integer(`${instrument}.geometry.positionsPerRing`, geometry.positionsPerRing, 1);
  const rearmBands = positive(`${instrument}.geometry.rearmBands`, geometry.rearmBands);
  const capUsd = positive(`${instrument}.sizing.capUsd`, sizing.capUsd);
  const lotStep = positive(`${instrument}.sizing.lotStep`, sizing.lotStep);
  const roundTripCostFloorPct = positive(`${instrument}.sizing.roundTripCostFloorPct`, sizing.roundTripCostFloorPct);
  if (!Array.isArray(tranches.weights) || tranches.weights.length !== 4 || tranches.weights.some((weight) => !Number.isSafeInteger(weight) || weight <= 0)) {
    throw new Error(`${instrument}.tranches.weights must contain four positive integers`);
  }
  const denominator = integer(`${instrument}.tranches.denominator`, tranches.denominator, 1);
  if (tranches.weights.reduce((sum, weight) => sum + weight, 0) !== denominator) throw new Error(`${instrument}.tranches.denominator must equal the weight sum`);

  const derivedBaseUsd = capUsd / unitGross(activeLevelsPerSide, growth);
  if (value.enabled && profile.lotStep == null) throw new Error(`${instrument} is enabled but instrumentProfile has no verified minimum lot`);
  if (value.enabled && Math.abs(profile.lotStep - lotStep) > 1e-12) throw new Error(`${instrument} lotStep does not match instrumentProfile`);

  return Object.freeze({
    instrument,
    marketSymbol,
    orderPrefix,
    enabled: value.enabled,
    profile,
    geometry: Object.freeze({ maDays, bandPct, deadZoneBands, activeLevelsPerSide, growth, positionsPerRing, rearmBands }),
    sizing: Object.freeze({ capUsd, lotStep, roundTripCostFloorPct, baseUsd: derivedBaseUsd }),
    tranches: Object.freeze({ weights: Object.freeze([...tranches.weights]), denominator })
  });
}

function validateAccountRisk(input) {
  const risk = object("accountRisk", input);
  for (const field of REQUIRED_RISK_FIELDS) {
    if (!(field in risk)) throw new Error(`accountRisk.${field} is required`);
  }
  const entryBrakeUsd = positive("accountRisk.entryBrakeUsd", risk.entryBrakeUsd);
  const partialCutUsd = positive("accountRisk.partialCutUsd", risk.partialCutUsd);
  const fullFlattenUsd = positive("accountRisk.fullFlattenUsd", risk.fullFlattenUsd);
  const partialCutFraction = positive("accountRisk.partialCutFraction", risk.partialCutFraction);
  if (!(entryBrakeUsd < partialCutUsd && partialCutUsd < fullFlattenUsd)) throw new Error("accountRisk thresholds must increase from brake to cut to flatten");
  if (partialCutFraction >= 1) throw new Error("accountRisk.partialCutFraction must be less than one");
  if (risk.entryBrakeScope !== "instrument") throw new Error("accountRisk.entryBrakeScope must equal instrument");
  if (risk.partialCutAllocation !== "proportional-to-loss") throw new Error("accountRisk.partialCutAllocation must equal proportional-to-loss");
  if (risk.flattenHoldsUntilRollover !== true) throw new Error("accountRisk.flattenHoldsUntilRollover must be true");
  const dailyLossLimitUsd = positive("accountRisk.dailyLossLimitUsd", risk.dailyLossLimitUsd);
  const rolloverHourUtc = integer("accountRisk.rolloverHourUtc", risk.rolloverHourUtc, 0);
  if (rolloverHourUtc > 23) throw new Error("accountRisk.rolloverHourUtc must be from 0 to 23");
  return Object.freeze({ entryBrakeUsd, entryBrakeScope: risk.entryBrakeScope, partialCutUsd, partialCutFraction, partialCutAllocation: risk.partialCutAllocation, fullFlattenUsd, flattenHoldsUntilRollover: true, dailyLossLimitUsd, rolloverHourUtc });
}

export function loadInstrumentConfigObject(input) {
  const root = object("instruments config", input);
  if (!Array.isArray(root.instruments) || root.instruments.length === 0) throw new Error("instruments config must contain instruments");
  const prefixes = new Set();
  const instruments = root.instruments.map((entry, index) => validateInstrument(entry, index, prefixes));
  const names = new Set(instruments.map((entry) => entry.instrument));
  if (names.size !== instruments.length) throw new Error("instruments config contains duplicate instruments");
  const enabled = instruments.filter((entry) => entry.enabled);
  if (enabled.length === 0) throw new Error("instruments config must enable at least one instrument");
  return Object.freeze({ instruments: Object.freeze(instruments), enabled: Object.freeze(enabled), accountRisk: validateAccountRisk(root.accountRisk) });
}

export async function loadInstrumentConfig(path = "config/instruments.json") {
  return loadInstrumentConfigObject(JSON.parse(await readFile(path, "utf8")));
}

export function derivedBaseUsd({ capUsd, activeLevelsPerSide, growth }) {
  return positive("capUsd", capUsd) / unitGross(integer("activeLevelsPerSide", activeLevelsPerSide), positive("growth", growth));
}

// The minimum-lot check intentionally accepts the current public price as an
// input. It is never inferred from Binance lot filters: Tradeify's lot step is
// the governing value, while the price merely converts that verified step into a
// notional for the current inner ring.
export function assertInnermostRingSupportsMinimumLot(instrument, currentPriceUsd) {
  if (!instrument || typeof instrument !== "object") throw new TypeError("instrument configuration is required");
  const price = positive(`${instrument.instrument ?? "instrument"} current price`, currentPriceUsd);
  const baseUsd = positive(`${instrument.instrument ?? "instrument"} baseUsd`, instrument.sizing?.baseUsd);
  const lotStep = positive(`${instrument.instrument ?? "instrument"} lotStep`, instrument.sizing?.lotStep);
  const rawUnits = baseUsd / price;
  const flooredUnits = Math.floor((rawUnits + 1e-12) / lotStep) * lotStep;
  if (flooredUnits < lotStep - 1e-12) {
    throw new Error(`${instrument.instrument} innermost ring $${baseUsd.toFixed(2)} is below the Tradeify minimum lot notional at current price $${price}`);
  }
  return Object.freeze({ currentPriceUsd: price, innerRingUsd: baseUsd, rawUnits, flooredUnits });
}
