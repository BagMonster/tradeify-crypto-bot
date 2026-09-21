import test from "node:test";
import assert from "node:assert/strict";
import { loadProfiledConfigFiles } from "../src/config/accountProfile.js";
import { buildGridDefinition } from "../src/strategies/ringGridDefinition.js";

// Profile-applied: account-size numbers (capUsd, ladder) live in config/profiles.
// "50k" is the live baseline these assertions were written against.
const { instruments: raw } = await loadProfiledConfigFiles("50k");

test("tiered definition preserves SOL geometry while recalculating active-side capacity", () => {
  const cfg = structuredClone(raw.instruments[0]);
  cfg.geometry.bandPct = 0.045;
  cfg.geometry.deadZoneBands = 2;
  cfg.sizing.capUsd = 6600;
  const definition = buildGridDefinition(cfg);
  assert.equal(definition.baseUsd, 30.917308642427127);
  assert.equal(definition.innermostDistance, 0.135);
  assert.equal(definition.outermostDistance, 0.54);
  assert.deepEqual(definition.rings.slice(0, 4).map((ring) => ring.tag), ["BUY1", "SELL1", "BUY2", "SELL2"]);
});

test("D-060 definition rejects a lot that cannot fit the innermost ring", () => {
  const cfg = structuredClone(raw.instruments[2]);
  cfg.sizing.lotStep = 1;
  assert.throws(() => buildGridDefinition(cfg, 734.27), /Geometry does not fit this instrument/);
});
