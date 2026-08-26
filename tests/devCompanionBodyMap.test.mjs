import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBodyMap, readDeployedFile } from "../src/devCompanionBodyMap.js";

test("body map loads strategy and readme from a checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "bmtb1-body-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config/strategy.json"), "{\"strategyId\":\"sol-outer-heavy-v1\"}\n");
  writeFileSync(join(root, "README.md"), "# Tradeify Crypto Bot\n");
  const map = loadBodyMap(root);
  assert.match(map, /sol-outer-heavy-v1/);
  assert.match(map, /README\.md/);
  assert.match(map, /BODY MAP/);
});

test("blocked paths cannot be read", () => {
  assert.throws(() => readDeployedFile(process.cwd(), ".env"));
  assert.throws(() => readDeployedFile(process.cwd(), "../secrets"));
});
