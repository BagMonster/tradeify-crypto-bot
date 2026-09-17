import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadInstrumentConfigObject } from "../src/config/instruments.js";
import { buildGridDefinition } from "../src/strategies/ringGridDefinition.js";
import { createRingGrid } from "../src/strategies/ringGrid.js";
import {
  formatInstrumentStatus,
  formatInstrumentHealth,
  formatInstrumentLevels
} from "../src/monitoring/instrumentOwnerText.js";

const raw = JSON.parse(await readFile(new URL("../config/instruments.json", import.meta.url), "utf8"));
const config = loadInstrumentConfigObject(raw);

function book(symbol) {
  const cfg = config.enabled.find((entry) => entry.instrument === symbol);
  const definition = buildGridDefinition(cfg);
  const grid = createRingGrid(definition);
  return { definition, grid, state: grid.createInitialState() };
}

test("SOL status uses the live identity and $200,000 active-side cap", () => {
  const { definition, grid, state } = book("SOL/USD");
  const text = formatInstrumentStatus({
    definition,
    grid,
    gridState: state,
    maState: { ma: 82.0354, completedThrough: "2026-09-02T00:00:00.000Z" },
    environment: { appMode: "live", autoExecute: true },
    execution: { isEnabled: () => true },
    botState: { operator_killed: false, safety_halt: false },
    accountMonitor: {
      getSnapshot: () => ({
        healthy: true,
        fresh: true,
        ageMs: 12,
        snapshot: {
          signedNetReadOk: true,
          positionSource: "open-positions",
          signedNetByInstrument: { "SOL/USD": { netUnits: 0, ticketCount: 0 } }
        }
      })
    }
  });
  assert.match(text, /SOL\/USD STATUS/);
  assert.match(text, /sol-ring-grid-v1/);
  assert.match(text, /Binance SOLUSDT/);
  assert.doesNotMatch(text, /sol-outer-heavy-v1/);
  assert.doesNotMatch(text, /OUTER-HEAVY/);
  assert.match(text, /\$200,000\.00/);
  assert.doesNotMatch(text, /\$6,600\.00/);
  assert.match(text, /Occupied rings: 0\/20/);
  assert.match(text, /DXtrade broker net: 0\.00/);
});

test("DOGE status does not inherit SOL labels or the 20-ring SOL notebook", () => {
  const { definition, grid, state } = book("DOGE/USD");
  const text = formatInstrumentStatus({
    definition,
    grid,
    gridState: state,
    maState: { ma: 0.0889, completedThrough: "2026-09-02T00:00:00.000Z" },
    environment: { appMode: "live", autoExecute: true },
    execution: { isEnabled: () => true },
    botState: {},
    accountMonitor: {
      getSnapshot: () => ({
        healthy: true,
        fresh: true,
        ageMs: 5,
        snapshot: {
          signedNetReadOk: true,
          positionSource: "open-positions",
          signedNetByInstrument: { "DOGE/USD": { netUnits: 0, ticketCount: 0 } }
        }
      })
    }
  });
  assert.match(text, /DOGE\/USD STATUS/);
  assert.match(text, /doge-ring-grid-v1/);
  assert.match(text, /Binance DOGEUSDT/);
  assert.match(text, /DXtrade DOGE\/USD/);
  assert.match(text, /Occupied rings: 0\/24/);
  assert.doesNotMatch(text, /SOLUSDT/);
  assert.doesNotMatch(text, /Virtual net SOL/);
});

test("health and levels name the instrument they describe", () => {
  const { definition, state } = book("INJ/USD");
  const health = formatInstrumentHealth({
    definition,
    environment: { appMode: "live" },
    execution: { isEnabled: () => true },
    databaseTime: Date.parse("2026-09-02T00:00:00.000Z"),
    maState: { completedThrough: "2026-09-02T00:00:00.000Z" },
    accountMonitor: { getSnapshot: () => ({ healthy: true, fresh: true, ageMs: 1, snapshot: { signedNetReadOk: true, signedNetByInstrument: {} } }) }
  });
  assert.match(health, /INJ\/USD HEALTH/);
  assert.match(health, /inj-ring-grid-v1/);
  const levels = formatInstrumentLevels({
    definition,
    gridState: state,
    price: 12.23,
    ma: 12.23
  });
  assert.match(levels, /INJ\/USD GRID LEVELS/);
  assert.match(levels, /BUY12 /);
  assert.doesNotMatch(levels, /BUY13 /);
});

test("levels show the exact tier capacity, trigger-price units, and active-side block", () => {
  const { definition, state } = book("SOL/USD");
  const next = structuredClone(state);
  const sell3 = next.rings.find((ring) => ring.tag === "SELL3");
  const sell6 = next.rings.find((ring) => ring.tag === "SELL6");
  sell3.lots.push({ side: "SELL", remainingUnits: 10 });
  sell3.armed = false;
  sell6.lots.push({ side: "SELL", remainingUnits: 10 });
  sell6.armed = false;

  const text = formatInstrumentLevels({
    definition,
    gridState: next,
    price: 99.32,
    ma: 83.3628
  });

  assert.match(text, /SOL\/USD \$99\.32 \| MA \$83\.3628 \| ABOVE MA/);
  assert.match(text, /Active side: SELL \| Open lots: 2/);
  assert.match(text, /Open gross @ price: \$1,986\.40 \| Capacity remaining: \$198,013\.60 \/ \$200,000\.00/);
  assert.match(text, /Tier capacity: levels 1–5 = 1 lot \| levels 6–10 = 2 lots/);
  assert.match(text, /SELL3 \$100\.0354 · \$2,108\.00 · ~21\.07 SOL · FULL 1\/1/);
  assert.match(text, /SELL6 \$112\.5398 · \$7,114\.49 · ~63\.22 SOL · REARM REQUIRED 1\/2/);
  assert.match(text, /BUY1 \$75\.026[45] · \$936\.89 · ~12\.49 SOL · BLOCKED — SELL inventory open/);
});
