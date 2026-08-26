import test from "node:test";
import assert from "node:assert/strict";
import { createInitialSolanaState, expectedNetUnits, normalizeSolanaState } from "../src/strategies/solanaGrid.js";
import { describeVirtualBook, resetVirtualInventoryToEmpty } from "../src/state/solanaReconcile.js";

test("audited flatten empties lots, rearms rings, and increments version", () => {
  const initial = createInitialSolanaState();
  const dirty = normalizeSolanaState({
    ...initial,
    version: 1,
    rings: initial.rings.map((ring) => (
      ring.tag === "SELL3"
        ? {
          ...ring,
          armed: false,
          lots: [{
            id: "SELL3-legacy",
            side: "SELL",
            ringTag: "SELL3",
            entryPrice: 100.535,
            originalUnits: 0.06,
            remainingUnits: 0.06,
            done: 0,
            openedAt: "2026-08-25T00:08:45.929Z"
          }]
        }
        : ring
    )),
    lastFillAt: "2026-08-25T00:08:45.929Z",
    lastFillSide: "SELL",
    lastFillPrice: 100.535
  });

  assert.equal(expectedNetUnits(dirty), -0.06);
  const flat = resetVirtualInventoryToEmpty(dirty);
  const summary = describeVirtualBook(flat);
  assert.equal(flat.version, 2);
  assert.equal(summary.netUnits, 0);
  assert.equal(summary.openLots, 0);
  assert.deepEqual(summary.occupiedRings, []);
  assert.equal(flat.rings.find((ring) => ring.tag === "SELL3").armed, true);
  assert.equal(flat.lastFillAt, null);
});
