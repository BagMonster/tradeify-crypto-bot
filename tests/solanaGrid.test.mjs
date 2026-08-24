import test from "node:test";
import assert from "node:assert/strict";
import {
  GRID_DEFINITION,
  applyConfirmedEntry,
  applyConfirmedExit,
  applySkippedExit,
  createInitialSolanaState,
  entryCandidates,
  expectedNetUnits,
  grossVirtualExposureUsd,
  nextExitAction,
  observeRearm
} from "../src/strategies/solanaGrid.js";

test("frozen SOL geometry is 8 mirrored active rings outside the 18% dead zone", () => {
  const state = createInitialSolanaState();
  assert.equal(state.rings.length, 16);
  assert.deepEqual(state.rings.slice(0, 4).map((r) => r.tag), ["BUY1", "SELL1", "BUY2", "SELL2"]);
  assert.equal(state.rings.find((r) => r.tag === "BUY1").distance, -0.225);
  assert.equal(state.rings.find((r) => r.tag === "SELL1").distance, 0.225);
  assert.equal(state.rings.find((r) => r.tag === "BUY8").distance, -0.54);
  assert.equal(state.rings.find((r) => r.tag === "SELL8").distance, 0.54);
  assert.equal(state.rings.find((r) => r.tag === "BUY1").usd, 6);
  assert.ok(Math.abs(state.rings.find((r) => r.tag === "BUY8").usd - 367.3320192) < 1e-8);
  assert.equal(GRID_DEFINITION.grossExposureCeilingUsd, 1830);
});

test("entry is tied to moving MA ring and re-arms after a live half-band excursion", () => {
  const initial = createInitialSolanaState();
  const candidates = entryCandidates(initial, { previousPrice: 80, price: 77.5, ma: 100 });
  const buy1 = candidates.find((x) => x.tag === "BUY1");
  assert.ok(buy1);
  assert.equal(buy1.ringLevel, 77.5);
  assert.equal(buy1.quantity, 0.07);

  const filled = applyConfirmedEntry(initial, buy1, {
    fillPrice: 77.5,
    filledQuantity: 0.07,
    filledAt: "2026-08-23T20:00:00.000Z"
  });
  assert.equal(filled.rings.find((r) => r.tag === "BUY1").armed, false);
  assert.equal(expectedNetUnits(filled), 0.07);

  const notFarEnough = observeRearm(filled, { price: 79.74, ma: 100 });
  assert.equal(notFarEnough.version, filled.version);
  const rearmed = observeRearm(filled, { price: 79.75, ma: 100 });
  assert.equal(rearmed.rings.find((r) => r.tag === "BUY1").armed, true);
});

test("tranche weights use original units, skip sub-lot tranche, and final state uses confirmed quantities", () => {
  const initial = createInitialSolanaState();
  const buy1 = entryCandidates(initial, { previousPrice: 80, price: 77.5, ma: 100 }).find((x) => x.tag === "BUY1");
  let state = applyConfirmedEntry(initial, buy1, {
    fillPrice: 77.5,
    filledQuantity: 0.07,
    filledAt: "2026-08-23T20:00:00.000Z"
  });

  const tp1 = nextExitAction(state, { price: 83.125, ma: 100 });
  assert.equal(tp1.type, "SKIP_EXIT");
  assert.equal(tp1.tranche, 1);
  state = applySkippedExit(state, tp1);

  const tp2 = nextExitAction(state, { price: 88.75, ma: 100 });
  assert.equal(tp2.type, "EXIT");
  assert.equal(tp2.tranche, 2);
  assert.equal(tp2.quantity, 0.01);
  state = applyConfirmedExit(state, tp2, {
    fillPrice: 88.75,
    filledQuantity: 0.01,
    filledAt: "2026-08-23T20:01:00.000Z"
  });
  const lot = state.rings.find((r) => r.tag === "BUY1").lots[0];
  assert.equal(lot.remainingUnits, 0.06);
  assert.equal(lot.done, 2);
});

test("gross exposure counts both virtual sides while expected broker quantity nets them", () => {
  let state = createInitialSolanaState();
  const buy = entryCandidates(state, { previousPrice: 80, price: 77.5, ma: 100 }).find((x) => x.tag === "BUY1");
  state = applyConfirmedEntry(state, buy, { fillPrice: 77.5, filledQuantity: 0.07, filledAt: "2026-08-23T20:00:00.000Z" });
  const sell = entryCandidates(state, { previousPrice: 120, price: 122.5, ma: 100 }).find((x) => x.tag === "SELL1");
  const sellCurrent = { ...sell, stateVersion: state.version, lotId: `SELL1-V${state.version}` };
  state = applyConfirmedEntry(state, sellCurrent, { fillPrice: 122.5, filledQuantity: 0.04, filledAt: "2026-08-23T20:05:00.000Z" });
  assert.equal(expectedNetUnits(state), 0.03);
  assert.equal(grossVirtualExposureUsd(state, 100), 11);
});
