import test from "node:test";
import assert from "node:assert/strict";
import { formatRiskLadderLine } from "../src/multiInstrumentOwnerService.js";

test("D-063 snapshot prints every cut tier shallow-first", () => {
  const line = formatRiskLadderLine({
    entryBrakeUsd: 600,
    partialCutUsd: 1000,
    partialCutFraction: 0.5,
    fullFlattenUsd: 1250,
    cutTiers: [
      { thresholdUsd: 1000, fraction: 0.5 },
      { thresholdUsd: 750, fraction: 0.2 },
      { thresholdUsd: 500, fraction: 0.1 }
    ]
  });
  assert.match(line, /brake -\$600\.00 per instrument/);
  assert.match(line, /10% at -\$500\.00/);
  assert.match(line, /20% at -\$750\.00/);
  assert.match(line, /50% at -\$1000\.00/);
  assert.match(line, /flatten -\$1250\.00 account-wide/);
});

test("legacy snapshot without cutTiers still shows the single 50% cut", () => {
  const line = formatRiskLadderLine({
    entryBrakeUsd: 300,
    partialCutUsd: 1000,
    partialCutFraction: 0.5,
    fullFlattenUsd: 1250
  });
  assert.match(line, /brake -\$300\.00 per instrument/);
  assert.match(line, /50% at -\$1000\.00/);
  assert.doesNotMatch(line, /10% at/);
});
