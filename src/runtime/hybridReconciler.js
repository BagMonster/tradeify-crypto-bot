// Hybrid-mode reconciliation classifier.
//
// Pure functions only: no I/O, no clock reads, no persistence. Callers supply the
// per-book inspection rows, a DXtrade order-history payload and the per-book
// watermarks; this module decides what each book's divergence means.
//
// The live five-book service performs no periodic broker-versus-virtual check
// today, so a manual fill, a broker-side close or a silent partial all pass
// unnoticed. This module is the decision half of closing that gap.
//
// Origin rules are deliberately asymmetric. Any single bot signal marks an order
// as the bot's. Calling an order MANUAL requires every signal to agree. Anything
// else is UNKNOWN and escalates, because wrongly absorbing an order rewrites the
// virtual book to match a broker state nobody has explained.

const NET_TOLERANCE = 1e-8;
const BOT_ORDER_CODE_PREFIX = "dxsca-integration-session-code:";
const BOT_USER_AGENT = "node";

export const ORIGIN = Object.freeze({ BOT: "BOT", MANUAL: "MANUAL", UNKNOWN: "UNKNOWN" });
export const VERDICT = Object.freeze({
  MATCH: "MATCH",
  UNREAD: "UNREAD",
  ABSORB: "ABSORB",
  UNEXPLAINED: "UNEXPLAINED"
});

function finite(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value) {
  return value === null || value === undefined ? "" : String(value);
}

function parsedTime(value) {
  const stamp = Date.parse(text(value));
  return Number.isFinite(stamp) ? stamp : null;
}

/**
 * Classify one order-history row as the bot's, the owner's, or unattributable.
 *
 * @param order  one element of payload.orders
 * @param knownClientOrderIds  Set of clientOrderIds the execution ledger knows
 */
export function classifyOrigin(order, knownClientOrderIds = new Set()) {
  const clientOrderId = text(order?.clientOrderId);
  const orderCode = text(order?.orderCode);
  const userAgent = text(order?.audit?.userAgent);

  const ledgerSaysBot = clientOrderId !== "" && knownClientOrderIds.has(clientOrderId);
  const prefixSaysBot = orderCode.startsWith(BOT_ORDER_CODE_PREFIX);
  const agentSaysBot = userAgent === BOT_USER_AGENT;
  if (ledgerSaysBot || prefixSaysBot || agentSaysBot) return ORIGIN.BOT;

  const ledgerSaysManual = clientOrderId !== "" && !knownClientOrderIds.has(clientOrderId);
  const prefixSaysManual = orderCode !== "" && !orderCode.startsWith(BOT_ORDER_CODE_PREFIX);
  const agentSaysManual = userAgent !== "" && userAgent !== BOT_USER_AGENT;
  if (ledgerSaysManual && prefixSaysManual && agentSaysManual) return ORIGIN.MANUAL;

  return ORIGIN.UNKNOWN;
}

/**
 * Reduce one order-history row to the fields absorption needs.
 * Returns null when the row is not a usable single-leg completed fill.
 */
export function describeFill(order) {
  if (order?.status !== "COMPLETED" || order?.finalStatus !== true) return null;
  const legs = Array.isArray(order.legs) ? order.legs : [];
  if (legs.length !== 1) return null;
  const leg = legs[0];

  const filledQuantity = finite(leg.filledQuantity);
  const averagePrice = finite(leg.averagePrice);
  const transactionTime = parsedTime(order.transactionTime);
  const positionCode = text(leg.positionCode);
  const effect = text(leg.positionEffect).toUpperCase();
  const side = text(order.side).toUpperCase();

  if (filledQuantity === null || filledQuantity <= 0) return null;
  if (averagePrice === null || averagePrice <= 0) return null;
  if (transactionTime === null || positionCode === "") return null;
  if (effect !== "OPEN" && effect !== "CLOSE") return null;
  if (side !== "BUY" && side !== "SELL") return null;

  // Signed against the book: a BUY adds units, a SELL removes them, and a CLOSE
  // is the reverse of the side that opened the position.
  const direction = side === "BUY" ? 1 : -1;
  return Object.freeze({
    instrument: text(order.instrument),
    clientOrderId: text(order.clientOrderId),
    orderId: text(order.orderId),
    positionCode,
    effect,
    side,
    units: Math.abs(filledQuantity),
    signedUnits: Math.abs(filledQuantity) * direction,
    price: averagePrice,
    filledAt: new Date(transactionTime).toISOString(),
    transactionTime
  });
}

/**
 * Decide what one book's divergence means.
 *
 * @param row         an inspectBooks() row
 * @param orders      payload.orders for this account (all instruments)
 * @param options.knownClientOrderIds  Set from the execution ledger
 * @param options.watermark            ISO string; fills at or before it are already absorbed
 */
export function classifyBook(row, orders = [], options = {}) {
  const instrument = text(row?.instrument);
  if (row?.ok !== true) {
    return Object.freeze({
      instrument,
      verdict: VERDICT.UNREAD,
      reason: text(row?.error) || "book inspection did not return a usable read",
      delta: null,
      fills: Object.freeze([])
    });
  }

  const virtualNet = finite(row.virtualNet);
  const brokerNet = finite(row.brokerNet);
  if (virtualNet === null || brokerNet === null) {
    return Object.freeze({
      instrument,
      verdict: VERDICT.UNREAD,
      reason: "book reported a null net",
      delta: null,
      fills: Object.freeze([])
    });
  }

  const delta = brokerNet - virtualNet;
  if (Math.abs(delta) <= NET_TOLERANCE) {
    return Object.freeze({ instrument, verdict: VERDICT.MATCH, reason: null, delta: 0, fills: Object.freeze([]) });
  }

  const knownClientOrderIds = options.knownClientOrderIds ?? new Set();
  const watermark = parsedTime(options.watermark);

  const candidates = [];
  let sawUnknown = false;
  for (const order of orders) {
    if (text(order?.instrument) !== instrument) continue;
    const fill = describeFill(order);
    if (fill === null) continue;
    if (watermark !== null && fill.transactionTime <= watermark) continue;
    const origin = classifyOrigin(order, knownClientOrderIds);
    if (origin === ORIGIN.BOT) continue;
    if (origin === ORIGIN.UNKNOWN) { sawUnknown = true; continue; }
    candidates.push(fill);
  }

  if (sawUnknown) {
    return Object.freeze({
      instrument,
      verdict: VERDICT.UNEXPLAINED,
      reason: "an order on this book could not be attributed to the bot or to the owner",
      delta,
      fills: Object.freeze([])
    });
  }

  const explained = candidates.reduce((sum, fill) => sum + fill.signedUnits, 0);
  if (Math.abs(explained - delta) > NET_TOLERANCE) {
    return Object.freeze({
      instrument,
      verdict: VERDICT.UNEXPLAINED,
      reason: candidates.length === 0
        ? `broker net ${brokerNet} does not match virtual net ${virtualNet} and no manual fill explains it`
        : `manual fills account for ${explained} units but the book diverged by ${delta}`,
      delta,
      fills: Object.freeze([])
    });
  }

  const sorted = [...candidates].sort((a, b) => a.transactionTime - b.transactionTime);
  return Object.freeze({
    instrument,
    verdict: VERDICT.ABSORB,
    reason: null,
    delta,
    fills: Object.freeze(sorted),
    watermark: sorted.at(-1).filledAt
  });
}

/**
 * Classify every book in one pass.
 */
export function classifyBooks(rows = [], orders = [], options = {}) {
  const watermarks = options.watermarks ?? {};
  return Object.freeze(rows.map((row) => classifyBook(row, orders, {
    knownClientOrderIds: options.knownClientOrderIds ?? new Set(),
    watermark: watermarks[text(row?.instrument)] ?? options.watermark ?? null
  })));
}

/**
 * Summarise a classification pass for the caller that decides actions.
 *
 * Two or more books escalating at once is not a coincidence to trade through:
 * the account-wide halt store holds a single cycle, so a second concurrent
 * escalation raises severity rather than queueing behind the first.
 */
export function summarize(decisions = []) {
  const escalating = decisions.filter((d) => d.verdict === VERDICT.UNEXPLAINED || d.verdict === VERDICT.UNREAD);
  const absorbing = decisions.filter((d) => d.verdict === VERDICT.ABSORB);
  return Object.freeze({
    matched: Object.freeze(decisions.filter((d) => d.verdict === VERDICT.MATCH).map((d) => d.instrument)),
    absorbing: Object.freeze(absorbing),
    escalating: Object.freeze(escalating),
    accountWide: escalating.length >= 2,
    severity: escalating.length >= 2 ? "ACCOUNT_HALT" : escalating.length === 1 ? "BOOK_WARNING" : "NONE"
  });
}

export const HYBRID_RECONCILER_CONSTANTS = Object.freeze({
  NET_TOLERANCE,
  BOT_ORDER_CODE_PREFIX,
  BOT_USER_AGENT
});
