import test from "node:test";
import assert from "node:assert/strict";
import { createBinanceMarkCache } from "../src/market/binanceMarkCache.js";

test("quiet connected book keeps its trade mark while one background REST confirmation is cached", async () => {
  let nowMs = 1_000;
  let calls = 0;
  let resolveFetch;
  const cache = createBinanceMarkCache({
    symbol: "RUNEUSDT",
    now: () => nowMs,
    refreshAfterMs: 5_000,
    fetchImpl: async () => {
      calls += 1;
      await new Promise((resolve) => { resolveFetch = resolve; });
      return { ok: true, json: async () => ({ price: "0.7123" }) };
    }
  });

  const first = cache.read({ connected: true, lastTrade: { price: 0.71, tradeTime: new Date(nowMs - 60_000).toISOString() } });
  assert.equal(first.price, 0.71);
  assert.equal(first.source, "BINANCE_TRADE_MARK");
  cache.read({ connected: true, lastTrade: { price: 0.71, tradeTime: new Date(nowMs - 60_000).toISOString() } });
  await Promise.resolve();
  assert.equal(calls, 1);

  resolveFetch();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const confirmed = cache.read({ connected: true, lastTrade: { price: 0.71, tradeTime: new Date(nowMs - 60_000).toISOString() } });
  assert.equal(confirmed.price, 0.7123);
  assert.equal(confirmed.source, "BINANCE_REST_MARK");

  nowMs += 1_000;
  cache.read({ connected: true, lastTrade: { price: 0.71, tradeTime: new Date(nowMs - 60_000).toISOString() } });
  assert.equal(calls, 1);
});

test("dead connection without a cached REST mark is unavailable but only starts one request", async () => {
  let calls = 0;
  let rejectFetch;
  const cache = createBinanceMarkCache({
    symbol: "CAKEUSDT",
    fetchImpl: () => {
      calls += 1;
      return new Promise((resolve, reject) => { rejectFetch = reject; });
    }
  });

  assert.equal(cache.read({ connected: false, lastTrade: null }), null);
  assert.equal(cache.read({ connected: false, lastTrade: null }), null);
  await Promise.resolve();
  assert.equal(calls, 1);
  rejectFetch(new Error("offline"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cache.getState().lastError, "offline");
});

test("quiet connected stream fails closed only after its background REST confirmation fails", async () => {
  let rejectFetch;
  const cache = createBinanceMarkCache({
    symbol: "CHZUSDT",
    fetchImpl: () => new Promise((resolve, reject) => { rejectFetch = reject; })
  });
  const lastTrade = { price: 0.11, tradeTime: new Date(Date.now() - 60_000).toISOString() };
  assert.equal(cache.read({ connected: true, tradeQuiet: true, lastTrade })?.source, "BINANCE_TRADE_MARK");
  await Promise.resolve();
  rejectFetch(new Error("REST unavailable"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cache.read({ connected: true, tradeQuiet: true, lastTrade }), null);
});
