const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_KEEPALIVE_MS = 15_000;

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function validateBaseUrl(value, { protocol, label, requiredPath }) {
  const parsed = new URL(requiredString(value, label));

  if (parsed.protocol !== protocol) {
    throw new TypeError(`${label} must use ${protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new TypeError(`${label} must not contain credentials.`);
  }
  if (parsed.search || parsed.hash) {
    throw new TypeError(`${label} must not contain a query string or fragment.`);
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  if (parsed.pathname !== requiredPath) {
    throw new TypeError(`${label} must end with ${requiredPath}.`);
  }

  return parsed;
}

function encodedPathSegment(value, label) {
  return encodeURIComponent(requiredString(value, label));
}

function safeApiDescription(payload, secrets) {
  const candidate = payload && typeof payload === "object"
    ? payload.description ?? payload.message ?? payload.error
    : null;

  let description = typeof candidate === "string"
    ? candidate.slice(0, 300)
    : "DXtrade rejected the request.";

  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 3) {
      description = description.split(secret).join("[REDACTED]");
    }
  }

  return description;
}

async function websocketDataToText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (data && typeof data.text === "function") return data.text();
  throw new TypeError("DXtrade sent an unsupported WebSocket message type.");
}

export class DxtradeReadOnlyError extends Error {
  constructor(message, { status = null, apiCode = null, cause = undefined } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "DxtradeReadOnlyError";
    this.status = status;
    this.apiCode = apiCode;
  }
}

export class DxtradeReadOnlyClient {
  #restBaseUrl;
  #marketDataUrl;
  #username;
  #domain;
  #password;
  #fetch;
  #WebSocket;
  #timeoutMs;
  #sessionToken = null;
  #sessionTimeout = null;
  #lastAuthenticatedAt = null;
  #keepAliveTimer = null;
  #keepAliveBusy = false;
  #sockets = new Set();
  #requestSequence = 0;

  constructor({
    restBaseUrl,
    marketDataUrl,
    username,
    domain,
    password,
    fetchImpl = globalThis.fetch,
    webSocketImpl = globalThis.WebSocket,
    timeoutMs = DEFAULT_TIMEOUT_MS
  }) {
    this.#restBaseUrl = validateBaseUrl(restBaseUrl, {
      protocol: "https:",
      label: "DXtrade REST base URL",
      requiredPath: "/dxsca-web"
    });
    this.#marketDataUrl = validateBaseUrl(marketDataUrl, {
      protocol: "wss:",
      label: "DXtrade market-data URL",
      requiredPath: "/dxsca-web/md"
    });
    this.#username = requiredString(username, "DXtrade username");
    this.#domain = requiredString(domain, "DXtrade domain");
    this.#password = requiredString(password, "DXtrade password");

    if (typeof fetchImpl !== "function") {
      throw new TypeError("A fetch implementation is required.");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
      throw new TypeError("DXtrade timeout must be an integer from 1000 to 60000 milliseconds.");
    }

    this.#fetch = fetchImpl;
    this.#WebSocket = webSocketImpl;
    this.#timeoutMs = timeoutMs;
  }

  getSessionInfo() {
    return Object.freeze({
      authenticated: Boolean(this.#sessionToken),
      timeout: this.#sessionTimeout,
      lastAuthenticatedAt: this.#lastAuthenticatedAt
    });
  }

  async login() {
    if (this.#sessionToken) return this.getSessionInfo();

    const response = await this.#requestJson({
      method: "POST",
      path: "/login",
      authenticated: false,
      body: {
        username: this.#username,
        domain: this.#domain,
        password: this.#password
      }
    });

    if (typeof response?.sessionToken !== "string" || response.sessionToken.length < 8) {
      throw new DxtradeReadOnlyError("DXtrade login response did not contain a valid session token.");
    }

    this.#sessionToken = response.sessionToken;
    this.#sessionTimeout = typeof response.timeout === "string" ? response.timeout : null;
    this.#lastAuthenticatedAt = new Date().toISOString();
    return this.getSessionInfo();
  }

  async ping() {
    this.#requireSession();
    await this.#requestJson({ method: "POST", path: "/ping" });
    return this.getSessionInfo();
  }

  startSessionKeepAlive({ intervalMs = 60_000, onError = () => {} } = {}) {
    if (!Number.isInteger(intervalMs) || intervalMs < MIN_KEEPALIVE_MS) {
      throw new TypeError(`DXtrade keepalive interval must be at least ${MIN_KEEPALIVE_MS} milliseconds.`);
    }
    if (typeof onError !== "function") {
      throw new TypeError("DXtrade keepalive onError must be a function.");
    }

    this.stopSessionKeepAlive();
    this.#keepAliveTimer = setInterval(async () => {
      if (this.#keepAliveBusy || !this.#sessionToken) return;
      this.#keepAliveBusy = true;
      try {
        await this.ping();
      } catch (error) {
        onError(error);
      } finally {
        this.#keepAliveBusy = false;
      }
    }, intervalMs);
    this.#keepAliveTimer.unref?.();

    return () => this.stopSessionKeepAlive();
  }

  stopSessionKeepAlive() {
    if (this.#keepAliveTimer) clearInterval(this.#keepAliveTimer);
    this.#keepAliveTimer = null;
    this.#keepAliveBusy = false;
  }

  async logout() {
    this.stopSessionKeepAlive();
    if (!this.#sessionToken) return;

    try {
      await this.#requestJson({ method: "POST", path: "/logout" });
    } finally {
      this.#sessionToken = null;
      this.#sessionTimeout = null;
    }
  }

  async getUser(username = this.#username) {
    return this.#requestJson({
      method: "GET",
      path: `/users/${encodedPathSegment(username, "DXtrade username")}`
    });
  }

  async getAccountPortfolio(accountCode) {
    return this.#accountGet(accountCode, "portfolio");
  }

  async getOpenPositions(accountCode) {
    return this.#accountGet(accountCode, "positions");
  }

  async getOpenOrders(accountCode) {
    return this.#accountGet(accountCode, "orders");
  }

  async getAccountMetrics(accountCode) {
    return this.#accountGet(accountCode, "metrics");
  }

  async getInstrumentDetails(accountCode, symbol) {
    return this.#requestJson({
      method: "GET",
      path: `/accounts/${encodedPathSegment(accountCode, "DXtrade account code")}`
        + `/instruments/${encodedPathSegment(symbol, "DXtrade instrument symbol")}`
    });
  }

  subscribeQuotes({
    accountCode,
    symbols,
    onQuote,
    onState = () => {},
    onError = () => {}
  }) {
    this.#requireSession();
    if (typeof this.#WebSocket !== "function") {
      throw new TypeError("A WebSocket implementation is required for live quotes.");
    }
    if (!Array.isArray(symbols) || symbols.length === 0) {
      throw new TypeError("DXtrade quote symbols must be a non-empty array.");
    }
    if (typeof onQuote !== "function" || typeof onState !== "function" || typeof onError !== "function") {
      throw new TypeError("DXtrade quote callbacks must be functions.");
    }

    const normalizedSymbols = [...new Set(symbols.map((symbol) =>
      requiredString(symbol, "DXtrade instrument symbol")
    ))];
    const normalizedAccount = requiredString(accountCode, "DXtrade account code");
    const requestId = `md-${Date.now().toString(36)}-${++this.#requestSequence}`;
    const sessionAtOpen = this.#sessionToken;
    const url = new URL(this.#marketDataUrl);
    url.searchParams.set("format", "JSON");

    const socket = new this.#WebSocket(url.toString());
    this.#sockets.add(socket);

    socket.addEventListener("open", () => {
      if (!this.#sessionToken || this.#sessionToken !== sessionAtOpen) {
        socket.close(1000, "Session changed");
        return;
      }

      socket.send(JSON.stringify({
        type: "MarketDataSubscriptionRequest",
        requestId,
        timestamp: new Date().toISOString(),
        session: sessionAtOpen,
        payload: {
          account: normalizedAccount,
          symbols: normalizedSymbols,
          eventTypes: [{ type: "Quote", format: "COMPACT" }]
        }
      }));
      onState(Object.freeze({ connected: true, requestId }));
    });

    socket.addEventListener("message", async (event) => {
      try {
        const message = JSON.parse(await websocketDataToText(event.data));

        if (message?.type === "PingRequest") {
          if (message.session !== sessionAtOpen) {
            throw new DxtradeReadOnlyError("DXtrade Push API sent a ping for an unexpected session.");
          }
          socket.send(JSON.stringify({
            type: "Ping",
            timestamp: new Date().toISOString(),
            session: sessionAtOpen
          }));
          return;
        }

        if (message?.type === "Reject") {
          throw new DxtradeReadOnlyError(
            safeApiDescription(message.payload, [this.#username, this.#password, sessionAtOpen]),
            { apiCode: message.payload?.errorCode ?? null }
          );
        }

        if (message?.type !== "MarketData" || !Array.isArray(message.payload?.events)) return;
        for (const marketEvent of message.payload.events) {
          if (marketEvent?.type === "Quote") onQuote(Object.freeze({ ...marketEvent }));
        }
      } catch (error) {
        onError(error instanceof Error ? error : new DxtradeReadOnlyError("Invalid DXtrade market-data message."));
      }
    });

    socket.addEventListener("error", () => {
      onError(new DxtradeReadOnlyError("DXtrade market-data WebSocket error."));
    });

    socket.addEventListener("close", () => {
      this.#sockets.delete(socket);
      onState(Object.freeze({ connected: false, requestId }));
    });

    return Object.freeze({
      requestId,
      close: () => {
        if (socket.readyState === 0 || socket.readyState === 1) {
          socket.close(1000, "Read-only discovery complete");
        }
      }
    });
  }

  async close() {
    for (const socket of this.#sockets) {
      if (socket.readyState === 0 || socket.readyState === 1) {
        socket.close(1000, "Client closing");
      }
    }
    this.#sockets.clear();
    await this.logout();
  }

  #requireSession() {
    if (!this.#sessionToken) {
      throw new DxtradeReadOnlyError("DXtrade read-only session is not authenticated.");
    }
  }

  #accountGet(accountCode, resource) {
    return this.#requestJson({
      method: "GET",
      path: `/accounts/${encodedPathSegment(accountCode, "DXtrade account code")}/${resource}`
    });
  }

  async #requestJson({ method, path, authenticated = true, body = undefined }) {
    if (authenticated) this.#requireSession();

    const url = new URL(`${this.#restBaseUrl.pathname}${path}`, this.#restBaseUrl.origin);
    if (url.origin !== this.#restBaseUrl.origin || !url.pathname.startsWith(`${this.#restBaseUrl.pathname}/`)) {
      throw new DxtradeReadOnlyError("DXtrade request path escaped the configured REST base URL.");
    }

    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (authenticated) headers.authorization = `DXAPI ${this.#sessionToken}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    timer.unref?.();

    let response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
        cache: "no-store"
      });
    } catch (error) {
      const message = error?.name === "AbortError"
        ? "DXtrade request timed out."
        : "DXtrade request failed.";
      throw new DxtradeReadOnlyError(message, { cause: error });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw new DxtradeReadOnlyError("DXtrade returned malformed JSON.", {
          status: response.status,
          cause: error
        });
      }
    }

    if (!response.ok) {
      const sessionToken = this.#sessionToken;
      if (response.status === 401) {
        this.#sessionToken = null;
        this.#sessionTimeout = null;
      }
      throw new DxtradeReadOnlyError(
        safeApiDescription(payload, [this.#username, this.#password, sessionToken]),
        { status: response.status, apiCode: payload?.errorCode ?? null }
      );
    }

    return payload;
  }
}
