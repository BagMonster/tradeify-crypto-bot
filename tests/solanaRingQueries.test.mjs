import test from "node:test";
import assert from "node:assert/strict";
import { buildSolanaRingLevels, summarizeSolanaRingPosition } from "../src/monitoring/solanaRingQueries.js";

test("ring query geometry matches frozen D-049 10x10 SOL baseline", () => {
  const levels = buildSolanaRingLevels({ ma: 100 });
  // D-049: deadZoneBands 2, activeLevelsPerSide 10, baseUsd 28.68, growth 1.5.
  // Trigger = ma * (1 -/+ 0.045 * (2 + n)); ring USD = 28.68 * 1.5^(n-1).
  assert.equal(levels.buys.length, 10);
  assert.equal(levels.shorts.length, 10);
  assert.ok(Math.abs(levels.buys[0].triggerPrice - 86.5) < 1e-10);
  assert.ok(Math.abs(levels.shorts[0].triggerPrice - 113.5) < 1e-10);
  assert.ok(Math.abs(levels.buys[9].triggerPrice - 46) < 1e-10);
  assert.ok(Math.abs(levels.shorts[9].triggerPrice - 154) < 1e-10);
  assert.equal(levels.buys[0].usd, 28.68);
  assert.ok(Math.abs(levels.buys[9].usd - 1102.555546875) < 1e-10);
});

test("dead-zone query returns the nearest BUY and SHORT levels", () => {
  const livePrice = 85;          // inside the D-049 dead zone (70.22935 .. 92.15065)
  const buy1 = 70.22935;         // 81.19 * (1 - 0.135)
  const short1 = 92.15065;       // 81.19 * (1 + 0.135)
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
  const view = summarizeSolanaRingPosition({ price: 69, ma: 81.19 });  // through BUY1, above BUY2
  assert.equal(view.status, "BUY ring zone");
  assert.equal(view.touched.tag, "BUY1");
  assert.equal(view.touched.status, "THROUGH");
  assert.equal(view.touched.usd, 28.68);
  assert.equal(view.nextBuy.tag, "BUY2");
  assert.ok(Math.abs(view.nextBuy.triggerPrice - 66.5758) < 1e-8);  // 81.19 * (1 - 0.18)
  assert.equal(view.nextShort.tag, "SHORT1");
});

test("ring query calculations are read-only deterministic values", () => {
  const first = summarizeSolanaRingPosition({ price: 90, ma: 100 });
  const second = summarizeSolanaRingPosition({ price: 90, ma: 100 });
  assert.deepEqual(first, second);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.levels));
});
