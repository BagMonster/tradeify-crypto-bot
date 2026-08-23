import test from "node:test";
import assert from "node:assert/strict";
import {
  createBinanceLiveFeedIdentity,
  normalizeBinanceTrade
} from "../src/market/binanceLiveFeed.js";

test("SOLUSDT feed identity uses the SOL trade stream", () => {
  assert.deepEqual(createBinanceLiveFeedIdentity("SOLUSDT"), {
    source: "binance",
    symbol: "SOLUSDT",
    url: "wss://data-stream.binance.vision/ws/solusdt@trade"
  });
});

test("SOLUSDT trade normalization preserves source and symbol", () => {
  const trade = normalizeBinanceTrade({
    e: "trade",
    E: 1_800_000_000_000,
    s: "SOLUSDT",
    t: 42,
    p: "145.25",
    q: "3.5",
    T: 1_800_000_000_000
  }, 1_800_000_000_100, "SOLUSDT");

  assert.equal(trade.source, "binance");
  assert.equal(trade.symbol, "SOLUSDT");
  assert.equal(trade.price, 145.25);
  assert.equal(trade.quantity, 3.5);
});

test("configured symbol rejects cross-asset messages", () => {
  assert.throws(() => normalizeBinanceTrade({
    e: "trade",
    E: 1_800_000_000_000,
    s: "BTCUSDT",
    t: 42,
    p: "70000",
    q: "0.01",
    T: 1_800_000_000_000
  }, 1_800_000_000_100, "SOLUSDT"), /must be SOLUSDT/);
});
