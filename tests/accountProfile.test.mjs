import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  applyAccountProfile,
  describeAccountProfile,
  loadAccountProfile,
  loadProfiledConfigFiles,
  validateAccountProfile
} from "../src/config/accountProfile.js";
import { validateAccountConfig } from "../src/config.js";
import { loadInstrumentConfigObject } from "../src/config/instruments.js";
import { createRiskSupervisor } from "../src/risk/riskSupervisor.js";

// Every account-size number lives in config/profiles/<name>.json, selected by the
// ACCOUNT_PROFILE Railway variable. These tests pin two things: each profile
// produces exactly the configuration it claims to, and the common mistakes when
// changing account size stop the bot at startup instead of reaching the market.

const readJson = async (path) => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));

// A valid $10K profile to mutate in the mistake tests.
const TEN_K = Object.freeze({
  confirmed: true,
  accountSize: 10000,
  dailyLossLimitUsd: 300,
  maxLossUsd: 600,
  maxNotionalUsd: 20000,
  entryBrakeUsd: 120,
  cutTiers: [{ thresholdUsd: 100, fraction: 0.1 }, { thresholdUsd: 150, fraction: 0.2 }, { thresholdUsd: 200, fraction: 0.5 }],
  fullFlattenUsd: 250,
  harvestUsd: 75,
  exposurePool: { softUsd: 2200, hardUsd: 2250 },
  perCoinCapUsd: 25000
});

function supervisorFrom(accountRisk) {
  const book = {
    instrument: "SOL/USD",
    getUnrealisedUsd: () => 0, getDayPnlUsd: () => 0, getExposureUsd: () => 0,
    setEntryBrake() {}, async executeProtectiveCut() { return { status: "FILLED" }; }, async executeProtectiveFlatten() { return { status: "FILLED" }; }
  };
  // Harvest is enabled in config/instruments.json, and the supervisor requires a
  // durable store when it is. An in-memory stub is enough for construction.
  const harvestStore = { async get(dayKey) { return { dayKey, status: "READY" }; }, async save(state) { return state; } };
  return createRiskSupervisor({ config: accountRisk, instruments: [book], harvestStore });
}

// ---- The profiles as committed ------------------------------------------------

test("50k reproduces the configuration that was live before profiles existed", async () => {
  const { account, instruments } = await loadProfiledConfigFiles("50k");
  assert.equal(account.startingBalance, 50000);
  assert.equal(account.dailyLossLimit, 1500);
  assert.equal(account.maxLossOffset, 3000);
  assert.equal(account.maxLossFloorCap, 50000);
  assert.equal(account.maxNotional, 100000);
  const risk = instruments.accountRisk;
  assert.equal(risk.entryBrakeUsd, 600);
  assert.deepEqual(risk.cutTiers, [{ thresholdUsd: 500, fraction: 0.1 }, { thresholdUsd: 750, fraction: 0.2 }]);
  assert.equal(risk.partialCutUsd, 1000);
  assert.equal(risk.partialCutFraction, 0.5);
  assert.equal(risk.fullFlattenUsd, 1250);
  assert.equal(risk.dailyLossLimitUsd, 1500);
  assert.equal(risk.sessionHarvestUsd, 600);
  assert.equal(risk.exposurePool, undefined, "the $50K account never had a pool");
  for (const entry of instruments.instruments) assert.equal(entry.sizing.capUsd, 150000, entry.instrument);
});

test("10k applies the decided $10K numbers and passes every downstream validator", async () => {
  const { account, instruments } = await loadProfiledConfigFiles("10k");
  assert.equal(account.startingBalance, 10000);
  assert.equal(account.dailyLossLimit, 300);
  assert.equal(account.maxLossOffset, 600);
  assert.equal(account.maxNotional, 20000);
  const risk = instruments.accountRisk;
  assert.equal(risk.entryBrakeUsd, 120);
  assert.deepEqual(risk.cutTiers, [{ thresholdUsd: 100, fraction: 0.1 }, { thresholdUsd: 150, fraction: 0.2 }]);
  assert.equal(risk.partialCutUsd, 200);
  assert.equal(risk.fullFlattenUsd, 250);
  assert.equal(risk.sessionHarvestUsd, 75);
  assert.deepEqual(risk.exposurePool, { softUsd: 2200, hardUsd: 2250 });
  for (const entry of instruments.instruments) assert.equal(entry.sizing.capUsd, 25000, entry.instrument);

  // The same validators the bot runs at startup.
  assert.doesNotThrow(() => validateAccountConfig(account));
  assert.doesNotThrow(() => loadInstrumentConfigObject(instruments));
  assert.doesNotThrow(() => supervisorFrom(risk));
});

test("the 100k draft is refused until it is confirmed", async () => {
  await assert.rejects(loadAccountProfile("100k"), /"100k" is not confirmed.*config\/profiles\/100k\.json/);
});

test("the 100k draft is internally consistent, so confirming it is the only step left", async () => {
  const draft = await readJson("config/profiles/100k.json");
  const profile = validateAccountProfile({ ...draft, confirmed: true }, "100k");
  const applied = applyAccountProfile({
    profile,
    account: await readJson("config/account.json"),
    instruments: await readJson("config/instruments.json")
  });
  assert.doesNotThrow(() => validateAccountConfig(applied.account));
  assert.doesNotThrow(() => loadInstrumentConfigObject(applied.instruments));
  assert.doesNotThrow(() => supervisorFrom(applied.instruments.accountRisk));
});

test("the boot-log summary shows the numbers the bot will run with", async () => {
  const line = describeAccountProfile(await loadAccountProfile("10k"));
  assert.match(line, /"10k": \$10,000 account, daily limit -\$300/);
  assert.match(line, /flatten -\$250/);
  assert.match(line, /pool \$2,200 soft \/ \$2,250 hard/);
});

// ---- Mistakes that must stop the bot at startup -------------------------------

test("a daily limit that does not match the account size is refused", () => {
  assert.throws(() => validateAccountProfile({ ...TEN_K, accountSize: 100000 }, "x"), /dailyLossLimitUsd must be \$3,000 \(3% of accountSize\), found \$300/);
});

test("max loss and notional must match Tradeify's rules for the size", () => {
  assert.throws(() => validateAccountProfile({ ...TEN_K, maxLossUsd: 3000 }, "x"), /maxLossUsd must be \$600 \(6% of accountSize\)/);
  assert.throws(() => validateAccountProfile({ ...TEN_K, maxNotionalUsd: 100000 }, "x"), /maxNotionalUsd must be \$20,000/);
});

test("a flatten at or beyond the daily limit is refused", () => {
  assert.throws(() => validateAccountProfile({ ...TEN_K, fullFlattenUsd: 300 }, "x"), /fullFlattenUsd \(\$300\) must trigger before the daily loss limit/);
});

test("cut tiers out of order, or deeper than the flatten, are refused", () => {
  assert.throws(() => validateAccountProfile({ ...TEN_K, cutTiers: [{ thresholdUsd: 150, fraction: 0.2 }, { thresholdUsd: 150, fraction: 0.5 }] }, "x"), /strictly increasing/);
  assert.throws(() => validateAccountProfile({ ...TEN_K, cutTiers: [{ thresholdUsd: 100, fraction: 0.1 }, { thresholdUsd: 260, fraction: 0.5 }] }, "x"), /must trigger before fullFlattenUsd/);
  assert.throws(() => validateAccountProfile({ ...TEN_K, cutTiers: [{ thresholdUsd: 100, fraction: 1 }] }, "x"), /fraction must be below 1/);
});

test("a brake at or below the deepest tier's depth is required", () => {
  assert.throws(() => validateAccountProfile({ ...TEN_K, entryBrakeUsd: 200 }, "x"), /entryBrakeUsd \(\$200\) must be below the deepest cut tier/);
});

test("an exposure pool with soft >= hard, or above the notional cap, is refused", () => {
  assert.throws(() => validateAccountProfile({ ...TEN_K, exposurePool: { softUsd: 2250, hardUsd: 2200 } }, "x"), /softUsd .* must be below exposurePool.hardUsd/);
  assert.throws(() => validateAccountProfile({ ...TEN_K, exposurePool: { softUsd: 2200, hardUsd: 25000 } }, "x"), /cannot exceed the broker's notional cap/);
});

test("a missing, unknown or malformed ACCOUNT_PROFILE is refused with a clear message", async () => {
  await assert.rejects(loadAccountProfile(undefined), /ACCOUNT_PROFILE must name a file in config\/profiles/);
  await assert.rejects(loadAccountProfile("25k"), /no profile named "25k"/);
  await assert.rejects(loadAccountProfile("../account"), /ACCOUNT_PROFILE must name a file/);
});

test("a leftover account-size number in either JSON file stops startup", async () => {
  const profile = validateAccountProfile(TEN_K, "10k");
  const instruments = await readJson("config/instruments.json");
  assert.throws(
    () => applyAccountProfile({ profile, account: { startingBalance: 50000 }, instruments }),
    /config\/account.json still contains "startingBalance"/
  );
  assert.throws(
    () => applyAccountProfile({ profile, account: {}, instruments: { ...instruments, accountRisk: { ...instruments.accountRisk, dailyLossLimitUsd: 1500 } } }),
    /accountRisk still contains "dailyLossLimitUsd"/
  );
  const withCap = JSON.parse(JSON.stringify(instruments));
  withCap.instruments[2].sizing.capUsd = 150000;
  assert.throws(() => applyAccountProfile({ profile, account: {}, instruments: withCap }), /INJ\/USD still contains sizing.capUsd/);
});

test("the committed JSON files hold none of the profile-owned numbers", async () => {
  // If this fails, someone added an account-size number back into the JSON files;
  // startup would refuse. Put it in config/profiles/ instead.
  const profile = validateAccountProfile(TEN_K, "10k");
  const account = await readJson("config/account.json");
  const instruments = await readJson("config/instruments.json");
  assert.doesNotThrow(() => applyAccountProfile({ profile, account, instruments }));
});

test("applying a profile never mutates the parsed files", async () => {
  const profile = validateAccountProfile(TEN_K, "10k");
  const account = await readJson("config/account.json");
  const instruments = await readJson("config/instruments.json");
  const before = JSON.stringify({ account, instruments });
  applyAccountProfile({ profile, account, instruments });
  assert.equal(JSON.stringify({ account, instruments }), before);
});
