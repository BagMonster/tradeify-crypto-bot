import test from "node:test";
import assert from "node:assert/strict";
import {
  createPinnedDxtradeFetch,
  DXTRADE_REDIRECT_POLICY
} from "../src/execution/pinnedDxtradeFetch.js";

test("uses native redirect following for DXtrade requests", async () => {
  const calls = [];
  const fetch = createPinnedDxtradeFetch({
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), options });
      return new Response(JSON.stringify({ sessionToken: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  const response = await fetch("https://dx.tradeifycrypto.co/dxsca-web/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    redirect: "error"
  });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, "follow");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.body, "{}");
});

test("exports native-follow redirect policy", () => {
  assert.deepEqual(DXTRADE_REDIRECT_POLICY, {
    mode: "native-follow"
  });
  assert.equal(Object.isFrozen(DXTRADE_REDIRECT_POLICY), true);
});
