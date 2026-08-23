import test from "node:test";
import assert from "node:assert/strict";
import {
  applyConfirmedGridFill,
  createInitialGridState,
  evaluateGridIntent,
  resetGridAfterProtectiveFlatten
} from "../src/strategies/grid.js";

test("frozen grid emits BUY1 at exactly -4% and advances only on confirmed fill", () => {
  const state = createInitialGridState(70_000);
  assert.equal(evaluateGridIntent(state, 67_201), null);
  const intent = evaluateGridIntent(state, 67_200);
  assert.equal(intent.tag, "BUY1");
  assert.equal(intent.usd, 250);
  assert.equal(state.referencePrice, 70_000);
  assert.equal(state.version, 0);

  const next = applyConfirmedGridFill(state, intent, {
    fillPrice: 67_233.6,
    filledAt: "2026-08-23T01:00:00.000Z"
  });
  assert.equal(next.referencePrice, 67_233.6);
  assert.equal(next.buyCount, 1);
  assert.equal(next.buyPtr, 1);
  assert.equal(next.sellCount, 0);
  assert.equal(next.version, 1);
});

test("opposite confirmed fill resets the other side and uses actual fill as reference", () => {
  let state = createInitialGridState(100);
  let intent = evaluateGridIntent(state, 96);
  state = applyConfirmedGridFill(state, intent, { fillPrice: 95.9, filledAt: "2026-08-23T01:00:00.000Z" });
  intent = evaluateGridIntent(state, 87.2);
  state = applyConfirmedGridFill(state, intent, { fillPrice: 87.1, filledAt: "2026-08-23T02:00:00.000Z" });
  assert.equal(state.buyCount, 2);

  intent = evaluateGridIntent(state, 90.37);
  assert.equal(intent.tag, "SELL1");
  state = applyConfirmedGridFill(state, intent, { fillPrice: 90.4, filledAt: "2026-08-23T03:00:00.000Z" });
  assert.equal(state.buyCount, 0);
  assert.equal(state.buyPtr, 0);
  assert.equal(state.sellCount, 1);
  assert.equal(state.referencePrice, 90.4);
});

test("stale intent cannot advance a newer grid state", () => {
  const state = createInitialGridState(100);
  const intent = evaluateGridIntent(state, 96);
  const newer = resetGridAfterProtectiveFlatten(state, { fillPrice: 99, filledAt: "2026-08-23T01:00:00.000Z" });
  assert.throws(() => applyConfirmedGridFill(newer, intent, {
    fillPrice: 95.9,
    filledAt: "2026-08-23T01:00:01.000Z"
  }), /stale/i);
});

test("protective flatten resets both ladders and re-anchors to its actual fill", () => {
  let state = createInitialGridState(100);
  const intent = evaluateGridIntent(state, 96);
  state = applyConfirmedGridFill(state, intent, { fillPrice: 95.9, filledAt: "2026-08-23T01:00:00.000Z" });
  const reset = resetGridAfterProtectiveFlatten(state, { fillPrice: 94.2, filledAt: "2026-08-23T01:05:00.000Z" });
  assert.deepEqual({ buyCount: reset.buyCount, buyPtr: reset.buyPtr, sellCount: reset.sellCount, sellPtr: reset.sellPtr },
    { buyCount: 0, buyPtr: 0, sellCount: 0, sellPtr: 0 });
  assert.equal(reset.referencePrice, 94.2);
  assert.equal(reset.lastFillSide, "PROTECTIVE_FLAT");
});
