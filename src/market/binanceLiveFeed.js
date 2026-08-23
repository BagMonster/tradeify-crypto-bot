const BINANCE_WS_URL = "wss://data-stream.binance.vision/ws/btcusdt@trade";
const SOURCE = "binance";
const SYMBOL = "BTCUSDT";
const DEFAULT_STALE_AFTER_MS = 15_000;
const DEFAULT_RECONNECT_MIN_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

function safeInteger(name, value, minimum = 0) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  }
  return number;
}

function positiveNumber(name, value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return number;
}

export function normalizeBinanceTrade(message, receivedAtMs = Date.now()) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new TypeError("Binance trade message must be an object");
  }
  if (message.e !== "trade") throw new TypeError("Binance message must be a trade event");
  if (message.s !== SYMBOL) throw new TypeError(`Binance trade symbol must be ${SYMBOL}`);

  const eventTimeMs = safeInteger("Binance event time", message.E, 1);
  const tradeTimeMs = safeInteger("Binance trade time", message.T, 1);
  const tradeId = safeInteger("Binance trade id", message.t, 0);
  const received = safeInteger("receivedAtMs", receivedAtMs, 1);
  const price = positiveNumber("Binance trade price", message.p);
  const quantity = positiveNumber("Binance trade quantity", message.q);

  return Object.freeze({
    source: SOURCE,
    symbol: SYMBOL,
    price,
    quantity,
    tradeId,
    eventTime: new Date(eventTimeMs).toISOString(),
    tradeTime: new Date(tradeTimeMs).toISOString(),
    receivedAt: new Date(received).toISOString()
  });
}

function freezeState(state) {
  return Object.freeze({
    running: state.running,
    connected: state.connected,
    stale: state.stale,
    lastTradeAt: state.lastTradeAt,
    lastTradeId: state.lastTradeId,
    reconnectAttempt: state.reconnectAttempt
  });
}

export function createBinanceLiveFeed({
  webSocketImpl = globalThis.WebSocket,
  now = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  reconnectMinMs = DEFAULT_RECONNECT_MIN_MS,
  reconnectMaxMs = DEFAULT_RECONNECT_MAX_MS,
  onPrice = () => {},
  onState = () => {},
  onError = () => {}
} = {}) {
  if (typeof webSocketImpl !== "function") throw new TypeError("A WebSocket implementation is required");
  if (typeof now !== "function" || typeof setTimeoutImpl !== "function" || typeof clearTimeoutImpl !== "function") {
    throw new TypeError("Timer implementations are invalid");
  }
  if (!Number.isInteger(staleAfterMs) || staleAfterMs < 1_000 || staleAfterMs > 120_000) {
    throw new TypeError("staleAfterMs must be an integer from 1000 to 120000");
  }
  if (!Number.isInteger(reconnectMinMs) || reconnectMinMs < 100 ||
      !Number.isInteger(reconnectMaxMs) || reconnectMaxMs < reconnectMinMs || reconnectMaxMs > 120_000) {
    throw new TypeError("Binance reconnect delays are invalid");
  }
  for (const [name, fn] of Object.entries({ onPrice, onState, onError })) {
    if (typeof fn !== "function") throw new TypeError(`${name} must be a function`);
  }

  const state = {
    running: false,
    connected: false,
    stale: true,
    lastTradeAt: null,
    lastTradeId: null,
    reconnectAttempt: 0
  };
  let socket = null;
  let staleTimer = null;
  let reconnectTimer = null;
  let generation = 0;

  function emitState() {
    onState(freezeState(state));
  }

  function clearTimer(name) {
    if (name === "stale" && staleTimer !== null) {
      clearTimeoutImpl(staleTimer);
      staleTimer = null;
    }
    if (name === "reconnect" && reconnectTimer !== null) {
      clearTimeoutImpl(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function armStaleTimer() {
    clearTimer("stale");
    staleTimer = setTimeoutImpl(() => {
      staleTimer = null;
      if (!state.running) return;
      state.stale = true;
      emitState();
    }, staleAfterMs);
    staleTimer?.unref?.();
  }

  function report(error) {
    try {
      onError(error instanceof Error ? error : new Error("Binance live feed failed"));
    } catch {
      // The feed must not crash because an observer's error callback failed.
    }
  }

  function scheduleReconnect() {
    if (!state.running || reconnectTimer !== null) return;
    state.reconnectAttempt += 1;
    const delay = Math.min(reconnectMaxMs, reconnectMinMs * (2 ** Math.min(state.reconnectAttempt - 1, 10)));
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      openSocket();
    }, delay);
    reconnectTimer?.unref?.();
    emitState();
  }

  function openSocket() {
    if (!state.running) return;
    const thisGeneration = ++generation;
    const ws = new webSocketImpl(BINANCE_WS_URL);
    socket = ws;

    ws.addEventListener("open", () => {
      if (!state.running || thisGeneration !== generation) {
        ws.close?.(1000, "Superseded connection");
        return;
      }
      state.connected = true;
      state.stale = true;
      state.reconnectAttempt = 0;
      emitState();
      armStaleTimer();
    });

    ws.addEventListener("message", (event) => {
      if (!state.running || thisGeneration !== generation) return;
      try {
        const parsed = typeof event.data === "string" ? JSON.parse(event.data) : JSON.parse(String(event.data));
        const trade = normalizeBinanceTrade(parsed, now());
        if (state.lastTradeId !== null && trade.tradeId <= state.lastTradeId) {
          throw new Error("Binance trade id was duplicate or out of order");
        }
        state.lastTradeId = trade.tradeId;
        state.lastTradeAt = trade.tradeTime;
        state.stale = false;
        armStaleTimer();
        emitState();
        onPrice(trade);
      } catch (error) {
        report(error);
      }
    });

    ws.addEventListener("error", () => {
      report(new Error("Binance market-data WebSocket error"));
    });

    ws.addEventListener("close", () => {
      if (thisGeneration !== generation) return;
      clearTimer("stale");
      state.connected = false;
      state.stale = true;
      emitState();
      scheduleReconnect();
    });
  }

  function start() {
    if (state.running) return freezeState(state);
    state.running = true;
    state.stale = true;
    state.reconnectAttempt = 0;
    emitState();
    openSocket();
    return freezeState(state);
  }

  function stop() {
    if (!state.running) return freezeState(state);
    state.running = false;
    generation += 1;
    clearTimer("stale");
    clearTimer("reconnect");
    state.connected = false;
    state.stale = true;
    try {
      if (socket && (socket.readyState === 0 || socket.readyState === 1)) {
        socket.close(1000, "Binance live feed stopped");
      }
    } finally {
      socket = null;
    }
    emitState();
    return freezeState(state);
  }

  function getState() {
    return freezeState(state);
  }

  return Object.freeze({ start, stop, getState });
}

export const BINANCE_LIVE_FEED_IDENTITY = Object.freeze({
  source: SOURCE,
  symbol: SYMBOL,
  url: BINANCE_WS_URL
});
