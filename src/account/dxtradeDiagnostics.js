function safeApiCode(value) {
  if (value === null || value === undefined || value === "") return "NONE";
  const text = String(value).slice(0, 64);
  return /^[A-Za-z0-9._-]+$/.test(text) ? text : "REDACTED";
}

function networkCauseChain(error) {
  const chain = [];
  let current = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function classifyNetworkCause(error) {
  for (const item of networkCauseChain(error)) {
    const causeCode = typeof item?.code === "string" ? item.code.toUpperCase() : "";
    const causeMessage = typeof item?.message === "string" ? item.message : "";

    if (/unexpected redirect/i.test(causeMessage)) return "REDIRECT_BLOCKED";
    if (["ENOTFOUND", "EAI_AGAIN"].includes(causeCode)) return "DNS_ERROR";
    if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"].includes(causeCode)) return "CONNECTION_ERROR";
    if (["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(causeCode)) {
      return "TIMEOUT";
    }
    if (
      causeCode.startsWith("ERR_TLS") ||
      causeCode.startsWith("CERT_") ||
      ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN"].includes(causeCode)
    ) {
      return "TLS_ERROR";
    }
  }
  return "NETWORK_ERROR";
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
  if (/request failed/i.test(message)) return classifyNetworkCause(error);
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
