function safeApiCode(value) {
  if (value === null || value === undefined || value === "") return "NONE";
  const text = String(value).slice(0, 64);
  return /^[A-Za-z0-9._-]+$/.test(text) ? text : "REDACTED";
}

function classify(error) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  if (status === 400) return "BAD_REQUEST";
  if (status === 401) return "AUTHENTICATION_REJECTED";
  if (status === 403) return "AUTHORIZATION_REJECTED";
  if (status === 404) return "ENDPOINT_OR_ACCOUNT_NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  if (status !== null && status >= 500) return "BROKER_SERVER_ERROR";

  const message = error instanceof Error ? error.message : "";
  if (/timed out/i.test(message)) return "TIMEOUT";
  if (/request failed/i.test(message)) return "NETWORK_ERROR";
  if (/malformed JSON/i.test(message)) return "MALFORMED_JSON";
  if (/metrics/i.test(message)) return "METRICS_RESPONSE_INVALID";
  if (/not authenticated/i.test(message)) return "SESSION_NOT_AUTHENTICATED";
  return "DXTRADE_ERROR";
}

export function formatDxtradeAccountDiagnostic(error) {
  const status = Number.isInteger(error?.status) ? String(error.status) : "NONE";
  const apiCode = safeApiCode(error?.apiCode);
  return `\nDXtrade diagnostic: category=${classify(error)} http=${status} api=${apiCode}`;
}
