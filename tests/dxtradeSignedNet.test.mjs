import test from "node:test";
import assert from "node:assert/strict";
import {
  applyOpenPositionsOverlay,
  netsMatch,
  signedNetFromOpenPositions,
  signedPositionQuantity
} from "../src/account/dxtradeSignedNet.js";

test("SELL side quantity is signed short even when the API returns a positive size", () => {
  assert.equal(signedPositionQuantity({ quantity: 0.44, side: "SELL" }), -0.44);
  assert.equal(signedPositionQuantity({ qty: 0.44, direction: "SHORT" }), -0.44);
  assert.equal(signedPositionQuantity({ quantity: -0.44 }), -0.44);
});

test("open-positions overlay fills a metrics snapshot that claimed the account was flat", () => {
  const snapshot = {
    instrument: "SOL/USD",
    openPositionsCount: 0,
    instrumentPosition: null,
    currentNotional: 0,
    signedNetUnits: 0,
    positionSource: "metrics",
    invariantError: null,
    accountLocked: false
  };
  const next = applyOpenPositionsOverlay(snapshot, {
    positions: [{ symbol: "SOL/USD", quantity: 0.44, side: "Sell", markPrice: 95.91, avgOpenPrice: 95.91 }]
  }, "SOL/USD");
  assert.equal(next.positionSource, "open-positions");
  assert.equal(next.signedNetUnits, -0.44);
  assert.equal(next.openPositionsCount, 1);
  assert.equal(next.instrumentPosition.quantity, -0.44);
  assert.equal(next.accountLocked, false);
  assert.equal(netsMatch(-0.44, next.signedNetUnits), true);
});

test("open-positions parser rejects a foreign instrument", () => {
  const result = signedNetFromOpenPositions({
    positions: [{ symbol: "XRP/USD", quantity: 10, side: "BUY" }]
  }, "SOL/USD");
  assert.equal(result.ok, false);
  assert.match(result.error, /non-SOL\/USD/);
});

test("invalid open-positions book locks the snapshot instead of keeping metrics-flat", () => {
  const snapshot = {
    instrument: "SOL/USD",
    openPositionsCount: 0,
    instrumentPosition: null,
    currentNotional: 0,
    signedNetUnits: 0,
    positionSource: "metrics",
    invariantError: null,
    accountLocked: false
  };
  const next = applyOpenPositionsOverlay(snapshot, {
    positions: [{ symbol: "XRP/USD", quantity: 10, side: "BUY", markPrice: 0.5, avgOpenPrice: 0.5 }]
  }, "SOL/USD");
  assert.equal(next.positionSource, "open-positions-invalid");
  assert.equal(next.signedNetUnits, null);
  assert.equal(next.accountLocked, true);
  assert.match(next.invariantError, /non-SOL\/USD/);
  assert.equal(next.overlayError, next.invariantError);
});
