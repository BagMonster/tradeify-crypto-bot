const DEFAULT_INSTRUMENT = "BTC/USD";
const CASH_PROBES = Object.freeze([0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250]);
const GRID_FIRST_CASH = 250;
const VALIDATION_DELAY_MS = 1250;

function positiveFinite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function safeCode(value) {
  if (value === null || value === undefined || value === "") return "NONE";
  const text = String(value).slice(0, 48);
  return /^[A-Za-z0-9._-]+$/.test(text) ? text : "REDACTED";
}

function validationFailure(error) {
  return Object.freeze({
    ok: false,
    http: Number.isInteger(error?.status) ? error.status : null,
    api: safeCode(error?.apiCode)
  });
}

function validationPayloadFailure(payload) {
  if (!payload || typeof payload !== "object") return null;

  if (payload.valid === false || payload.isValid === false || payload.success === false || payload.accepted === false) {
    return safeCode(payload.errorCode ?? payload.rejectCode ?? "VALIDATION_REJECTED");
  }

  if (typeof payload.validationResult === "string" && payload.validationResult !== "NOT_RESTRICTED") {
    const first = Array.isArray(payload.failedValidationResults) ? payload.failedValidationResults[0] : null;
    return safeCode(first?.validationDescriptor ?? first?.validationDescriptorCode ?? "VALIDATION_REJECTED");
  }

  for (const key of ["errors", "violations", "rejects"]) {
    if (Array.isArray(payload[key]) && payload[key].length > 0) {
      const first = payload[key][0];
      return safeCode(first?.errorCode ?? first?.rejectCode ?? first?.code ?? "VALIDATION_REJECTED");
    }
  }

  if (payload.rejectReason || payload.rejectCode || payload.errorCode) {
    return safeCode(payload.errorCode ?? payload.rejectCode ?? "VALIDATION_REJECTED");
  }

  return null;
}

function collectMinimumHints(value, path = [], results = [], depth = 0) {
  if (depth > 8 || value === null || value === undefined) return results;

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectMinimumHints(item, [...path, String(index)], results, depth + 1));
    return results;
  }

  if (typeof value !== "object") return results;

  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key];
    const normalizedKey = key.toLowerCase();
    const number = positiveFinite(child);
    const looksMinimum = normalizedKey.includes("min") || normalizedKey.includes("minimum");
    const looksOrderRelated = /(order|size|quantity|qty|cash|notional|lot|amount)/i.test(nextPath.join("."));

    if (number !== null && looksMinimum && looksOrderRelated) {
      results.push(Object.freeze({ path: nextPath.join("."), value: number }));
    } else if (child && typeof child === "object") {
      collectMinimumHints(child, nextPath, results, depth + 1);
    }
  }

  return results;
}

async function defaultWait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function orderCode(amount, side, nonce) {
  const amountCode = String(amount).replace(".", "p");
  return `PREFLIGHT-${nonce}-${side}-${amountCode}`.slice(0, 64);
}

async function validateCash({ client, amount, side, nonce }) {
  try {
    const payload = await client.validateMarketCashOrder({
      clientOrderId: orderCode(amount, side, nonce),
      orderSide: side,
      cashQuantity: amount
    });
    const api = validationPayloadFailure(payload);
    if (api !== null) {
      return Object.freeze({ amount, side, ok: false, http: 200, api });
    }
    return Object.freeze({ amount, side, ok: true, http: 200, api: "NONE" });
  } catch (error) {
    return Object.freeze({ amount, side, ...validationFailure(error) });
  }
}

export async function runDxtradePreflight({
  client,
  wait = defaultWait,
  instrumentReader = null
} = {}) {
  if (!client || typeof client !== "object") throw new TypeError("DXtrade client is required");
  if (typeof client.login !== "function") throw new TypeError("DXtrade client.login is required");
  if (typeof client.validateMarketCashOrder !== "function") {
    throw new TypeError("DXtrade client.validateMarketCashOrder is required");
  }
  if (typeof wait !== "function") throw new TypeError("wait must be a function");
  if (instrumentReader !== null && typeof instrumentReader !== "function") {
    throw new TypeError("instrumentReader must be a function or null");
  }

  await client.login();
  const instrument = typeof client.getInstrument === "function"
    ? client.getInstrument()
    : DEFAULT_INSTRUMENT;

  const readInstrument = instrumentReader ?? (typeof client.getAccountInstrumentSettings === "function"
    ? (symbol) => client.getAccountInstrumentSettings(symbol)
    : null);

  let instrumentHints = [];
  let instrumentSettingsAvailable = false;
  if (readInstrument) {
    try {
      const settings = await readInstrument(instrument);
      instrumentSettingsAvailable = true;
      instrumentHints = collectMinimumHints(settings).slice(0, 10);
    } catch {
      instrumentSettingsAvailable = false;
    }
  }

  const nonce = Date.now().toString(36);
  const buyResults = [];
  let smallestPassingCash = null;
  let validationEndpointAvailable = true;

  for (const amount of CASH_PROBES) {
    if (buyResults.length > 0) await wait(VALIDATION_DELAY_MS);
    const result = await validateCash({ client, amount, side: "BUY", nonce });
    buyResults.push(result);

    if (result.http === 405) {
      validationEndpointAvailable = false;
      break;
    }
    if (result.ok) {
      smallestPassingCash = amount;
      break;
    }
  }

  let gridBuy = null;
  let gridSell = null;

  if (validationEndpointAvailable) {
    gridBuy = buyResults.find((item) => item.amount === GRID_FIRST_CASH) ?? null;
    if (!gridBuy) {
      if (buyResults.length > 0) await wait(VALIDATION_DELAY_MS);
      gridBuy = await validateCash({ client, amount: GRID_FIRST_CASH, side: "BUY", nonce });
    }

    await wait(VALIDATION_DELAY_MS);
    gridSell = await validateCash({ client, amount: GRID_FIRST_CASH, side: "SELL", nonce });
  }

  return Object.freeze({
    instrument,
    validationOnly: true,
    validationEndpointAvailable,
    instrumentSettingsAvailable,
    instrumentHints: Object.freeze(instrumentHints),
    probes: Object.freeze(buyResults),
    smallestPassingCash,
    gridBuy,
    gridSell
  });
}

export const DXTRADE_PREFLIGHT_POLICY = Object.freeze({
  defaultInstrument: DEFAULT_INSTRUMENT,
  cashProbes: CASH_PROBES,
  gridFirstCash: GRID_FIRST_CASH,
  validationDelayMs: VALIDATION_DELAY_MS
});
