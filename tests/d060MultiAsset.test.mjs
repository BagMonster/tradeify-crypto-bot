import test from "node:test";
import assert from "node:assert/strict";
import { loadProfiledConfigFiles } from "../src/config/accountProfile.js";
import { loadInstrumentConfigObject } from "../src/config/instruments.js";
import { createRingGrid } from "../src/strategies/ringGrid.js";
import { buildGridDefinition } from "../src/strategies/ringGridDefinition.js";
import { createSolanaRuntime } from "../src/runtime/solanaRuntime.js";
import { signedNetByInstrument, trustedSignedNetFor } from "../src/account/dxtradeSignedNet.js";
import { getSupportedInstrumentProfile, resolveInstrumentProfile } from "../src/instrumentProfile.js";

// Profile-applied: account-size numbers (capUsd, ladder) live in config/profiles.
// "50k" is the live baseline these assertions were written against.
const { instruments: raw } = await loadProfiledConfigFiles("50k");

// Count-agnostic: adding or removing a coin in config/instruments.json must not
// require editing this test. It checks the rules every enabled book must obey.
test("every enabled instrument is registered with a verified lot and a unique prefix", () => {
  const config = loadInstrumentConfigObject(raw);
  assert.ok(config.enabled.length >= 1, "at least one instrument must be enabled");
  const prefixes = new Set();
  for (const entry of config.enabled) {
    const profile = getSupportedInstrumentProfile(entry.instrument);
    assert.equal(profile.dxtradeSymbol, entry.instrument, `${entry.instrument} dxtradeSymbol`);
    assert.equal(profile.binanceSymbol, entry.marketSymbol, `${entry.instrument} marketSymbol`);
    assert.equal(typeof profile.lotStep, "number", `${entry.instrument} needs a verified lotStep in instrumentProfile`);
    assert.equal(entry.sizing.lotStep, profile.lotStep, `${entry.instrument} lotStep must match instrumentProfile`);
    assert.equal(prefixes.has(entry.orderPrefix), false, `${entry.instrument} duplicate orderPrefix`);
    prefixes.add(entry.orderPrefix);
  }
  // D-062: ZEC stays off until the owner decides otherwise.
  assert.equal(config.enabled.some((entry) => entry.instrument === "ZEC/USD"), false);
});

test("INJ/USD profile resolves to INJUSDT", () => {
  const supported = getSupportedInstrumentProfile("INJ/USD");
  assert.equal(supported.asset, "INJ");
  assert.equal(supported.binanceSymbol, "INJUSDT");
  assert.equal(supported.dxtradeSymbol, "INJ/USD");
  assert.equal(supported.lotStep, 0.01);
  const resolved = resolveInstrumentProfile({ instruments: { "INJ/USD": { enabled: true } } });
  assert.equal(resolved.asset, "INJ");
  assert.equal(resolved.binanceSymbol, "INJUSDT");
});

test("INJ fitted geometry is ±30% to ±85% at the profile's active-side cap", () => {
  const entry = raw.instruments.find((item) => item.instrument === "INJ/USD");
  const definition = buildGridDefinition(entry, 5.06);
  // baseUsd = cap / unitGross, so it tracks config/profiles/50k.json perCoinCapUsd (now $25,000).
  assert.equal(Number(definition.baseUsd.toFixed(2)), 50.59);
  assert.equal(definition.levels, 12);
  assert.equal(Number(definition.innermostDistance.toFixed(4)), 0.30);
  assert.equal(Number(definition.outermostDistance.toFixed(4)), 0.85);
  assert.equal(definition.grossExposureCeilingUsd, raw.instruments.find((entry) => entry.instrument === "INJ/USD").sizing.capUsd);
  assert.ok(definition.innermostRingUsd > 0.01 * 5.06);
});

test("tiered SOL sizing derives the active-side cap across one and two-lot rings", () => {
  const cfg = structuredClone(raw.instruments[0]);
  cfg.geometry.bandPct = 0.045;
  cfg.geometry.deadZoneBands = 2;
  cfg.sizing.capUsd = 6600;
  const state = createRingGrid(cfg).createInitialState();
  assert.deepEqual(state.rings.slice(0, 4).map((ring) => ring.tag), ["BUY1", "SELL1", "BUY2", "SELL2"]);
  assert.equal(state.rings.find((ring) => ring.tag === "BUY1").usd, 30.917308642427127);
});

test("D-060 broker nets remain separate and unreadable books are unknown", () => {
  const result = signedNetByInstrument({ positions: [
    { symbol: "SOL/USD", quantity: 0.3, side: "BUY", markPrice: 100 },
    { symbol: "DOGE/USD", quantity: 20, side: "SELL", markPrice: 0.1 }
  ] }, ["SOL/USD", "DOGE/USD"]);
  assert.equal(result.ok, true);
  assert.equal(result.byInstrument["SOL/USD"].netUnits, 0.3);
  assert.equal(result.byInstrument["DOGE/USD"].netUnits, -20);
  assert.equal(trustedSignedNetFor({ snapshot: { positionsReadFailed: true } }, "SOL/USD"), null);
});

test("D-060 runtime disables the legacy ladder and exposes only fresh per-book risk", async () => {
  const definition = buildGridDefinition(raw.instruments[0]);
  const grid = createRingGrid(definition);
  let state = null;
  const store = {
    async init() {},
    async load() { return state; },
    async initializeIfMissing(value) { state = value; return state; },
    async save(version, value) { assert.equal(version, state.version); state = value; return state; }
  };
  const runtime = createSolanaRuntime({
    instrument: definition.instrument,
    strategyId: definition.strategyId,
    gridDefinition: definition,
    stateStore: store,
    maProvider: { async getCurrent() { return { ma: 100 }; } },
    execution: {
      isEnabled: () => false,
      async executeIntent() { throw new Error("locked"); },
      async executeProtectiveCut() { throw new Error("not reached"); },
      async executeProtectiveFlatten() { throw new Error("not reached"); }
    },
    getRiskSnapshot: async () => ({
      accountDataFresh: true,
      brokerNetUnits: 0,
      instrumentUnrealisedUsd: -12,
      instrumentDayPnlUsd: -20,
      instrumentExposureUsd: 30
    })
  });
  await runtime.init();
  await runtime.processTrade({ source: "binance", symbol: "SOLUSDT", price: 100, tradeTime: "2026-09-01T00:00:00.000Z" });
  assert.equal(runtime.getUnrealisedUsd(), -12);
  assert.equal(runtime.getDayPnlUsd(), -20);
  assert.equal(runtime.getExposureUsd(), 30);
  runtime.attachRiskSupervisor({ getSnapshot() { return { flattenedToday: false }; } });
  assert.equal(runtime.getRiskLadderState().flattenedToday, false);
});
