import test from "node:test";
import assert from "node:assert/strict";
import {
  trancheTarget,
  lotTargets,
  formatInstrumentTargets
} from "../src/format/instrumentTargets.js";

const FLOOR = 0.0018;

const INJ = {
  entryPrice: 6.49,
  ma: 4.3281,
  side: "SELL",
  roundTripCostFloor: FLOOR
};

function definition(overrides = {}) {
  return {
    instrument: "INJ/USD",
    roundTripCostFloor: FLOOR,
    trancheWeights: [1, 1, 1, 1],
    trancheWeightSum: 4,
    lotStep: 0.01,
    band: 0.05,
    deadZoneBands: 3,
    activeLevelsPerSide: 12,
    ...overrides
  };
}

test("trancheTarget for a SHORT lot is below entry and T4 equals the MA", () => {
  const t1 = trancheTarget({ ...INJ, tranche: 1 });
  const t2 = trancheTarget({ ...INJ, tranche: 2 });
  const t3 = trancheTarget({ ...INJ, tranche: 3 });
  const t4 = trancheTarget({ ...INJ, tranche: 4 });
  assert.ok(t1 < INJ.entryPrice);
  assert.ok(t2 < t1);
  assert.ok(t3 < t2);
  assert.equal(Number(t4.toFixed(4)), INJ.ma);
  assert.equal(Number(t1.toFixed(4)), 5.9495);
  assert.equal(Number(t2.toFixed(4)), 5.4091);
  assert.equal(Number(t3.toFixed(4)), 4.8686);
  assert.equal(Number(t4.toFixed(4)), 4.3281);
});

test("trancheTarget for a LONG lot is above entry", () => {
  const long = { entryPrice: 90, ma: 120, side: "BUY", roundTripCostFloor: FLOOR };
  const t1 = trancheTarget({ ...long, tranche: 1 });
  const t4 = trancheTarget({ ...long, tranche: 4 });
  assert.ok(t1 > long.entryPrice);
  assert.ok(t4 >= t1);
  assert.equal(Number(t4.toFixed(4)), long.ma);
});

test("round-trip cost floor binds when entry is already at the MA", () => {
  const buy = trancheTarget({
    entryPrice: 100,
    ma: 100,
    side: "BUY",
    tranche: 1,
    roundTripCostFloor: FLOOR
  });
  const sell = trancheTarget({
    entryPrice: 100,
    ma: 100,
    side: "SELL",
    tranche: 1,
    roundTripCostFloor: FLOOR
  });
  assert.ok(buy >= 100 * (1 + FLOOR));
  assert.ok(sell <= 100 * (1 - FLOOR));
});

test("lotTargets marks completed tranches DONE and exactly one tranche NEXT", () => {
  const rows = lotTargets({
    lot: {
      side: "SELL",
      entryPrice: 6.49,
      done: 1,
      remainingUnits: 25.55,
      originalUnits: 34.07
    },
    ma: 4.3281,
    definition: definition()
  });
  assert.equal(rows.length, 4);
  assert.equal(rows[0].status, "DONE");
  assert.equal(rows[1].status, "NEXT");
  assert.equal(rows[2].status, "pending");
  assert.equal(rows[3].status, "pending");
  assert.equal(rows.filter((row) => row.status === "NEXT").length, 1);
});

test("lotTargets uses trancheDenominator when trancheWeightSum is absent", () => {
  const rows = lotTargets({
    lot: {
      side: "SELL",
      entryPrice: 6.4902,
      done: 0,
      remainingUnits: 34.07,
      originalUnits: 34.07
    },
    ma: 4.3281,
    definition: definition({
      trancheWeights: [1, 2, 3, 4],
      trancheWeightSum: undefined,
      trancheDenominator: 10,
      lotStep: 0.01
    })
  });
  assert.equal(rows[0].units, 3.4);
  assert.equal(rows[1].units, 6.81);
  assert.equal(rows[2].units, 10.22);
  assert.equal(rows[3].units, 34.07);
  assert.ok(Number.isFinite(rows[0].estimatedUsd));
  assert.ok(!Number.isNaN(rows[0].units));
});

test("formatInstrumentTargets with no open lots returns the empty message", () => {
  const text = formatInstrumentTargets({
    definition: definition(),
    gridState: { rings: [] },
    price: 6.5,
    ma: 4.3281
  });
  assert.match(text, /No open lots\. Nothing to take profit on\./);
});
