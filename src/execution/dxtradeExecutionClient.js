const REQUIRED_HOSTNAME = "dx.tradeifycrypto.co";
const REQUIRED_PATH = "/dxsca-web";
const DEFAULT_TIMEOUT_MS = 10_000;
const BTC_INSTRUMENT = "BTC/USD";

function requiredString(value, label, maxLength = 256) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new TypeError(`${label} is too long`);
  return normalized;
}

function positive(name, value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError(`${name} must be a positive finite number`);
  return number;
}

function validateRestBaseUrl(value) {
  const parsed = new URL(requiredString(value, "DXtrade REST base URL"));
  if (parsed.protocol !== "https:") throw new TypeError("DXtrade REST base URL must use https:");
  if (parsed.hostname !== REQUIRED_HOSTNAME || parsed.port !== "") {
    throw new TypeError(`DXtrade REST base URL must use ${REQUIRED_HOSTNAME} with the default HTTPS port`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("DXtrade REST base URL must not contain credentials, query, or fragment");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  if (parsed.pathname !== REQUIRED_PATH) {
    throw new TypeError(`DXtrade REST base URL must end with ${REQUIRED_PATH}`);
  }
  return parsed;
}

function encoded(value, label) {
  return encodeURIComponent(requiredString(value, label, 128));
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

function orderCode(value) {
  const code = requiredString(value, "DXtrade orderCode", 64);
  if (!/^[A-Za-z0-9~,.\-_/:;!@'"#$%^&?*()[\]=+`\\]+$/.test(code)) {
    throw new TypeError("DXtrade orderCode contains unsupported characters");
  }
  return code;
}

function side(value) {
  const normalized = requiredString(value, "DXtrade side", 8).toUpperCase();
  if (normalized !== "BUY" && normalized !== "SELL") throw new TypeError("DXtrade side must be BUY or SELL");
  return normalized;
}

function extractOrders(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.orders)) {
    throw new Error("DXtrade order-history response must contain an orders array");
  }
  return payload.orders;
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function latestPositiveExecution(order) {
  const executions = Array.isArray(order?.executions) ? order.executions : [];
  for (let index = executions.length - 1; index >= 0; index -= 1) {
    const execution = executions[index];
    const lastQuantity = Math.abs(finiteNumberOrNull(execution?.lastQuantity) ?? 0);
    const lastPrice = finiteNumberOrNull(execution?.lastPrice);
    if (lastQuantity > 0 && lastPrice !== null && lastPrice > 0) return execution;
  }
  return null;
}

export function reconcileCashOrderHistory(payload, { clientOrderId, requestedCashQuantity }) {
  const code = orderCode(clientOrderId);
  const requestedCash = positive("requestedCashQuantity", requestedCashQuantity);
  const matches = extractOrders(payload).filter((order) => order?.clientOrderId === code);
  if (matches.length === 0) return Object.freeze({ status: "PENDING", reason: "Order not found in DXtrade history yet" });
  if (matches.length !== 1) throw new Error("DXtrade returned duplicate history rows for one client order id");

  const order = matches[0];
  const currentStatus = requiredString(order.status, "DXtrade order status", 32).toUpperCase();
  const isFinal = order.finalStatus === true;
  const leg = Array.isArray(order.legs) && order.legs.length === 1 ? order.legs[0] : null;
  if (!leg) throw new Error("DXtrade single BTC order must contain exactly one order leg");

  const filledCash = finiteNumberOrNull(leg.filledCashQuantity);
  const remainingCash = finiteNumberOrNull(leg.remainingCashQuantity);
  const filledQuantity = Math.abs(finiteNumberOrNull(leg.filledQuantity) ?? 0);
  const remainingQuantity = Math.abs(finiteNumberOrNull(leg.remainingQuantity) ?? 0);
  const averagePrice = finiteNumberOrNull(leg.averagePrice);
  const execution = latestPositiveExecution(order);
  const executionAverage = finiteNumberOrNull(execution?.averagePrice);
  const executionLast = finiteNumberOrNull(execution?.lastPrice);
  const fillPrice = [averagePrice, executionAverage, executionLast].find((value) => value !== null && value > 0) ?? null;
  const filledAt = execution?.transactionTime ?? order.transactionTime ?? null;

  const hasAnyFill = (filledCash !== null && filledCash > 0) || filledQuantity > 0;
  const cashComplete = filledCash !== null &&
    filledCash + Math.max(0.01, requestedCash * 1e-6) >= requestedCash &&
    (remainingCash === null || Math.abs(remainingCash) <= Math.max(0.01, requestedCash * 1e-6));
  const quantityComplete = filledCash === null && filledQuantity > 0 && remainingQuantity === 0;

  if (currentStatus === "COMPLETED" && isFinal && (cashComplete || quantityComplete)) {
    if (fillPrice === null || typeof filledAt !== "string" || !Number.isFinite(Date.parse(filledAt))) {
      throw new Error("DXtrade completed order lacks reliable fill price or time");
    }
    return Object.freeze({
      status: "FILLED",
      clientOrderId: code,
      brokerOrderId: order.orderId == null ? null : String(order.orderId),
      fillPrice,
      filledAt: new Date(Date.parse(filledAt)).toISOString(),
      filledCashQuantity: filledCash,
      filledQuantity
    });
  }

  if (isFinal && hasAnyFill) {
    return Object.freeze({
      status: "PARTIAL",
      clientOrderId: code,
      reason: `DXtrade order ended ${currentStatus} with an incomplete fill`,
      fillPrice,
      filledCashQuantity: filledCash,
      filledQuantity
    });
  }

  if (isFinal && ["REJECTED", "CANCELED", "EXPIRED"].includes(currentStatus)) {
    const latestExecution = Array.isArray(order.executions) ? order.executions.at(-1) : null;
    return Object.freeze({
      status: currentStatus,
      clientOrderId: code,
      reason: safeApiDescription(latestExecution, [])
    });
  }

  return Object.freeze({
    status: "PENDING",
    clientOrderId: code,
    brokerOrderId: order.orderId == null ? null : String(order.orderId),
    brokerUpdateOrderId: order.updateOrderId == null ? null : String(order.updateOrderId),
    brokerStatus: currentStatus
  });
}

export class DxtradeExecutionError extends Error {
  constructor(message, { status = null, apiCode = null, cause = undefined } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "DxtradeExecutionError";
    this.status = status;
    this.apiCode = apiCode;
  }
}

export class DxtradeExecutionClient {
  #restBaseUrl;
  #username;
  #domain;
  #password;
  #accountCode;
  #fetch;
  #timeoutMs;
  #sessionToken = null;

  constructor({
    restBaseUrl,
    username,
    domain,
    password,
    accountCode,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS
  }) {
    this.#restBaseUrl = validateRestBaseUrl(restBaseUrl);
    this.#username = requiredString(username, "DXtrade username");
    this.#domain = requiredString(domain, "DXtrade domain");
    this.#password = requiredString(password, "DXtrade password");
    this.#accountCode = requiredString(accountCode, "DXtrade account code", 128);
    if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000) {
      throw new TypeError("DXtrade timeout must be an integer from 1000 to 60000 milliseconds");
    }
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
  }

  getSessionInfo() {
    return Object.freeze({ authenticated: Boolean(this.#sessionToken) });
  }

  async login() {
    if (this.#sessionToken) return this.getSessionInfo();
    const response = await this.#requestJson({
      method: "POST",
      path: "/login",
      authenticated: false,
      body: { username: this.#username, domain: this.#domain, password: this.#password }
    });
    if (typeof response?.sessionToken !== "string" || response.sessionToken.length < 8) {
      throw new DxtradeExecutionError("DXtrade login response did not contain a valid session token");
    }
    this.#sessionToken = response.sessionToken;
    return this.getSessionInfo();
  }

  async logout() {
    if (!this.#sessionToken) return;
    try {
      await this.#requestJson({ method: "POST", path: "/logout" });
    } finally {
      this.#sessionToken = null;
    }
  }

  async validateMarketCashOrder({ clientOrderId, orderSide, cashQuantity }) {
    return this.#requestJson({
      method: "POST",
      path: `/accounts/${encoded(this.#accountCode, "DXtrade account code")}/orders/validate`,
      body: {
        orderCode: orderCode(clientOrderId),
        type: "MARKET",
        instrument: BTC_INSTRUMENT,
        cashQuantity: positive("cashQuantity", cashQuantity),
        side: side(orderSide)
      }
    });
  }

  async placeMarketCashOrder({ clientOrderId, orderSide, cashQuantity }) {
    return this.#requestJson({
      method: "POST",
      path: `/accounts/${encoded(this.#accountCode, "DXtrade account code")}/orders`,
      body: {
        orderCode: orderCode(clientOrderId),
        type: "MARKET",
        instrument: BTC_INSTRUMENT,
        cashQuantity: positive("cashQuantity", cashQuantity),
        side: side(orderSide)
      }
    });
  }

  async getOrderHistory(clientOrderId) {
    const code = orderCode(clientOrderId);
    return this.#requestJson({
      method: "GET",
      path: `/accounts/${encoded(this.#accountCode, "DXtrade account code")}/orders/history`,
      query: { "with-client-id": code, limit: 10 }
    });
  }

  async reconcileMarketCashOrder({ clientOrderId, requestedCashQuantity }) {
    return reconcileCashOrderHistory(await this.getOrderHistory(clientOrderId), {
      clientOrderId,
      requestedCashQuantity
    });
  }

  async getOpenPositions() {
    return this.#requestJson({
      method: "GET",
      path: `/accounts/${encoded(this.#accountCode, "DXtrade account code")}/positions`
    });
  }

  async getAccountMetrics({ includePositions = true } = {}) {
    if (typeof includePositions !== "boolean") throw new TypeError("includePositions must be boolean");
    return this.#requestJson({
      method: "GET",
      path: `/accounts/${encoded(this.#accountCode, "DXtrade account code")}/metrics`,
      query: { "include-positions": includePositions ? "true" : "false" }
    });
  }

  #requireSession() {
    if (!this.#sessionToken) throw new DxtradeExecutionError("DXtrade execution session is not authenticated");
  }

  async #requestJson({ method, path, query = null, authenticated = true, body = undefined }) {
    if (authenticated) this.#requireSession();
    const url = new URL(`${this.#restBaseUrl.pathname}${path}`, this.#restBaseUrl.origin);
    if (url.hostname !== REQUIRED_HOSTNAME || url.protocol !== "https:" || url.port !== "" ||
        url.origin !== this.#restBaseUrl.origin || !url.pathname.startsWith(`${this.#restBaseUrl.pathname}/`)) {
      throw new DxtradeExecutionError("DXtrade request escaped the pinned production REST origin");
    }
    if (query) {
      for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
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
      const message = error?.name === "AbortError" ? "DXtrade request timed out" : "DXtrade request failed";
      throw new DxtradeExecutionError(message, { cause: error });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    if (text.length > 2_000_000) throw new DxtradeExecutionError("DXtrade response was unexpectedly large", { status: response.status });
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw new DxtradeExecutionError("DXtrade returned malformed JSON", { status: response.status, cause: error });
      }
    }

    if (!response.ok) {
      const session = this.#sessionToken;
      if (response.status === 401) this.#sessionToken = null;
      throw new DxtradeExecutionError(
        safeApiDescription(payload, [this.#username, this.#domain, this.#password, session]),
        { status: response.status, apiCode: payload?.errorCode ?? null }
      );
    }
    return payload;
  }
}

export const DXTRADE_EXECUTION_IDENTITY = Object.freeze({
  hostname: REQUIRED_HOSTNAME,
  restPath: REQUIRED_PATH,
  instrument: BTC_INSTRUMENT
});
