import test from "node:test";
import assert from "node:assert/strict";
import {
  GRID_DEFINITION,
  applyConfirmedEntry,
  applyConfirmedExit,
  applyConfirmedProtectiveCut,
  applySkippedExit,
  buildProtectiveCutPlan,
  createInitialSolanaState,
  entryCandidates,
  expectedNetUnits,
  grossVirtualExposureUsd,
  nextExitAction,
  observeRearm
} from "../src/strategies/solanaGrid.js";

function approximately(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

test("D-049 SOL geometry is 10 mirrored rings from 13.5% through 54%", () => {
  const state = createInitialSolanaState();
  assert.equal(state.rings.length, 20);
  assert.deepEqual(state.rings.slice(0, 4).map((r) => r.tag), ["BUY1", "SELL1", "BUY2", "SELL2"]);
  approximately(state.rings.find((r) => r.tag === "BUY1").distance, -0.135);
  approximately(state.rings.find((r) => r.tag === "SELL1").distance, 0.135);
  approximately(state.rings.find((r) => r.tag === "BUY10").distance, -0.54);
  approximately(state.rings.find((r) => r.tag === "SELL10").distance, 0.54);
  approximately(state.rings.find((r) => r.tag === "BUY1").usd, 28.68);
  approximately(state.rings.find((r) => r.tag === "BUY10").usd, 1102.561015625);
  assert.equal(GRID_DEFINITION.deadZoneBands, 2);
  assert.equal(GRID_DEFINITION.activeLevelsPerSide, 10);
  assert.equal(GRID_DEFINITION.grossExposureCeilingUsd, 6600);
});

test("entry is tied to moving MA ring and re-arms after a live half-band excursion", () => {
  const initial = createInitialSolanaState();
  const candidates = entryCandidates(initial, { previousPrice: 90, price: 86.5, ma: 100 });
  const buy1 = candidates.find((x) => x.tag === "BUY1");
  assert.ok(buy1);
  assert.equal(buy1.ringLevel, 86.5);
  assert.equal(buy1.quantity, 0.33);

  const filled = applyConfirmedEntry(initial, buy1, {
    fillPrice: 86.5,
    filledQuantity: 0.33,
    filledAt: "2026-08-24T20:00:00.000Z"
  });
  assert.equal(filled.rings.find((r) => r.tag === "BUY1").armed, false);
  assert.equal(expectedNetUnits(filled), 0.33);

  const notFarEnough = observeRearm(filled, { price: 88.74, ma: 100 });
  assert.equal(notFarEnough.version, filled.version);
  const rearmed = observeRearm(filled, { price: 88.75, ma: 100 });
  assert.equal(rearmed.rings.find((r) => r.tag === "BUY1").armed, true);
});

test("tranche weights still use original units and sub-lot tranches skip", () => {
  const initial = createInitialSolanaState();
  const normal = entryCandidates(initial, { previousPrice: 90, price: 86.5, ma: 100 }).find((x) => x.tag === "BUY1");
  const buy1 = { ...normal, quantity: 0.07 };
  let state = applyConfirmedEntry(initial, buy1, {
    fillPrice: 86.5,
    filledQuantity: 0.07,
    filledAt: "2026-08-24T20:00:00.000Z"
  });

  const tp1 = nextExitAction(state, { price: 89.875, ma: 100 });
  assert.equal(tp1.type, "SKIP_EXIT");
  assert.equal(tp1.tranche, 1);
  state = applySkippedExit(state, tp1);

  const tp2 = nextExitAction(state, { price: 93.25, ma: 100 });
  assert.equal(tp2.type, "EXIT");
  assert.equal(tp2.tranche, 2);
  assert.equal(tp2.quantity, 0.01);
  state = applyConfirmedExit(state, tp2, {
    fillPrice: 93.25,
    filledQuantity: 0.01,
    filledAt: "2026-08-24T20:01:00.000Z"
  });
  const lot = state.rings.find((r) => r.tag === "BUY1").lots[0];
  assert.equal(lot.remainingUnits, 0.06);
  assert.equal(lot.done, 2);
});

test("D-049 protective cut reduces both remaining and original quantity", () => {
  const initial = createInitialSolanaState();
  const buy = entryCandidates(initial, { previousPrice: 90, price: 86.5, ma: 100 }).find((x) => x.tag === "BUY1");
  let state = applyConfirmedEntry(initial, buy, {
    fillPrice: 86.5,
    filledQuantity: 0.33,
    filledAt: "2026-08-24T20:00:00.000Z"
  });
  const plan = buildProtectiveCutPlan(state, 0.5);
  assert.equal(plan.side, "SELL");
  assert.equal(plan.quantity, 0.16);
  assert.equal(plan.legs.length, 1);

  state = applyConfirmedProtectiveCut(state, plan, {
    fillPrice: 84,
    filledQuantity: 0.16,
    filledAt: "2026-08-24T20:02:00.000Z"
  });
  const lot = state.rings.find((r) => r.tag === "BUY1").lots[0];
  assert.equal(lot.remainingUnits, 0.17);
  assert.equal(lot.originalUnits, 0.17);
  assert.equal(expectedNetUnits(state), 0.17);
});

test("D-049 protective cut fails closed on mixed virtual sides", () => {
  let state = createInitialSolanaState();
  const buy = entryCandidates(state, { previousPrice: 90, price: 86.5, ma: 100 }).find((x) => x.tag === "BUY1");
  state = applyConfirmedEntry(state, buy, { fillPrice: 86.5, filledQuantity: 0.33, filledAt: "2026-08-24T20:00:00.000Z" });
  const sell = entryCandidates(state, { previousPrice: 112, price: 113.5, ma: 100 }).find((x) => x.tag === "SELL1");
  const currentSell = { ...sell, stateVersion: state.version, lotId: `SELL1-V${state.version}` };
  state = applyConfirmedEntry(state, currentSell, { fillPrice: 113.5, filledQuantity: 0.25, filledAt: "2026-08-24T20:05:00.000Z" });
  assert.throws(() => buildProtectiveCutPlan(state, 0.5), /share one side/i);
});

test("gross exposure counts both virtual sides while expected broker quantity nets them", () => {
  let state = createInitialSolanaState();
  const buy = entryCandidates(state, { previousPrice: 90, price: 86.5, ma: 100 }).find((x) => x.tag === "BUY1");
  assert.ok(buy);
  state = applyConfirmedEntry(state, buy, { fillPrice: 86.5, filledQuantity: 0.33, filledAt: "2026-08-24T20:00:00.000Z" });

  const sell = entryCandidates(state, { previousPrice: 112, price: 113.5, ma: 100 }).find((x) => x.tag === "SELL1");
  assert.ok(sell);
  const sellCurrent = { ...sell, stateVersion: state.version, lotId: `SELL1-V${state.version}` };
  state = applyConfirmedEntry(state, sellCurrent, { fillPrice: 113.5, filledQuantity: 0.25, filledAt: "2026-08-24T20:05:00.000Z" });
  assert.equal(expectedNetUnits(state), 0.08);
  assert.equal(grossVirtualExposureUsd(state, 100), 58);
});
