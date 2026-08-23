import test from "node:test";
import assert from "node:assert/strict";
import {
  createPinnedDxtradeFetch,
  DXTRADE_REDIRECT_POLICY
} from "../src/execution/pinnedDxtradeFetch.js";

function redirect(location, status = 307) {
  return new Response(null, { status, headers: { location } });
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("follows a same-host HTTPS redirect inside the pinned DXtrade REST path", async () => {
  const calls = [];
  const responses = [
    redirect("/dxsca-web/login/", 307),
    json({ sessionToken: "ok" })
  ];
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.toString(), options });
    return responses.shift();
  };
  const fetch = createPinnedDxtradeFetch({ fetchImpl });
  const response = await fetch("https://dx.tradeifycrypto.co/dxsca-web/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{\"safe\":true}",
    redirect: "error"
  });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[1].url, "https://dx.tradeifycrypto.co/dxsca-web/login/");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.body, "{\"safe\":true}");
});

test("blocks redirects to another host before sending a second request", async () => {
  const calls = [];
  const fetch = createPinnedDxtradeFetch({
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), options });
      return redirect("https://example.com/steal", 302);
    }
  });

  await assert.rejects(
    fetch("https://dx.tradeifycrypto.co/dxsca-web/login", { method: "POST" }),
    /Unexpected redirect/i
  );
  assert.equal(calls.length, 1);
});

test("blocks same-host redirects that escape the DXtrade REST base path", async () => {
  const fetch = createPinnedDxtradeFetch({
    fetchImpl: async () => redirect("https://dx.tradeifycrypto.co/other", 307)
  });

  await assert.rejects(
    fetch("https://dx.tradeifycrypto.co/dxsca-web/login", { method: "POST" }),
    /Unexpected redirect/i
  );
});

test("enforces a small redirect limit", async () => {
  let callCount = 0;
  const fetch = createPinnedDxtradeFetch({
    maxRedirects: 1,
    fetchImpl: async () => {
      callCount += 1;
      return redirect("/dxsca-web/login/", 307);
    }
  });

  await assert.rejects(
    fetch("https://dx.tradeifycrypto.co/dxsca-web/login", { method: "POST" }),
    /redirect limit/i
  );
  assert.equal(callCount, 2);
});

test("exports the frozen production redirect boundary", () => {
  assert.deepEqual(DXTRADE_REDIRECT_POLICY, {
    hostname: "dx.tradeifycrypto.co",
    basePath: "/dxsca-web",
    maxRedirects: 3
  });
  assert.equal(Object.isFrozen(DXTRADE_REDIRECT_POLICY), true);
});
