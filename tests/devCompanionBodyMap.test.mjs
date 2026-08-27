import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBodyMap, readDeployedFile } from "../src/devCompanionBodyMap.js";

test("body map loads strategy, readme, and identity card from a checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "bmtb1-body-"));
  mkdirSync(join(root, "config"), { recursive: true });
  mkdirSync(join(root, "docs/chronicle"), { recursive: true });
  writeFileSync(join(root, "config/strategy.json"), "{\"strategyId\":\"sol-outer-heavy-v1\"}\n");
  writeFileSync(join(root, "README.md"), "# Tradeify Crypto Bot\n");
  writeFileSync(join(root, "docs/chronicle/WHO_I_AM.md"), "# Who I am\nBrutal Markets, Tamed By One\n");
  const map = loadBodyMap(root);
  assert.match(map, /sol-outer-heavy-v1/);
  assert.match(map, /README\.md/);
  assert.match(map, /WHO_I_AM\.md/);
  assert.match(map, /Brutal Markets, Tamed By One/);
  assert.match(map, /BODY MAP/);
});

test("blocked paths cannot be read", () => {
  assert.throws(() => readDeployedFile(process.cwd(), ".env"));
  assert.throws(() => readDeployedFile(process.cwd(), "../secrets"));
});
