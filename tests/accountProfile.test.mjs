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

const readJson = async (path) => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));

const TEN_K = Object.freeze({
  confirmed: true,
  accountSize: 10000,
  dailyLossLimitUsd: 300,
  maxLossUsd: 600,
  maxNotionalUsd: 20000,
  entryBrakeUsd: 33,
  cutTiers: [{ thresholdUsd: 100, fraction: 0.1 }, { thresholdUsd: 150, fraction: 0.2 }, { thresholdUsd: 200, fraction: 0.5 }],
  fullFlattenUsd: 250,
  harvestUsd: 33,
  rolloverHarvestDelayMinutes: 5,
  exposurePool: { softUsd: 2200, hardUsd: 2250 },
  exposurePoolHarvest: { firstAfterHours: 24, secondAfterHours: 36, firstFraction: 0.5, minimumFraction: 0.25 },
  perCoinCapUsd: 25000
});

function supervisorFrom(accountRisk) {
  const book = {
    instrument: "SOL/USD",
    getUnrealisedUsd: () => 0, getDayPnlUsd: () => 0, getExposureUsd: () => 0,
    setEntryBrake() {}, async executeProtectiveCut() { return { status: "FILLED" }; }, async executeProtectiveFlatten() { return { status: "FILLED" }; }
  };
  const harvestStore = { async get(dayKey) { return { dayKey, status: "READY" }; }, async save(state) { return state; } };
  return createRiskSupervisor({ config: accountRisk, instruments: [book], harvestStore });
}

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
  assert.equal(risk.sessionHarvestUsd, 165);
  assert.equal(risk.rolloverHarvestDelayMinutes, 5);
  assert.equal(risk.exposurePool, undefined, "the $50K account never had a pool");
  for (const entry of instruments.instruments) assert.equal(entry.sizing.capUsd, 25000, entry.instrument);
});

test("10k applies the decided $10K numbers and passes every downstream validator", async () => {
  const { account, instruments } = await loadProfiledConfigFiles("10k");
  assert.equal(account.startingBalance, 10000);
  assert.equal(account.dailyLossLimit, 300);
  assert.equal(account.maxLossOffset, 600);
  assert.equal(account.maxNotional, 20000);
  const risk = instruments.accountRisk;
  assert.equal(risk.entryBrakeUsd, 33);
  assert.deepEqual(risk.cutTiers, [{ thresholdUsd: 100, fraction: 0.1 }, { thresholdUsd: 150, fraction: 0.2 }]);
  assert.equal(risk.partialCutUsd, 200);
  assert.equal(risk.fullFlattenUsd, 250);
  assert.equal(risk.sessionHarvestUsd, 33);
  assert.equal(risk.rolloverHarvestDelayMinutes, 5);
  assert.deepEqual(risk.exposurePool, { softUsd: 3000, hardUsd: 3500 });
  assert.deepEqual(risk.exposurePoolHarvest, { firstAfterHours: 24, secondAfterHours: 36, firstFraction: 0.5, minimumFraction: 0.25 });
  for (const entry of instruments.instruments) assert.equal(entry.sizing.capUsd, 5000, entry.instrument);

  assert.doesNotThrow(() => validateAccountConfig(account));
  assert.doesNotThrow(() => loadInstrumentConfigObject(instruments));
  assert.doesNotThrow(() => supervisorFrom(risk));
});

test("the 100k draft is refused until it is confirmed", async () => {
  await assert.rejects(loadAccountProfile("100k"), /"100k" is not confirmed.*config\/profiles\/100k\.json/);
});

test("the 100k draft passes downstream validators when explicitly confirmed in the test", async () => {
  const draft = await readJson("config/profiles/100k.json");
  const profile = validateAccountProfile({ ...draft, confirmed: true }, "100k");
  const applied = applyAccountProfile({
    profile,
    account: await readJson("config/account.json"),
    instruments: await readJson("config/instruments.json")
  });
  assert.equal(applied.instruments.accountRisk.entryBrakeUsd, 330);
  assert.equal(applied.instruments.accountRisk.sessionHarvestUsd, 330);
  assert.equal(applied.instruments.accountRisk.rolloverHarvestDelayMinutes, 5);
  assert.doesNotThrow(() => validateAccountConfig(applied.account));
  assert.doesNotThrow(() => loadInstrumentConfigObject(applied.instruments));
  assert.doesNotThrow(() => supervisorFrom(applied.instruments.accountRisk));
});

test("the boot-log summary shows the numbers the bot will run with", async () => {
  const line = describeAccountProfile(await loadAccountProfile("10k"));
  assert.match(line, /"10k": \$10,000 account, daily limit -\$300/);
  assert.match(line, /flatten -\$250/);
  assert.match(line, /pool \$3,000 soft \/ \$3,500 hard/);
});

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

test("the rollover harvest delay must be a whole number from zero through sixty minutes", () => {
  assert.throws(() => validateAccountProfile({ ...TEN_K, rolloverHarvestDelayMinutes: -1 }, "x"), /whole number from 0 through 60/);
  assert.throws(() => validateAccountProfile({ ...TEN_K, rolloverHarvestDelayMinutes: 5.5 }, "x"), /whole number from 0 through 60/);
  assert.throws(() => validateAccountProfile({ ...TEN_K, rolloverHarvestDelayMinutes: 61 }, "x"), /whole number from 0 through 60/);
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
  withCap.instruments.find((entry) => entry.instrument === "INJ/USD").sizing.capUsd = 150000;
  assert.throws(() => applyAccountProfile({ profile, account: {}, instruments: withCap }), /INJ\/USD still contains sizing.capUsd/);
});

test("the committed JSON files hold none of the profile-owned numbers", async () => {
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

test("committed 100k draft is a tenfold 10k profile with identical timing and fractions", async () => {
  const small = await readJson("config/profiles/10k.json");
  const large = await readJson("config/profiles/100k.json");
  const currency = new Set(["accountSize", "dailyLossLimitUsd", "maxLossUsd", "maxNotionalUsd", "entryBrakeUsd", "fullFlattenUsd", "harvestUsd", "perCoinCapUsd"]);
  assert.deepEqual(Object.keys(large).sort(), Object.keys(small).sort(), "no policy may be missing");
  for (const key of Object.keys(small)) {
    if (key === "note" || key === "confirmed") continue;
    if (currency.has(key)) assert.equal(large[key], small[key] * 10, key);
    else if (key === "cutTiers") assert.deepEqual(large[key], small[key].map((t) => ({ ...t, thresholdUsd: t.thresholdUsd * 10 })));
    else if (key === "exposurePool") assert.deepEqual(large[key], { softUsd: small[key].softUsd * 10, hardUsd: small[key].hardUsd * 10 });
    else assert.deepEqual(large[key], small[key], key);
  }
  assert.equal(small.confirmed, true);
  assert.equal(large.confirmed, false, "this repair does not authorize activation");
});

test("tenfold equivalence survives profile application, live instrument parsing and every book's grid sizing", async () => {
  const { buildGridDefinition } = await import("../src/strategies/ringGridDefinition.js");
  const small = await loadProfiledConfigFiles("10k");
  const draft = await readJson("config/profiles/100k.json");
  const large = applyAccountProfile({ profile: validateAccountProfile({ ...draft, confirmed: true }, "100k"),
    account: await readJson("config/account.json"), instruments: await readJson("config/instruments.json") });
  const expectedAccount = { ...small.account };
  for (const key of ["startingBalance", "dailyLossLimit", "maxLossOffset", "maxLossFloorCap", "maxNotional"]) expectedAccount[key] *= 10;
  assert.deepEqual(large.account, expectedAccount);
  const expectedInstruments = structuredClone(small.instruments);
  for (const key of ["entryBrakeUsd", "partialCutUsd", "fullFlattenUsd", "dailyLossLimitUsd", "sessionHarvestUsd"]) expectedInstruments.accountRisk[key] *= 10;
  for (const tier of expectedInstruments.accountRisk.cutTiers) tier.thresholdUsd *= 10;
  for (const key of ["softUsd", "hardUsd"]) expectedInstruments.accountRisk.exposurePool[key] *= 10;
  for (const book of expectedInstruments.instruments) book.sizing.capUsd *= 10;
  assert.deepEqual(large.instruments, expectedInstruments, "geometry, policies, fractions and timings must stay identical");
  const smallLive = loadInstrumentConfigObject(small.instruments);
  const largeLive = loadInstrumentConfigObject(large.instruments);
  const expectedRisk = structuredClone(smallLive.accountRisk);
  for (const key of ["entryBrakeUsd", "partialCutUsd", "fullFlattenUsd", "dailyLossLimitUsd", "sessionHarvestUsd"]) expectedRisk[key] *= 10;

  assert.deepEqual(largeLive.accountRisk, expectedRisk);
  for (let i = 0; i < small.instruments.instruments.length; i++) {
    const a = buildGridDefinition(small.instruments.instruments[i]);
    const b = buildGridDefinition(large.instruments.instruments[i]);
    assert.ok(Math.abs(b.baseUsd - a.baseUsd * 10) < 1e-8, a.instrument);
    assert.equal(b.capUsd, a.capUsd * 10);
    assert.equal(b.lotStep, a.lotStep, "broker quantity step does not scale");
  }
});

for (const hours of [24, 36]) {
  test(`real risk supervisor uses proportional pool-harvest targets after ${hours} hours through the live raw-profile config`, async () => {
    const nowMs = Date.parse("2026-10-09T22:06:00Z");
    const targets = [];
    for (const name of ["10k", "100k"]) {
      const raw = await readJson(`config/profiles/${name}.json`);
      const applied = applyAccountProfile({ profile: validateAccountProfile({ ...raw, confirmed: true }, name),
        account: await readJson("config/account.json"), instruments: await readJson("config/instruments.json") });
      const risk = loadInstrumentConfigObject(applied.instruments).accountRisk;
      const allocations = [];
      const rows = new Map();
      const scale = name === "10k" ? 1 : 10;
      const book = { instrument: "SOL/USD", getUnrealisedUsd: () => 0, getDayPnlUsd: () => 0, getExposureUsd: () => 0,
        setEntryBrake() {}, setTrancheExitsPaused() {},
        async executeProtectiveCut() { return { status: "ALREADY_FLAT" }; },
        async executeProtectiveFlatten() { return { status: "ALREADY_FLAT" }; },
        async getRolloverHarvestCandidates() { return [{ instrument: "SOL/USD", lotId: "ticket", positionCode: "local-test", virtualSide: "BUY", entryPrice: 100, markPrice: 110, remainingUnits: 4 * scale, lotStep: 0.01 }]; },
        async executeRolloverHarvest({ allocations: planned, onConfirmedClose }) {
          allocations.push(...planned);
          for (const a of planned) await onConfirmedClose({ instrument: "SOL/USD", lotId: "ticket", filledQuantity: a.quantity, realizedPnlUsd: a.estimatedProfitUsd });
          return { closed: [], pending: [] };
        }
      };
      const supervisor = createRiskSupervisor({ config: applied.instruments.accountRisk, instruments: [book], now: () => nowMs,
        getCombinedDayPnlUsd: () => 0,
        getExposurePoolSnapshot: () => ({ closed: true, closedSinceMs: nowMs - hours * 3600000 }),
        harvestStore: { async get(dayKey) { return rows.get(dayKey) ?? { dayKey, status: "READY" }; }, async save(row) { rows.set(row.dayKey, row); return row; } } });
      await supervisor.evaluate({ dayKey: "2026-10-10" });
      assert.equal(allocations.length, 1);
      targets.push(supervisor.getSnapshot().harvest.plan.targetUsd);
      const target = (hours === 24 ? 16.5 : 8.25) * scale;
      assert.ok(allocations[0].estimatedProfitUsd <= target);
      assert.ok(target - allocations[0].estimatedProfitUsd < 0.101, "quantity rounding respects the unchanged broker step");
    }
    assert.deepEqual(targets, hours === 24 ? [16.5, 165] : [8.25, 82.5]);
  });
}

test("rollover window is validated and reaches both raw live risk config and parsed config", async () => {
  for (const value of [0, -1, 1.5, 61]) {
    assert.throws(() => validateAccountProfile({ ...TEN_K, rolloverHarvestWindowMinutes: value }), /rolloverHarvestWindowMinutes/);
    assert.throws(() => supervisorFrom({ ...(awaitRiskBase()), rolloverHarvestWindowMinutes: value }), /rolloverHarvestWindowMinutes/);
  }
  function awaitRiskBase() { return { entryBrakeUsd: 33, partialCutUsd: 200, partialCutFraction: 0.5, fullFlattenUsd: 250, dailyLossLimitUsd: 300 }; }
  const applied = await loadProfiledConfigFiles("10k");
  assert.equal(applied.instruments.accountRisk.rolloverHarvestWindowMinutes, 3);
  assert.equal(loadInstrumentConfigObject(applied.instruments).accountRisk.rolloverHarvestWindowMinutes, 3);
  assert.throws(() => applyAccountProfile({ profile: validateAccountProfile(TEN_K), account: {},
    instruments: { accountRisk: { rolloverHarvestWindowMinutes: 3 }, instruments: [] } }), /still contains "rolloverHarvestWindowMinutes"/);
});

async function windowSupervisor({ time, candidatesReady = true, combined = 0, pending = null, loss = 0, candidateDelayUntil = null } = {}) {
  const { instruments } = await loadProfiledConfigFiles("10k");
  let clock = Date.parse(time);
  let reads = 0;
  let closes = 0;
  let flattens = 0;
  const rows = new Map(pending ? [["2026-10-10", pending]] : []);
  const book = {
    instrument: "SOL/USD", getUnrealisedUsd: () => loss, getDayPnlUsd: () => loss, getExposureUsd: () => 400,
    setEntryBrake() {}, setTrancheExitsPaused() {},
    async executeProtectiveCut() { return { status: "ALREADY_FLAT" }; },
    async executeProtectiveFlatten() { flattens++; return { status: "ALREADY_FLAT" }; },
    async getRolloverHarvestCandidates() {
      reads++;
      if (candidateDelayUntil) clock = Date.parse(candidateDelayUntil);
      return candidatesReady ? [{ instrument: "SOL/USD", lotId: "ticket", positionCode: "local-test", virtualSide: "BUY", entryPrice: 100, markPrice: 110, remainingUnits: 4, lotStep: 0.01 }] : null;
    },
    async executeRolloverHarvest({ allocations, onConfirmedClose }) {
      closes++;
      for (const a of allocations) await onConfirmedClose({ instrument: "SOL/USD", lotId: a.lotId, filledQuantity: a.quantity, realizedPnlUsd: a.estimatedProfitUsd });
      return { closed: [], pending: [] };
    }
  };
  const supervisor = createRiskSupervisor({ config: instruments.accountRisk, instruments: [book], now: () => clock,
    getCombinedDayPnlUsd: () => combined,
    harvestStore: { async get(dayKey) { return rows.get(dayKey) ?? { dayKey, status: "READY" }; }, async save(row) { rows.set(row.dayKey, row); return row; } } });
  return { supervisor, evaluate: () => supervisor.evaluate({ dayKey: "2026-10-10" }),
    setTime: (time) => { clock = Date.parse(time); }, counts: () => ({ reads, closes, flattens }) };
}

for (const [time, eligible] of [["22:04:59.999", false], ["22:05:00.000", true], ["22:07:59.999", true], ["22:08:00.000", false], ["23:00:00.000", false]]) {
  test(`new rollover plan eligibility at ${time} UTC matches the configured three-minute window`, async () => {
    const f = await windowSupervisor({ time: `2026-10-09T${time}Z` });
    await f.evaluate();
    assert.equal(f.counts().closes, eligible ? 1 : 0);
    if (!eligible) assert.equal(f.counts().reads, 0, "outside the window, do not build a plan");
  });
}

test("candidate warm-up and a restart cannot reopen an expired rollover window", async () => {
  const f = await windowSupervisor({ time: "2026-10-09T22:07:00Z", candidatesReady: false });
  await f.evaluate();
  assert.equal(f.counts().reads, 1);
  f.setTime("2026-10-09T22:08:00Z");
  await f.evaluate();
  assert.deepEqual(f.counts(), { reads: 1, closes: 0, flattens: 0 });
});

test("a persisted pending proportional plan can finish after the initiation window expires", async () => {
  const { buildProportionalRolloverHarvestPlan } = await import("../src/risk/rolloverHarvest.js");
  const plan = buildProportionalRolloverHarvestPlan({ dayKey: "2026-10-10", thresholdUsd: 33,
    candidates: [{ instrument: "SOL/USD", lotId: "ticket", positionCode: "local-test", virtualSide: "BUY", entryPrice: 100, markPrice: 110, remainingUnits: 4, lotStep: 0.01 }] });
  const f = await windowSupervisor({ time: "2026-10-09T22:09:00Z", pending: { dayKey: "2026-10-10", status: "PENDING", mode: "ROLLOVER_PARTIAL", plan, triggerPnlUsd: 0 } });
  await f.evaluate();
  assert.equal(f.counts().closes, 1);
  assert.equal(f.counts().reads, 0, "resume the exact saved plan");
  assert.equal(f.supervisor.getSnapshot().harvest.status, "CONFIRMED");
});

test("ordinary full harvest remains eligible after window expiry and protective flatten remains available within it", async () => {
  const harvest = await windowSupervisor({ time: "2026-10-09T23:00:00Z", combined: 35 });
  await harvest.evaluate();
  assert.equal(harvest.counts().closes, 0);
  assert.equal(harvest.counts().flattens, 1);
  assert.equal(harvest.supervisor.getSnapshot().harvest.status, "CONFIRMED");
  const protection = await windowSupervisor({ time: "2026-10-09T22:06:00Z", combined: -250, loss: -250 });
  await protection.evaluate();
  assert.equal(protection.counts().flattens, 1);
  assert.equal(protection.counts().closes, 0);
});


test("broker candidate reads crossing the deadline cannot start a new rollover plan", async () => {
  const f = await windowSupervisor({ time: "2026-10-09T22:07:59Z", candidateDelayUntil: "2026-10-09T22:08:00Z" });
  await f.evaluate();
  assert.deepEqual(f.counts(), { reads: 1, closes: 0, flattens: 0 });
});
