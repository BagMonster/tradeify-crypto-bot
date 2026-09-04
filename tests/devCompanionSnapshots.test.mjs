import test from "node:test";
import assert from "node:assert/strict";
import { appendAlertTape, formatSnapshotPack, snapshotSlot, upsertSnapshotPack } from "../src/devCompanionSnapshots.js";

test("status and levels occupy separate sticky slots", () => {
  const pack = upsertSnapshotPack(
    upsertSnapshotPack({}, "/status", "HALT virtual != broker"),
    "/levels",
    "SHORT3 DISARMED 1/2"
  );
  const formatted = formatSnapshotPack(pack);
  assert.ok(formatted.present.includes("/status"));
  assert.ok(formatted.present.includes("/levels"));
  assert.ok(formatted.missing.includes("/rings"));
  assert.match(formatted.text, /HALT virtual != broker/);
  assert.match(formatted.text, /SHORT3 DISARMED 1\/2/);
});

test("dxpreflight maps to the other slot", () => {
  assert.equal(snapshotSlot("/dxpreflight"), "/other");
});

test("alerts append and do not overwrite /status", () => {
  let pack = upsertSnapshotPack({}, "/status", "Virtual net: 60.52");
  pack = appendAlertTape(pack, "DOGE/USD TRANCHE EXIT CONFIRMED\nRemaining: 105.9 DOGE");
  pack = appendAlertTape(pack, "DOGE/USD NET MISMATCH — WARNING 1/3");
  const formatted = formatSnapshotPack(pack);
  assert.ok(formatted.present.includes("/status"));
  assert.ok(formatted.present.includes("/alerts"));
  assert.match(formatted.text, /Virtual net: 60\.52/);
  assert.match(formatted.text, /TRANCHE EXIT CONFIRMED/);
  assert.match(formatted.text, /WARNING 1\/3/);
});
