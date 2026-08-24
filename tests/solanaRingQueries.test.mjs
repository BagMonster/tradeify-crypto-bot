import test from "node:test";
import assert from "node:assert/strict";
import { buildSolanaRingLevels, summarizeSolanaRingPosition } from "../src/monitoring/solanaRingQueries.js";

test("ring query geometry matches frozen 8x8 SOL baseline", () => {
  const levels = buildSolanaRingLevels({ ma: 100 });
  assert.equal(levels.buys.length, 8);
  assert.equal(levels.shorts.length, 8);
  assert.equal(levels.buys[0].triggerPrice, 77.5);
  assert.equal(levels.shorts[0].triggerPrice, 122.50000000000001);
  assert.ok(Math.abs(levels.buys[7].triggerPrice - 46) < 1e-10);
  assert.ok(Math.abs(levels.shorts[7].triggerPrice - 154) < 1e-10);
  assert.equal(levels.buys[0].usd, 6);
  assert.ok(Math.abs(levels.buys[7].usd - (6 * (1.8 ** 7))) < 1e-10);
});

test("dead-zone query returns the nearest BUY and SHORT levels", () => {
  const livePrice = 94.67;
  const buy1 = 62.92225;
  const short1 = 99.45775;
  const view = summarizeSolanaRingPosition({ price: livePrice, ma: 81.19 });
  assert.equal(view.status, "Dead zone");
  assert.equal(view.touched, null);
  assert.equal(view.nextBuy.tag, "BUY1");
  assert.ok(Math.abs(view.nextBuy.triggerPrice - buy1) < 1e-8);
  assert.equal(view.nextShort.tag, "SHORT1");
  assert.ok(Math.abs(view.nextShort.triggerPrice - short1) < 1e-8);
  assert.equal(view.closer, "SHORT");
  assert.ok(Math.abs(view.nextBuyDistance.pct - (((buy1 - livePrice) / livePrice) * 100)) < 1e-10);
  assert.ok(Math.abs(view.nextShortDistance.pct - (((short1 - livePrice) / livePrice) * 100)) < 1e-10);
});

test("price through BUY1 reports BUY1 and advances next BUY to BUY2", () => {
  const view = summarizeSolanaRingPosition({ price: 61.8, ma: 81.19 });
  assert.equal(view.status, "BUY ring zone");
  assert.equal(view.touched.tag, "BUY1");
  assert.equal(view.touched.status, "THROUGH");
  assert.equal(view.touched.usd, 6);
  assert.equal(view.nextBuy.tag, "BUY2");
  assert.ok(Math.abs(view.nextBuy.triggerPrice - 59.2687) < 1e-8);
  assert.equal(view.nextShort.tag, "SHORT1");
});

test("ring query calculations are read-only deterministic values", () => {
  const first = summarizeSolanaRingPosition({ price: 90, ma: 100 });
  const second = summarizeSolanaRingPosition({ price: 90, ma: 100 });
  assert.deepEqual(first, second);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.levels));
});
