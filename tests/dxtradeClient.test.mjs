import test from "node:test";
import assert from "node:assert/strict";
import {
  DxtradeReadOnlyClient,
  DxtradeReadOnlyError
} from "../src/dxtradeClient.js";

const BASE_CONFIG = {
  restBaseUrl: "https://dx.tradeifycrypto.co/dxsca-web",
  marketDataUrl: "wss://dx.tradeifycrypto.co/dxsca-web/md",
  username: "private-user",
  domain: "private-domain",
  password: "private-password",
  timeoutMs: 2_000
};

function jsonResponse(payload, status = 200) {
  return new Response(payload === null ? "" : JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function queuedFetch(responses, calls) {
  return async (url, options) => {
    calls.push({ url: url.toString(), options });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected fetch call");
    return next;
  };
}

class MockWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    MockWebSocket.instances.push(this);
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  send(value) {
    this.sent.push(value);
  }

  close() {
    this.readyState = 3;
    this.emit("close", {});
  }

  emit(type, event) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  open() {
    this.readyState = 1;
    this.emit("open", {});
  }
}

test("1 - constructor requires the verified secure Tradeify paths", () => {
  const invalid = [
    { restBaseUrl: "http://dx.tradeifycrypto.co/dxsca-web" },
    { restBaseUrl: "https://user:pass@dx.tradeifycrypto.co/dxsca-web" },
    { restBaseUrl: "https://dx.tradeifycrypto.co/api" },
    { marketDataUrl: "ws://dx.tradeifycrypto.co/dxsca-web/md" },
    { marketDataUrl: "wss://dx.tradeifycrypto.co/other" }
  ];

  for (const override of invalid) {
    assert.throws(() => new DxtradeReadOnlyClient({
      ...BASE_CONFIG,
      ...override,
      fetchImpl: async () => jsonResponse(null)
    }), TypeError);
  }
});

test("2 - login stores but never returns the session token", async () => {
  const calls = [];
  const client = new DxtradeReadOnlyClient({
    ...BASE_CONFIG,
    fetchImpl: queuedFetch([
      jsonResponse({ sessionToken: "top-secret-session-token", timeout: "PT30M" })
    ], calls)
  });

  const session = await client.login();
  assert.deepEqual(session, {
    authenticated: true,
    timeout: "PT30M",
    lastAuthenticatedAt: session.lastAuthenticatedAt
  });
  assert.equal(JSON.stringify(session).includes("top-secret-session-token"), false);
  assert.equal(calls[0].url, "https://dx.tradeifycrypto.co/dxsca-web/login");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    username: "private-user",
    domain: "private-domain",
    password: "private-password"
  });
  assert.equal(calls[0].options.headers.authorization, undefined);
  assert.equal(calls[0].options.redirect, "error");
});

test("3 - account reads use GET, auth, and encoded identifiers", async () => {
  const calls = [];
  const responses = [
    jsonResponse({ sessionToken: "session-token-123", timeout: "PT30M" }),
    jsonResponse({ users: [] }),
    jsonResponse({ portfolio: true }),
    jsonResponse({ positions: [] }),
    jsonResponse({ orders: [] }),
    jsonResponse({ metrics: [] }),
    jsonResponse({ instruments: [] })
  ];
  const client = new DxtradeReadOnlyClient({
    ...BASE_CONFIG,
    fetchImpl: queuedFetch(responses, calls)
  });

  await client.login();
  await client.getUser("owner/name");
  await client.getAccountPortfolio("clearing:account");
  await client.getOpenPositions("clearing:account");
  await client.getOpenOrders("clearing:account");
  await client.getAccountMetrics("clearing:account");
  await client.getInstrumentDetails("clearing:account", "BTC/USD");

  const reads = calls.slice(1);
  assert.equal(reads.every((call) => call.options.method === "GET"), true);
  assert.equal(reads.every((call) => call.options.headers.authorization === "DXAPI session-token-123"), true);
  assert.deepEqual(reads.map((call) => call.url), [
    "https://dx.tradeifycrypto.co/dxsca-web/users/owner%2Fname",
    "https://dx.tradeifycrypto.co/dxsca-web/accounts/clearing%3Aaccount/portfolio",
    "https://dx.tradeifycrypto.co/dxsca-web/accounts/clearing%3Aaccount/positions",
    "https://dx.tradeifycrypto.co/dxsca-web/accounts/clearing%3Aaccount/orders",
    "https://dx.tradeifycrypto.co/dxsca-web/accounts/clearing%3Aaccount/metrics",
    "https://dx.tradeifycrypto.co/dxsca-web/accounts/clearing%3Aaccount/instruments/BTC%2FUSD"
  ]);
});

test("4 - unauthorized response clears the session and redacts secrets", async () => {
  const calls = [];
  const client = new DxtradeReadOnlyClient({
    ...BASE_CONFIG,
    fetchImpl: queuedFetch([
      jsonResponse({ sessionToken: "session-token-123", timeout: "PT30M" }),
      jsonResponse({
        errorCode: 3,
        description: "private-user private-password session-token-123 rejected"
      }, 401)
    ], calls)
  });

  await client.login();
  await assert.rejects(
    client.getAccountMetrics("clearing:account"),
    (error) => {
      assert.ok(error instanceof DxtradeReadOnlyError);
      assert.equal(error.status, 401);
      assert.equal(error.apiCode, 3);
      assert.equal(error.message.includes("private-user"), false);
      assert.equal(error.message.includes("private-password"), false);
      assert.equal(error.message.includes("session-token-123"), false);
      return true;
    }
  );
  assert.equal(client.getSessionInfo().authenticated, false);
  await assert.rejects(client.getOpenOrders("clearing:account"), /not authenticated/i);
});

test("5 - public surface contains no trading or raw-request methods", () => {
  const names = Object.getOwnPropertyNames(DxtradeReadOnlyClient.prototype);
  const forbidden = [
    "placeOrder",
    "modifyOrder",
    "cancelOrder",
    "closePosition",
    "flatten",
    "request",
    "send"
  ];

  for (const method of forbidden) assert.equal(names.includes(method), false);
  assert.deepEqual(names.sort(), [
    "close",
    "constructor",
    "getAccountMetrics",
    "getAccountPortfolio",
    "getHistoricalCandles",
    "getInstrumentDetails",
    "getOpenOrders",
    "getOpenPositions",
    "getSessionInfo",
    "getUser",
    "listInstruments",
    "login",
    "logout",
    "ping",
    "startSessionKeepAlive",
    "stopSessionKeepAlive",
    "subscribeQuotes"
  ].sort());
});

test("6 - quote subscription sends only the approved market-data request", async () => {
  MockWebSocket.instances = [];
  const calls = [];
  const quotes = [];
  const states = [];
  const errors = [];
  const client = new DxtradeReadOnlyClient({
    ...BASE_CONFIG,
    fetchImpl: queuedFetch([
      jsonResponse({ sessionToken: "session-token-123", timeout: "PT30M" })
    ], calls),
    webSocketImpl: MockWebSocket
  });

  await client.login();
  const subscription = client.subscribeQuotes({
    accountCode: "clearing:account",
    symbols: ["BTC/USD", "BTC/USD"],
    onQuote: (quote) => quotes.push(quote),
    onState: (state) => states.push(state),
    onError: (error) => errors.push(error)
  });

  const socket = MockWebSocket.instances[0];
  assert.equal(socket.url, "wss://dx.tradeifycrypto.co/dxsca-web/md?format=JSON");
  socket.open();
  const request = JSON.parse(socket.sent[0]);
  assert.equal(request.type, "MarketDataSubscriptionRequest");
  assert.equal(request.session, "session-token-123");
  assert.equal(request.payload.account, "clearing:account");
  assert.deepEqual(request.payload.symbols, ["BTC/USD"]);
  assert.deepEqual(request.payload.eventTypes, [{ type: "Quote", format: "COMPACT" }]);
  assert.equal(Object.hasOwn(request, "order"), false);

  socket.emit("message", { data: JSON.stringify({
    type: "MarketData",
    inReplyTo: subscription.requestId,
    session: "session-token-123",
    payload: { events: [{
      type: "Quote",
      symbol: "BTC/USD",
      bid: 65000,
      ask: 65001,
      time: "2026-08-14T10:00:00Z"
    }] }
  }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].symbol, "BTC/USD");

  socket.emit("message", { data: JSON.stringify({
    type: "PingRequest",
    session: "session-token-123",
    timestamp: "2026-08-14T10:00:01Z"
  }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(socket.sent[1]).type, "Ping");
  assert.equal(errors.length, 0);

  subscription.close();
  assert.equal(states.at(-1).connected, false);
});

test("7 - Push API rejects are reported without exposing the session", async () => {
  MockWebSocket.instances = [];
  const errors = [];
  const client = new DxtradeReadOnlyClient({
    ...BASE_CONFIG,
    fetchImpl: queuedFetch([
      jsonResponse({ sessionToken: "session-token-123", timeout: "PT30M" })
    ], []),
    webSocketImpl: MockWebSocket
  });

  await client.login();
  client.subscribeQuotes({
    accountCode: "clearing:account",
    symbols: ["BTC/USD"],
    onQuote: () => {},
    onError: (error) => errors.push(error)
  });
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.emit("message", { data: JSON.stringify({
    type: "Reject",
    session: "session-token-123",
    payload: {
      errorCode: 34,
      description: "session-token-123 has no proper permission"
    }
  }) });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(errors.length, 1);
  assert.equal(errors[0].apiCode, 34);
  assert.equal(errors[0].message.includes("session-token-123"), false);
});

test("8 - listInstruments queries by symbol wildcard or type, never by account", async () => {
  const calls = [];
  const client = new DxtradeReadOnlyClient({
    ...BASE_CONFIG,
    fetchImpl: queuedFetch([
      jsonResponse({ sessionToken: "session-token-123", timeout: "PT30M" }),
      jsonResponse({ instruments: [{ symbol: "BTC/USD", type: "CRYPTO" }] }),
      jsonResponse({ instruments: [] })
    ], calls)
  });

  await client.login();
  await client.listInstruments({ symbol: "BTC*" });
  await client.listInstruments({ type: "CRYPTO" });

  assert.equal(calls[1].url, "https://dx.tradeifycrypto.co/dxsca-web/instruments/BTC*");
  assert.equal(calls[1].options.method, "GET");
  assert.equal(calls[2].url, "https://dx.tradeifycrypto.co/dxsca-web/instruments/type/CRYPTO");

  assert.throws(() => client.listInstruments({}), TypeError);
  assert.throws(() => client.listInstruments({ symbol: "BTC*", type: "CRYPTO" }), TypeError);
});

test("9 - getHistoricalCandles posts a validated Candle request and rejects unknown candleType", async () => {
  const calls = [];
  const client = new DxtradeReadOnlyClient({
    ...BASE_CONFIG,
    fetchImpl: queuedFetch([
      jsonResponse({ sessionToken: "session-token-123", timeout: "PT30M" }),
      jsonResponse({ events: [{ type: "Candle", candleType: "15m", symbol: "BTC/USD" }] })
    ], calls)
  });

  await client.login();
  await client.getHistoricalCandles({
    symbols: ["BTC/USD"],
    candleType: "15m",
    fromTime: "2026-08-01T00:00:00Z",
    toTime: "2026-08-02T00:00:00Z",
    count: 100
  });

  assert.equal(calls[1].url, "https://dx.tradeifycrypto.co/dxsca-web/marketdata");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.headers.authorization, "DXAPI session-token-123");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    eventTypes: [{
      type: "Candle",
      candleType: "15m",
      fromTime: "2026-08-01T00:00:00Z",
      toTime: "2026-08-02T00:00:00Z",
      count: 100
    }],
    symbols: "BTC/USD"
  });

  await assert.rejects(
    client.getHistoricalCandles({ symbols: ["BTC/USD"], candleType: "3m" }),
    TypeError
  );
  await assert.rejects(
    client.getHistoricalCandles({ symbols: [], candleType: "15m" }),
    TypeError
  );
  await assert.rejects(
    client.getHistoricalCandles({ symbols: ["BTC/USD"], candleType: "15m", count: 0 }),
    TypeError
  );

  const unauthenticated = new DxtradeReadOnlyClient({
    ...BASE_CONFIG,
    fetchImpl: async () => jsonResponse(null)
  });
  await assert.rejects(
    unauthenticated.getHistoricalCandles({ symbols: ["BTC/USD"], candleType: "15m" }),
    /not authenticated/i
  );
});
