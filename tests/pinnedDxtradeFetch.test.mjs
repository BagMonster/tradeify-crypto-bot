import test from "node:test";
import assert from "node:assert/strict";
import {
  createPinnedDxtradeFetch,
  DXTRADE_REDIRECT_POLICY
} from "../src/execution/pinnedDxtradeFetch.js";

function redirect(location, status = 302) {
  return new Response(null, { status, headers: { location } });
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("preserves POST method and body across a DXtrade 302 redirect", async () => {
  const calls = [];
  const responses = [
    redirect("https://redirected.example/api/login", 302),
    json({ sessionToken: "ok" })
  ];
  const fetch = createPinnedDxtradeFetch({
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), options });
      return responses.shift();
    }
  });

  const response = await fetch("https://dx.tradeifycrypto.co/dxsca-web/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{\"username\":\"test\"}",
    redirect: "follow"
  });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[1].options.redirect, "manual");
  assert.equal(calls[1].url, "https://redirected.example/api/login");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.body, "{\"username\":\"test\"}");
});

test("follows relative HTTPS redirects without changing the request", async () => {
  const calls = [];
  const responses = [
    redirect("/dxsca-web/login/", 307),
    json({ sessionToken: "ok" })
  ];
  const fetch = createPinnedDxtradeFetch({
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), options });
      return responses.shift();
    }
  });

  await fetch("https://dx.tradeifycrypto.co/dxsca-web/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });

  assert.equal(calls[1].url, "https://dx.tradeifycrypto.co/dxsca-web/login/");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.body, "{}");
});

test("does not send DXtrade credentials over a redirected plaintext HTTP connection", async () => {
  const fetch = createPinnedDxtradeFetch({
    fetchImpl: async () => redirect("http://redirected.example/login", 302)
  });

  await assert.rejects(
    fetch("https://dx.tradeifycrypto.co/dxsca-web/login", {
      method: "POST",
      body: "{\"password\":\"secret\"}"
    }),
    /leave HTTPS/i
  );
});

test("exports redirect policy", () => {
  assert.deepEqual(DXTRADE_REDIRECT_POLICY, {
    mode: "manual-preserve-method",
    maxRedirects: 10
  });
  assert.equal(Object.isFrozen(DXTRADE_REDIRECT_POLICY), true);
});
