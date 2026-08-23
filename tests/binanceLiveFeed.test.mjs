import test from "node:test";
import assert from "node:assert/strict";
import { BINANCE_LIVE_FEED_IDENTITY, createBinanceLiveFeed, normalizeBinanceTrade } from "../src/market/binanceLiveFeed.js";

test("Binance trade normalization pins BTCUSDT identity", () => {
  const trade = normalizeBinanceTrade({
    e: "trade", E: 1787446800000, s: "BTCUSDT", t: 123, p: "65000.50", q: "0.001", T: 1787446799999
  }, 1787446800001);
  assert.equal(trade.source, "binance");
  assert.equal(trade.symbol, "BTCUSDT");
  assert.equal(trade.price, 65000.5);
  assert.throws(() => normalizeBinanceTrade({
    e: "trade", E: 1787446800000, s: "ETHUSDT", t: 123, p: "1", q: "1", T: 1787446799999
  }), /BTCUSDT/);
});

class MockWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    MockWebSocket.instances.push(this);
  }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  emit(type, event = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  open() { this.readyState = 1; this.emit("open"); }
  close() { this.readyState = 3; this.emit("close"); }
}

test("live feed starts stale, accepts monotonic BTC trades, and stops safely", () => {
  MockWebSocket.instances = [];
  const states = [];
  const prices = [];
  const errors = [];
  const setTimeoutImpl = (fn, ms) => ({ fn, ms, cleared: false, unref() {} });
  const clearTimeoutImpl = (timer) => { if (timer) timer.cleared = true; };
  const feed = createBinanceLiveFeed({
    webSocketImpl: MockWebSocket,
    now: () => 1787446800001,
    setTimeoutImpl,
    clearTimeoutImpl,
    onState: (state) => states.push(state),
    onPrice: (price) => prices.push(price),
    onError: (error) => errors.push(error)
  });

  feed.start();
  const ws = MockWebSocket.instances[0];
  assert.equal(ws.url, BINANCE_LIVE_FEED_IDENTITY.url);
  ws.open();
  assert.equal(feed.getState().stale, true);

  ws.emit("message", { data: JSON.stringify({
    e: "trade", E: 1787446800000, s: "BTCUSDT", t: 100, p: "65000", q: "0.001", T: 1787446799999
  }) });
  assert.equal(prices.length, 1);
  assert.equal(feed.getState().stale, false);

  ws.emit("message", { data: JSON.stringify({
    e: "trade", E: 1787446800000, s: "BTCUSDT", t: 100, p: "65001", q: "0.001", T: 1787446800000
  }) });
  assert.equal(prices.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /duplicate|out of order/i);

  feed.stop();
  assert.equal(feed.getState().running, false);
  assert.equal(feed.getState().stale, true);
  assert.ok(states.length >= 3);
});
