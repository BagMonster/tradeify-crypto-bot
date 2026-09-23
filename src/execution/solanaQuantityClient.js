import { dxtradeLoginGate } from "./dxtradeLoginGate.js";

const REQUIRED_HOSTNAME = "dx.tradeifycrypto.co";
const REQUIRED_PATH = "/dxsca-web";

function text(name, value, max = 256) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  const out = value.trim();
  if (out.length > max) throw new TypeError(`${name} is too long`);
  return out;
}

function positive(name, value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`${name} must be positive`);
  return n;
}

function side(value) {
  const out = text("side", value, 8).toUpperCase();
  if (out !== "BUY" && out !== "SELL") throw new TypeError("side must be BUY or SELL");
  return out;
}

function baseUrl(value) {
  const parsed = new URL(text("DXtrade REST base URL", value));
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  if (parsed.protocol !== "https:" || parsed.hostname !== REQUIRED_HOSTNAME || parsed.port || parsed.pathname !== REQUIRED_PATH) {
    throw new TypeError(`DXtrade REST base URL must equal https://${REQUIRED_HOSTNAME}${REQUIRED_PATH}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new TypeError("DXtrade REST base URL is invalid");
  return parsed;
}

function parseOrders(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.orders)) {
    throw new Error("DXtrade order history must contain an orders array");
  }
  return payload.orders;
}

function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeApiError(payload, status) {
  const code = payload?.errorCode ?? payload?.code ?? payload?.rejectCode ?? null;
  const description = payload?.description ?? payload?.message ?? payload?.error ?? payload?.rejectReason ?? null;
  const safeCode = code == null ? "NONE" : String(code).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 48) || "REDACTED";
  const safeDescription = typeof description === "string"
    ? description.replace(/[\r\n\t]/g, " ").slice(0, 180)
    : "DXtrade rejected the request";
  return `DXtrade SOL request failed (HTTP ${status}, code ${safeCode}): ${safeDescription}`;
}

export function reconcileSolQuantityOrder(payload, { orderCode, requestedQuantity }) {
  const code = text("orderCode", orderCode, 64);
  const requested = positive("requestedQuantity", requestedQuantity);
  const matches = parseOrders(payload).filter((row) => row?.clientOrderId === code);
  if (matches.length === 0) {
    // 2026-09-22. This returned a bare PENDING, so "DXtrade has never heard of this
    // order" was indistinguishable from "it is working at the broker". The adapter
    // looked for the words "not found in dxtrade history" in a reason field this
    // path never set, so an order that was never accepted stayed PENDING for good
    // and its order code was blocked from ever being retried. The flag is explicit
    // now; no caller has to match on prose.
    return Object.freeze({
      status: "PENDING",
      orderCode: code,
      brokerHasNoRecord: true,
      reason: "Order not found in DXtrade history"
    });
  }
  if (matches.length !== 1) throw new Error("DXtrade returned duplicate SOL order-history rows");
  const order = matches[0];
  const status = text("DXtrade order status", order.status, 32).toUpperCase();
  const finalStatus = order.finalStatus === true;
  const leg = Array.isArray(order.legs) && order.legs.length === 1 ? order.legs[0] : null;
  if (!leg) throw new Error("DXtrade SOL order must contain exactly one leg");
  const filledQuantity = Math.abs(finiteOrNull(leg.filledQuantity) ?? 0);
  const remainingQuantity = Math.abs(finiteOrNull(leg.remainingQuantity) ?? 0);
  const tolerance = Math.max(1e-10, requested * 1e-8);
  const complete = Math.abs(filledQuantity - requested) <= tolerance && remainingQuantity <= tolerance;
  const executions = Array.isArray(order.executions) ? order.executions : [];
  const lastExecution = [...executions].reverse().find((e) => Math.abs(finiteOrNull(e?.lastQuantity) ?? 0) > 0) ?? null;
  const fillPrice = [finiteOrNull(leg.averagePrice), finiteOrNull(lastExecution?.averagePrice), finiteOrNull(lastExecution?.lastPrice)]
    .find((n) => n != null && n > 0) ?? null;
  const fillTime = lastExecution?.transactionTime ?? order.transactionTime ?? null;

  if (status === "COMPLETED" && finalStatus && complete) {
    if (!(fillPrice > 0) || typeof fillTime !== "string" || !Number.isFinite(Date.parse(fillTime))) {
      throw new Error("DXtrade completed SOL order lacks reliable fill details");
    }
    return Object.freeze({
      status: "FILLED",
      orderCode: code,
      brokerOrderId: order.orderId == null ? null : String(order.orderId),
      fillPrice,
      filledQuantity,
      filledAt: new Date(Date.parse(fillTime)).toISOString()
    });
  }

  if (finalStatus && filledQuantity > tolerance) {
    return Object.freeze({ status: "PARTIAL", orderCode: code, filledQuantity, fillPrice });
  }
  if (finalStatus && ["REJECTED", "CANCELED", "EXPIRED"].includes(status)) {
    return Object.freeze({ status, orderCode: code });
  }
  return Object.freeze({ status: "PENDING", orderCode: code });
}

export class SolanaQuantityClient {
  #base;
  #username;
  #domain;
  #password;
  #accountCode;
  #instrument;
  #fetch;
  #timeoutMs;
  #sessionToken = null;
  // Single-flight re-authentication. Each instrument owns its own client, and
  // a book can have several requests in flight at once, so a dead session
  // produces a burst of simultaneous 401s. They all await the same login.
  #reauthPromise = null;
  #reauthCount = 0;
  #lastReauthAt = null;
  #lastReauthError = null;

  constructor({ restBaseUrl, username, domain, password, accountCode, instrument = "SOL/USD", fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
    this.#base = baseUrl(restBaseUrl);
    this.#username = text("DXtrade username", username);
    this.#domain = text("DXtrade domain", domain);
    this.#password = text("DXtrade password", password);
    this.#accountCode = text("DXtrade account code", accountCode, 128);
    this.#instrument = text("instrument", instrument, 64);
    if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000) throw new TypeError("timeoutMs is invalid");
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
  }

  /**
   * A 401 means DXtrade rejected the session, not the request.
   *
   * Before this, a 401 left #sessionToken in place and threw. login() returns
   * early whenever a token exists, so every subsequent call re-sent the same
   * dead token and got the same 401. The session could never recover inside a
   * running process - a restart was the only way out.
   *
   * On 2026-09-19 that turned a routine session expiry into eighty minutes in
   * which seventeen consecutive protective cuts executed nothing, and the
   * funded account breached its daily limit. This client is the one the ring
   * execution guard holds, so this is the path that failed.
   *
   * Recover once and replay - GET only. A POST may have been accepted before
   * the response came back; a 401 should be rejected before matching, but
   * "probably safe" is not good enough when the failure is a doubled position.
   * A POST gets its session repaired for the next caller and rethrows, and the
   * order-code history poll resolves whether it filled.
   *
   * getOpenPositions() is a GET, and that is the call the cut path makes, so
   * the case that actually broke recovers automatically.
   */
  async #request(options) {
    const { method, path, authenticated = true } = options;
    try {
      return await this.#requestOnce(options);
    } catch (error) {
      if (error?.status !== 401 || authenticated !== true || path === "/logout") throw error;
      console.warn(`DXtrade SOL ${method} ${path} returned 401; re-authenticating and retrying.`);
      try {
        await this.#reauthenticate();
      } catch (reauthError) {
        const failure = new Error(
          `DXtrade SOL session expired and re-authentication failed: ${reauthError?.message ?? "unknown error"}`
        );
        failure.status = 401;
        failure.cause = reauthError;
        throw failure;
      }
      if (method !== "GET") throw error;
      return this.#requestOnce(options);
    }
  }

  async #reauthenticate() {
    if (this.#reauthPromise) return this.#reauthPromise;
    this.#reauthPromise = (async () => {
      // login() short-circuits on a live token, so the dead one must go first.
      this.#sessionToken = null;
      await this.login();
      this.#reauthCount += 1;
      this.#lastReauthAt = new Date().toISOString();
      this.#lastReauthError = null;
    })();
    try {
      return await this.#reauthPromise;
    } catch (error) {
      this.#lastReauthError = error?.message ?? "re-authentication failed";
      throw error;
    } finally {
      this.#reauthPromise = null;
    }
  }

  /** Drop the current session and establish a new one. Used by the daily
   *  rotation and by /relogin. */
  async forceRelogin() {
    try {
      await this.logout();
    } catch {
      // Usually already dead; logout() nulls the token in its finally block.
    }
    this.#sessionToken = null;
    await this.login();
    this.#lastReauthAt = new Date().toISOString();
    this.#lastReauthError = null;
    return this.getSessionInfo();
  }

  getSessionInfo() {
    return Object.freeze({
      instrument: this.#instrument,
      authenticated: Boolean(this.#sessionToken),
      reauthCount: this.#reauthCount,
      lastReauthAt: this.#lastReauthAt,
      lastReauthError: this.#lastReauthError
    });
  }

  async #requestOnce({ method, path, body = null, query = null, authenticated = true }) {
    if (authenticated && !this.#sessionToken) throw new Error("DXtrade SOL session is not authenticated");
    const url = new URL(`${this.#base.pathname}${path}`, this.#base.origin);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const headers = { accept: "application/json" };
      if (body != null) headers["content-type"] = "application/json";
      if (authenticated) headers.authorization = `DXAPI ${this.#sessionToken}`;
      const response = await this.#fetch(url, {
        method,
        headers,
        body: body == null ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: controller.signal
      });
      if (!response || typeof response.ok !== "boolean") throw new Error("DXtrade SOL response is invalid");
      const raw = await response.text();
      let payload = null;
      if (raw) {
        try { payload = JSON.parse(raw); } catch { throw new Error(`DXtrade SOL response was malformed JSON (HTTP ${response.status})`); }
      }
      if (!response.ok) {
        // The status has to travel with the error so #request can tell a 401
        // (recoverable: re-login and replay) from a 400 (do not retry).
        const failure = new Error(safeApiError(payload, response.status));
        failure.status = response.status;
        throw failure;
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async login() {
    if (this.#sessionToken) return;
    // Through the shared gate: every DXtrade client in this process uses the
    // same credentials, so they all lose the session at the same moment and
    // would otherwise stampede /login and collect a 429.
    await dxtradeLoginGate.login(`${this.#instrument} execution`, async () => {
      // Re-check inside the gate. While queued behind another client, this
      // client's own re-auth may already have completed.
      if (this.#sessionToken) return;
      const payload = await this.#request({
        method: "POST",
        path: "/login",
        authenticated: false,
        body: { username: this.#username, domain: this.#domain, password: this.#password }
      });
      if (typeof payload?.sessionToken !== "string" || payload.sessionToken.length < 8) throw new Error("DXtrade SOL login did not return a session token");
      this.#sessionToken = payload.sessionToken;
    });
  }

  async logout() {
    if (!this.#sessionToken) return;
    try { await this.#request({ method: "POST", path: "/logout" }); }
    finally { this.#sessionToken = null; }
  }

  async placeMarketQuantityOrder({ orderCode, orderSide, quantity }) {
    await this.login();
    const path = `/accounts/${encodeURIComponent(this.#accountCode)}/orders`;
    const body = {
      orderCode: text("orderCode", orderCode, 64),
      type: "MARKET",
      instrument: this.#instrument,
      quantity: positive("quantity", quantity),
      positionEffect: "OPEN",
      side: side(orderSide),
      tif: "GTC"
    };
    const payload = await this.#request({ method: "POST", path, body });
    // 2026-09-22 diagnostic. Entries were returning HTTP 2xx with no orderId, the
    // ledger recorded broker_order_id NULL, the order never appeared in DXtrade's
    // order history, and nothing anywhere recorded what the broker actually
    // answered. A submission that creates no order is the most serious silent
    // failure this client can have, so it says so, with the exact request and the
    // exact response. Neither contains a credential: the session token travels in
    // the Authorization header, which is not logged.
    if (payload?.orderId == null) {
      let printable;
      try {
        printable = JSON.stringify(payload);
      } catch {
        printable = "<unserialisable>";
      }
      console.warn(
        `DXtrade ${this.#instrument} order POST ${path} returned no orderId. ` +
        `Request: ${JSON.stringify(body)} Response: ${printable === undefined ? "<empty body>" : printable.slice(0, 1000)}`
      );
    }
    return payload;
  }

  // D-049 partial de-risk path. Unlike a full linked-position close, this request
  // explicitly carries the quantity that must be reduced. It is separately gated
  // and must be broker-validated before the D-049 branch is deployed live.
  async placePositionPartialClose({ orderCode, orderSide, quantity, positionCode }) {
    await this.login();
    return this.#request({
      method: "POST",
      path: `/accounts/${encodeURIComponent(this.#accountCode)}/orders`,
      body: {
        orderCode: text("orderCode", orderCode, 64),
        type: "MARKET",
        instrument: this.#instrument,
        quantity: positive("quantity", quantity),
        positionEffect: "CLOSE",
        positionCode: text("positionCode", positionCode, 128),
        side: side(orderSide),
        tif: "GTC"
      }
    });
  }

  // Full linked-position close, already verified by the production lifecycle canary.
  async placePositionClose({ orderCode, orderSide, quantity, positionCode }) {
    await this.login();
    positive("quantity", quantity);
    return this.#request({
      method: "POST",
      path: `/accounts/${encodeURIComponent(this.#accountCode)}/orders`,
      body: {
        orderCode: text("orderCode", orderCode, 64),
        type: "MARKET",
        instrument: this.#instrument,
        positionEffect: "CLOSE",
        positionCode: text("positionCode", positionCode, 128),
        side: side(orderSide),
        tif: "GTC"
      }
    });
  }

  async getOrderHistory(orderCode) {
    await this.login();
    return this.#request({
      method: "GET",
      path: `/accounts/${encodeURIComponent(this.#accountCode)}/orders/history`,
      query: { "with-client-id": text("orderCode", orderCode, 64), limit: 10 }
    });
  }

  async reconcileQuantityOrder({ orderCode, requestedQuantity }) {
    return reconcileSolQuantityOrder(await this.getOrderHistory(orderCode), { orderCode, requestedQuantity });
  }

  async getOpenPositions() {
    await this.login();
    return this.#request({ method: "GET", path: `/accounts/${encodeURIComponent(this.#accountCode)}/positions` });
  }
}
