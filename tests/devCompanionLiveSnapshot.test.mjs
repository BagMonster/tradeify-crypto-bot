import test from "node:test";
import assert from "node:assert/strict";
import {
  diagnoseLiveSnapshot,
  formatLiveSnapshot,
  isLiveSnapshotStale,
  sanitizeLiveSnapshot
} from "../src/devCompanionLiveSnapshot.js";

const now = Date.parse("2026-08-26T16:00:00.000Z");

test("sanitize drops secrets and flags a virtual/broker mismatch", () => {
  const snapshot = sanitizeLiveSnapshot({
    capturedAt: "2026-08-26T16:00:00.000Z",
    binancePrice: 94.12,
    virtualNetUnits: -0.06,
    brokerNetUnits: 0,
    occupiedRings: ["SELL3", "drop this", "../../../etc"],
    haltReason: "virtual net -0.06 vs broker 0",
    password: "nope",
    databaseUrl: "postgres://secret"
  }, { now });
  assert.equal(snapshot.mismatch, true);
  assert.deepEqual(snapshot.occupiedRings, ["SELL3"]);
  assert.equal(snapshot.haltReason, "virtual net -0.06 vs broker 0");
  assert.equal(Object.hasOwn(snapshot, "password"), false);
  assert.equal(Object.hasOwn(snapshot, "databaseUrl"), false);
});

test("diagnosis leads with halt and mismatch before anything else", () => {
  const snapshot = sanitizeLiveSnapshot({
    capturedAt: "2026-08-26T16:00:00.000Z",
    virtualNetUnits: -0.06,
    brokerNetUnits: 0,
    operatorPaused: true,
    safetyHalt: true,
    haltReason: "SOL virtual-lot state does not reconcile to the DXtrade net SOL position; owner review required"
  }, { now });
  const lines = diagnoseLiveSnapshot(snapshot, now);
  assert.match(lines[0], /Safety halt is ACTIVE/);
  assert.equal(lines.some((line) => /mismatch/.test(line)), true);
  assert.equal(lines.some((line) => /Operator pause is ACTIVE/.test(line)), true);
  const text = formatLiveSnapshot(snapshot, now);
  assert.match(text, /DIAGNOSIS/);
  assert.match(text, /Do not \/resume until reconciled/);
});

test("missing or old snapshots are marked unusable", () => {
  assert.equal(isLiveSnapshotStale(null, now), true);
  const stale = sanitizeLiveSnapshot({ capturedAt: "2026-08-26T15:50:00.000Z" }, { now });
  assert.equal(isLiveSnapshotStale(stale, now), true);
  const fresh = sanitizeLiveSnapshot({ capturedAt: "2026-08-26T15:59:00.000Z" }, { now });
  assert.equal(isLiveSnapshotStale(fresh, now), false);
});
