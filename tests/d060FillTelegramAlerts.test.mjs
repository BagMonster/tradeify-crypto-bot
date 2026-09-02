import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildGridDefinition } from "../src/strategies/ringGridDefinition.js";
import { createSolanaRuntime } from "../src/runtime/solanaRuntime.js";
import { formatLiveTelegramNotification } from "../src/notifications/liveTelegramNotifications.js";

const raw = JSON.parse(await readFile(new URL("../config/instruments.json", import.meta.url), "utf8"));

test("D-060 fill path enqueues a per-instrument entry alert after the fill is saved", async () => {
  const definition = buildGridDefinition(raw.instruments[0]);
  let state = null;
  const queued = [];
  const store = {
    async init() {},
    async load() { return state; },
    async initializeIfMissing(value) { state = value; return state; },
    async save(version, value) {
      assert.equal(version, state.version);
      state = value;
      return state;
    }
  };
  const runtime = createSolanaRuntime({
    instrument: definition.instrument,
    strategyId: definition.strategyId,
    gridDefinition: definition,
    stateStore: store,
    maProvider: { async getCurrent() { return { ma: 100 }; } },
    execution: {
      isEnabled: () => true,
      async executeIntent(intent) {
        return {
          status: "FILLED",
          confirmed: true,
          orderCode: `SOLGRID-${intent.stateVersion}-${intent.tag}-E`,
          fillPrice: intent.observedPrice,
          filledQuantity: intent.quantity,
          filledAt: "2026-09-02T13:00:30.000Z"
        };
      },
      async executeProtectiveCut() { return { status: "ALREADY_FLAT" }; },
      async executeProtectiveFlatten() { return { status: "ALREADY_FLAT" }; }
    },
    getRiskSnapshot: async () => ({
      accountDataFresh: true,
      brokerNetUnits: 0,
      instrumentUnrealisedUsd: 0,
      instrumentDayPnlUsd: 0,
      instrumentExposureUsd: 0
    }),
    notifications: {
      enqueue(event) {
        queued.push(event);
        return { status: "QUEUED" };
      }
    }
  });
  await runtime.init();
  await runtime.processTrade({ source: "binance", symbol: "SOLUSDT", price: 95, tradeTime: "2026-09-02T13:00:00.000Z" });
  assert.equal(queued.length, 0);
  await runtime.processTrade({ source: "binance", symbol: "SOLUSDT", price: 90, tradeTime: "2026-09-02T13:00:30.000Z" });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, "ENTRY_CONFIRMED");
  assert.equal(queued[0].instrument, "SOL/USD");
  assert.equal(queued[0].side, "BUY");
  assert.match(queued[0].eventKey, /^SOL-ENTRY:/);
});

test("entry alert formatter names the instrument and accepts rings above 10", () => {
  const formatted = formatLiveTelegramNotification({
    kind: "ENTRY_CONFIRMED",
    eventKey: "AAVE-ENTRY:AAVEGRID-1-SELL12-E",
    instrument: "AAVE/USD",
    ringTag: "SELL12",
    side: "SELL",
    fillPrice: 131.505,
    filledQuantity: 0.47,
    lotId: "SELL12-V1",
    ma: 96.7491,
    filledAt: "2026-09-02T13:20:00.000Z"
  });
  assert.match(formatted.message, /AAVE\/USD ENTRY CONFIRMED/);
  assert.match(formatted.message, /Ring: SELL12/);
  assert.match(formatted.message, /Quantity: 0\.47 AAVE/);
});
