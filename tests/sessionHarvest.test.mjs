import test from "node:test";
import assert from "node:assert/strict";
import { shouldHarvest } from "../src/risk/sessionHarvest.js";

test("shouldHarvest is false when disabled", () => {
  assert.equal(shouldHarvest({
    enabled: false,
    thresholdUsd: 250,
    flattenedToday: false,
    harvestedToday: false,
    combinedDayPnlUsd: 400,
    readings: [{ exposureUsd: 100 }]
  }), false);
});

test("shouldHarvest is false below the threshold or with no exposure", () => {
  assert.equal(shouldHarvest({
    enabled: true,
    thresholdUsd: 250,
    flattenedToday: false,
    harvestedToday: false,
    combinedDayPnlUsd: 249.99,
    readings: [{ exposureUsd: 100 }]
  }), false);
  assert.equal(shouldHarvest({
    enabled: true,
    thresholdUsd: 250,
    flattenedToday: false,
    harvestedToday: false,
    combinedDayPnlUsd: 400,
    readings: [{ exposureUsd: 0 }, { exposureUsd: 0 }]
  }), false);
});

test("shouldHarvest is true at threshold with open exposure", () => {
  assert.equal(shouldHarvest({
    enabled: true,
    thresholdUsd: 250,
    flattenedToday: false,
    harvestedToday: false,
    combinedDayPnlUsd: 250,
    readings: [{ exposureUsd: 10 }]
  }), true);
});

test("shouldHarvest yields to risk flatten and to an earlier harvest", () => {
  assert.equal(shouldHarvest({
    enabled: true,
    thresholdUsd: 250,
    flattenedToday: true,
    harvestedToday: false,
    combinedDayPnlUsd: 400,
    readings: [{ exposureUsd: 10 }]
  }), false);
  assert.equal(shouldHarvest({
    enabled: true,
    thresholdUsd: 250,
    flattenedToday: false,
    harvestedToday: true,
    combinedDayPnlUsd: 400,
    readings: [{ exposureUsd: 10 }]
  }), false);
});
