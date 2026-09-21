/**
 * src/config/accountProfile.js
 *
 * ONE place for every number that depends on the size of the Tradeify account.
 *
 * Before 2026-09-21 those numbers were spread across config/account.json and
 * config/instruments.json, with the daily loss limit stored in both and the
 * per-coin cap repeated once per instrument. Moving to a different account size
 * meant hand-editing about a dozen values in two files with nothing checking
 * that they agreed. The owner asked for a single place to change.
 *
 * How it works:
 *   - config/profiles/<name>.json holds the account-size numbers, in dollars.
 *   - The Railway variable ACCOUNT_PROFILE picks which file (e.g. "10k").
 *   - At startup the profile is validated against Tradeify's Instant Funding
 *     rules and against the ladder's own logic, then written into the account
 *     and instrument configs before either is validated or used.
 *   - If config/account.json or config/instruments.json still contains one of
 *     the profile-owned fields, startup refuses. There must be exactly one copy.
 *   - A profile must say "confirmed": true. A draft cannot be run by accident.
 *
 * Any failure here stops the bot before it connects to anything, with a message
 * naming the exact field and the value it expected.
 */

import { readFile } from "node:fs/promises";

// Tradeify Instant Funding rules, verified against the Tradeify help centre on
// 2026-09-20 and confirmed by the owner on 2026-09-21: the daily loss limit is 3%
// of account size, measured on intraday equity (realised plus unrealised), and
// touching it at any moment closes the account. Max drawdown is 6%. Leverage is
// fixed at 2:1.
export const TRADEIFY_INSTANT_FUNDING = Object.freeze({
  dailyLossPct: 0.03,
  maxLossPct: 0.06,
  leverage: 2
});

// Fields the profile owns. If any of these still appear in the JSON files,
// startup refuses rather than silently choosing one copy over the other.
const PROFILE_OWNED_ACCOUNT_FIELDS = Object.freeze([
  "startingBalance", "dailyLossLimit", "maxLossOffset", "maxLossFloorCap", "maxNotional"
]);
const PROFILE_OWNED_RISK_FIELDS = Object.freeze([
  "entryBrakeUsd", "cutTiers", "partialCutUsd", "partialCutFraction",
  "fullFlattenUsd", "dailyLossLimitUsd", "sessionHarvestUsd", "exposurePool"
]);

const PROFILE_NAME = /^[a-z0-9-]{1,32}$/;

function fail(message) {
  throw new Error(`Account profile: ${message}`);
}

function positive(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(`${name} must be a positive number, found ${JSON.stringify(value)}`);
  return value;
}

function money(value) {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function requireEqual(name, actual, expected, rule) {
  if (Math.abs(actual - expected) > 0.005) fail(`${name} must be ${money(expected)} (${rule}), found ${money(actual)}`);
}

export function validateAccountProfile(input, name = "profile") {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(`"${name}" must be a JSON object`);
  if (input.confirmed !== true) {
    fail(`"${name}" is not confirmed. Review every number in config/profiles/${name}.json, then set "confirmed": true.`);
  }

  const accountSize = positive("accountSize", input.accountSize);
  const dailyLossLimitUsd = positive("dailyLossLimitUsd", input.dailyLossLimitUsd);
  const maxLossUsd = positive("maxLossUsd", input.maxLossUsd);
  const maxNotionalUsd = positive("maxNotionalUsd", input.maxNotionalUsd);

  // Tradeify's rules, derived from the account size. A number copied from the
  // wrong profile fails here, before any trade.
  requireEqual("dailyLossLimitUsd", dailyLossLimitUsd, accountSize * TRADEIFY_INSTANT_FUNDING.dailyLossPct, "3% of accountSize");
  requireEqual("maxLossUsd", maxLossUsd, accountSize * TRADEIFY_INSTANT_FUNDING.maxLossPct, "6% of accountSize");
  requireEqual("maxNotionalUsd", maxNotionalUsd, accountSize * TRADEIFY_INSTANT_FUNDING.leverage, "2:1 leverage on accountSize");

  // Cut tiers, listed shallowest first. The deepest becomes partialCutUsd, the
  // rest become cutTiers, matching the shape riskSupervisor.js already reads.
  if (!Array.isArray(input.cutTiers) || input.cutTiers.length === 0) fail("cutTiers must list at least one tier, shallowest first");
  const cutTiers = input.cutTiers.map((tier, i) => {
    const thresholdUsd = positive(`cutTiers[${i}].thresholdUsd`, tier?.thresholdUsd);
    const fraction = positive(`cutTiers[${i}].fraction`, tier?.fraction);
    if (fraction >= 1) fail(`cutTiers[${i}].fraction must be below 1 (a whole close is the full flatten), found ${fraction}`);
    return Object.freeze({ thresholdUsd, fraction });
  });
  for (let i = 1; i < cutTiers.length; i += 1) {
    if (!(cutTiers[i].thresholdUsd > cutTiers[i - 1].thresholdUsd)) {
      fail(`cutTiers must be listed shallowest first with strictly increasing thresholds; tier ${i} (${money(cutTiers[i].thresholdUsd)}) is not deeper than tier ${i - 1} (${money(cutTiers[i - 1].thresholdUsd)})`);
    }
  }
  const deepest = cutTiers[cutTiers.length - 1];

  const entryBrakeUsd = positive("entryBrakeUsd", input.entryBrakeUsd);
  const fullFlattenUsd = positive("fullFlattenUsd", input.fullFlattenUsd);
  if (!(entryBrakeUsd < deepest.thresholdUsd)) fail(`entryBrakeUsd (${money(entryBrakeUsd)}) must be below the deepest cut tier (${money(deepest.thresholdUsd)})`);
  if (!(deepest.thresholdUsd < fullFlattenUsd)) fail(`the deepest cut tier (${money(deepest.thresholdUsd)}) must trigger before fullFlattenUsd (${money(fullFlattenUsd)})`);
  if (!(fullFlattenUsd < dailyLossLimitUsd)) fail(`fullFlattenUsd (${money(fullFlattenUsd)}) must trigger before the daily loss limit (${money(dailyLossLimitUsd)})`);

  const harvestUsd = positive("harvestUsd", input.harvestUsd);
  const perCoinCapUsd = positive("perCoinCapUsd", input.perCoinCapUsd);

  let exposurePool = null;
  if (input.exposurePool != null) {
    const softUsd = positive("exposurePool.softUsd", input.exposurePool.softUsd);
    const hardUsd = positive("exposurePool.hardUsd", input.exposurePool.hardUsd);
    if (!(softUsd < hardUsd)) fail(`exposurePool.softUsd (${money(softUsd)}) must be below exposurePool.hardUsd (${money(hardUsd)})`);
    if (!(hardUsd <= maxNotionalUsd)) fail(`exposurePool.hardUsd (${money(hardUsd)}) cannot exceed the broker's notional cap (${money(maxNotionalUsd)})`);
    exposurePool = Object.freeze({ softUsd, hardUsd });
  }

  return Object.freeze({
    name,
    accountSize,
    dailyLossLimitUsd,
    maxLossUsd,
    maxNotionalUsd,
    entryBrakeUsd,
    cutTiers: Object.freeze(cutTiers),
    fullFlattenUsd,
    harvestUsd,
    perCoinCapUsd,
    exposurePool
  });
}

function profilesDirectory() {
  return new URL("../../config/profiles/", import.meta.url);
}

export async function loadAccountProfile(name, directory = profilesDirectory()) {
  if (typeof name !== "string" || !PROFILE_NAME.test(name.trim())) {
    fail(`the Railway variable ACCOUNT_PROFILE must name a file in config/profiles/ (for example "10k"), found ${JSON.stringify(name ?? null)}`);
  }
  const clean = name.trim();
  let text;
  try {
    text = await readFile(new URL(`${clean}.json`, directory), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") fail(`no profile named "${clean}" (expected config/profiles/${clean}.json)`);
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`config/profiles/${clean}.json is not valid JSON`);
  }
  return validateAccountProfile(parsed, clean);
}

export function applyAccountProfile({ profile, account, instruments }) {
  if (!profile || typeof profile !== "object") fail("applyAccountProfile requires a validated profile");

  // Exactly one copy. A leftover number in either JSON file would be silently
  // overridden, and someone would eventually edit it believing it mattered.
  for (const field of PROFILE_OWNED_ACCOUNT_FIELDS) {
    if (account && Object.hasOwn(account, field)) {
      fail(`config/account.json still contains "${field}". It is set by config/profiles/${profile.name}.json now; delete it from config/account.json.`);
    }
  }
  const risk = instruments?.accountRisk ?? {};
  for (const field of PROFILE_OWNED_RISK_FIELDS) {
    if (Object.hasOwn(risk, field)) {
      fail(`config/instruments.json accountRisk still contains "${field}". It is set by config/profiles/${profile.name}.json now; delete it from config/instruments.json.`);
    }
  }
  for (const entry of instruments?.instruments ?? []) {
    if (entry?.sizing && Object.hasOwn(entry.sizing, "capUsd")) {
      fail(`config/instruments.json ${entry.instrument ?? "an instrument"} still contains sizing.capUsd. It is set by perCoinCapUsd in config/profiles/${profile.name}.json now; delete it.`);
    }
  }

  // Work on copies so the parsed files are never mutated in place.
  const accountOut = JSON.parse(JSON.stringify(account ?? {}));
  const instrumentsOut = JSON.parse(JSON.stringify(instruments ?? {}));

  Object.assign(accountOut, {
    startingBalance: profile.accountSize,
    dailyLossLimit: profile.dailyLossLimitUsd,
    maxLossOffset: profile.maxLossUsd,
    maxLossFloorCap: profile.accountSize,
    maxNotional: profile.maxNotionalUsd
  });

  const deepest = profile.cutTiers[profile.cutTiers.length - 1];
  instrumentsOut.accountRisk = {
    ...(instrumentsOut.accountRisk ?? {}),
    entryBrakeUsd: profile.entryBrakeUsd,
    cutTiers: profile.cutTiers.slice(0, -1).map((tier) => ({ thresholdUsd: tier.thresholdUsd, fraction: tier.fraction })),
    partialCutUsd: deepest.thresholdUsd,
    partialCutFraction: deepest.fraction,
    fullFlattenUsd: profile.fullFlattenUsd,
    dailyLossLimitUsd: profile.dailyLossLimitUsd,
    sessionHarvestUsd: profile.harvestUsd,
    ...(profile.exposurePool ? { exposurePool: { softUsd: profile.exposurePool.softUsd, hardUsd: profile.exposurePool.hardUsd } } : {})
  };

  for (const entry of instrumentsOut.instruments ?? []) {
    entry.sizing = { ...(entry.sizing ?? {}), capUsd: profile.perCoinCapUsd };
  }

  return Object.freeze({ account: accountOut, instruments: instrumentsOut });
}

// Loads a profile and both JSON files and returns them with the profile applied.
// Used by tests that need a real, fully populated config.
export async function loadProfiledConfigFiles(name) {
  const profile = await loadAccountProfile(name);
  const root = new URL("../../config/", import.meta.url);
  const [account, instruments] = await Promise.all([
    readFile(new URL("account.json", root), "utf8").then(JSON.parse),
    readFile(new URL("instruments.json", root), "utf8").then(JSON.parse)
  ]);
  return Object.freeze({ profile, ...applyAccountProfile({ profile, account, instruments }) });
}

export function describeAccountProfile(profile) {
  const tiers = profile.cutTiers.map((tier) => `${Math.round(tier.fraction * 100)}% at -${money(tier.thresholdUsd)}`).join(", ");
  const pool = profile.exposurePool
    ? `pool ${money(profile.exposurePool.softUsd)} soft / ${money(profile.exposurePool.hardUsd)} hard`
    : "pool not set";
  return `Account profile "${profile.name}": ${money(profile.accountSize)} account, daily limit -${money(profile.dailyLossLimitUsd)}, ` +
    `brake -${money(profile.entryBrakeUsd)}/instrument, cuts ${tiers}, flatten -${money(profile.fullFlattenUsd)}, ` +
    `harvest +${money(profile.harvestUsd)}, ${pool}, per-coin cap ${money(profile.perCoinCapUsd)}.`;
}
