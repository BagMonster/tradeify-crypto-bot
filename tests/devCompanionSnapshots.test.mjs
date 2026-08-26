import test from "node:test";
import assert from "node:assert/strict";
import { formatSnapshotPack, snapshotSlot, upsertSnapshotPack } from "../src/devCompanionSnapshots.js";

test("status and levels occupy separate sticky slots", () => {
  const pack = upsertSnapshotPack(
    upsertSnapshotPack({}, "/status", "HALT virtual != broker"),
    "/levels",
    "SHORT3 DISARMED 1/2"
  );
  const formatted = formatSnapshotPack(pack);
  assert.deepEqual(formatted.present, ["/status", "/levels"]);
  assert.ok(formatted.missing.includes("/rings"));
  assert.match(formatted.text, /HALT virtual != broker/);
  assert.match(formatted.text, /SHORT3 DISARMED 1\/2/);
});

test("dxpreflight maps to the other slot", () => {
  assert.equal(snapshotSlot("/dxpreflight"), "/other");
});
