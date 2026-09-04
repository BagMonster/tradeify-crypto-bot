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

test("SOL status uses the live identity and $10,000 cap, not the SOL-only template", () => {
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
  assert.match(text, /\$10,000\.00/);
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
