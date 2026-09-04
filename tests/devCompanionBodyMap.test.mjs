import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBodyMap, readDeployedFile } from "../src/devCompanionBodyMap.js";

test("body map loads live instruments and identity, not the old SOL-only strategy file", () => {
  const root = mkdtempSync(join(tmpdir(), "bmtb1-body-"));
  mkdirSync(join(root, "config"), { recursive: true });
  mkdirSync(join(root, "docs/chronicle"), { recursive: true });
  writeFileSync(join(root, "config/instruments.json"), "{\"instruments\":[{\"instrument\":\"INJ/USD\"}]}\n");
  writeFileSync(join(root, "README.md"), "# Tradeify Crypto Bot\n");
  writeFileSync(join(root, "docs/chronicle/WHO_I_AM.md"), "# Who I am\nBrutal Markets, Tamed By One\n");
  writeFileSync(join(root, "docs/chronicle/LIVE_CONTEXT.md"), "Five books: SOL, DOGE, INJ, AAVE, AVAX\n");
  const map = loadBodyMap(root);
  assert.match(map, /INJ\/USD/);
  assert.match(map, /LIVE_CONTEXT\.md/);
  assert.match(map, /README\.md/);
  assert.match(map, /WHO_I_AM\.md/);
  assert.match(map, /Brutal Markets, Tamed By One/);
  assert.match(map, /BODY MAP/);
  assert.match(map, /SNAPSHOT \/alerts/);
  assert.doesNotMatch(map, /config\/strategy\.json\n\{/);
});

test("blocked paths cannot be read", () => {
  assert.throws(() => readDeployedFile(process.cwd(), ".env"));
  assert.throws(() => readDeployedFile(process.cwd(), "../secrets"));
});
