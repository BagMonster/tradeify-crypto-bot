import test from "node:test";
import assert from "node:assert/strict";
import { formatDxtradeAccountDiagnostic } from "../src/account/dxtradeDiagnostics.js";

test("classifies HTTP authentication failure without leaking message content", () => {
  const error = new Error("username secret-user password secret-pass account SECRET-ACCOUNT");
  error.status = 401;
  error.apiCode = "AUTH_FAILED";
  const diagnostic = formatDxtradeAccountDiagnostic(error);
  assert.equal(diagnostic, "\nDXtrade diagnostic: category=AUTHENTICATION_REJECTED http=401 api=AUTH_FAILED");
  assert.equal(diagnostic.includes("secret-user"), false);
  assert.equal(diagnostic.includes("secret-pass"), false);
  assert.equal(diagnostic.includes("SECRET-ACCOUNT"), false);
});

test("classifies invalid metrics payload without returning raw remote text", () => {
  const error = new Error("DXtrade account metrics response must contain a metrics array; token=super-secret");
  const diagnostic = formatDxtradeAccountDiagnostic(error);
  assert.equal(diagnostic, "\nDXtrade diagnostic: category=METRICS_RESPONSE_INVALID http=NONE api=NONE");
  assert.equal(diagnostic.includes("super-secret"), false);
});

test("redacts unsafe API codes", () => {
  const error = new Error("DXtrade rejected request");
  error.status = 400;
  error.apiCode = "bad code account=123";
  assert.equal(
    formatDxtradeAccountDiagnostic(error),
    "\nDXtrade diagnostic: category=BAD_REQUEST http=400 api=REDACTED"
  );
});

test("classifies blocked redirects without exposing the redirect target", () => {
  const cause = new Error("unexpected redirect to https://secret.example/path");
  const error = new Error("DXtrade request failed", { cause });
  const diagnostic = formatDxtradeAccountDiagnostic(error);
  assert.equal(diagnostic, "\nDXtrade diagnostic: category=REDIRECT_BLOCKED http=NONE api=NONE");
  assert.equal(diagnostic.includes("secret.example"), false);
});

test("classifies DNS failures", () => {
  const cause = new Error("getaddrinfo ENOTFOUND");
  cause.code = "ENOTFOUND";
  const error = new Error("DXtrade request failed", { cause });
  assert.equal(
    formatDxtradeAccountDiagnostic(error),
    "\nDXtrade diagnostic: category=DNS_ERROR http=NONE api=NONE"
  );
});

test("classifies nested fetch causes", () => {
  const lowLevel = new Error("unexpected redirect to https://secret.example/path");
  const fetchError = new TypeError("fetch failed", { cause: lowLevel });
  const wrapped = new Error("DXtrade request failed", { cause: fetchError });
  const diagnostic = formatDxtradeAccountDiagnostic(wrapped);
  assert.equal(diagnostic, "\nDXtrade diagnostic: category=REDIRECT_BLOCKED http=NONE api=NONE");
  assert.equal(diagnostic.includes("secret.example"), false);
});
