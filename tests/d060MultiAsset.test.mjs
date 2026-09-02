import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadInstrumentConfigObject } from "../src/config/instruments.js";
import { createRingGrid } from "../src/strategies/ringGrid.js";
import { buildGridDefinition } from "../src/strategies/ringGridDefinition.js";
import { createSolanaRuntime } from "../src/runtime/solanaRuntime.js";
import { signedNetByInstrument, trustedSignedNetFor } from "../src/account/dxtradeSignedNet.js";

const raw = JSON.parse(await readFile(new URL("../config/instruments.json", import.meta.url), "utf8"));

test("D-060 config enables the five owner-authorized instruments", () => {
  const config = loadInstrumentConfigObject(raw);
  assert.deepEqual(config.enabled.map((entry) => entry.instrument), ["SOL/USD", "DOGE/USD", "ZEC/USD", "AAVE/USD", "AVAX/USD"]);
  assert.equal(config.enabled.every((entry) => entry.sizing.lotStep === 0.01), true);
});

test("D-060 current live SOL compatibility geometry derives the $6,600 cap", () => {
  const cfg = structuredClone(raw.instruments[0]);
  cfg.geometry.bandPct = 0.045;
  cfg.geometry.deadZoneBands = 2;
  cfg.sizing.capUsd = 6600;
  const state = createRingGrid(cfg).createInitialState();
  assert.deepEqual(state.rings.slice(0, 4).map((ring) => ring.tag), ["BUY1", "SELL1", "BUY2", "SELL2"]);
  assert.equal(state.rings.find((ring) => ring.tag === "BUY1").usd, 29.118483412322274);
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
