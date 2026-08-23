const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 10;

function requireFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  return fetchImpl;
}

function requireMaxRedirects(value) {
  if (!Number.isInteger(value) || value < 0 || value > 20) {
    throw new TypeError("maxRedirects must be an integer from 0 to 20");
  }
  return value;
}

function nextRedirectUrl(response, currentUrl) {
  if (!REDIRECT_STATUSES.has(response?.status)) return null;
  const location = response.headers?.get?.("location");
  if (typeof location !== "string" || location.trim() === "") {
    throw new Error("DXtrade redirect did not include a location header");
  }

  const nextUrl = new URL(location, currentUrl);
  if (nextUrl.protocol !== "https:") {
    throw new Error("DXtrade redirect attempted to leave HTTPS");
  }
  return nextUrl;
}

export function createPinnedDxtradeFetch({
  fetchImpl = globalThis.fetch,
  maxRedirects = DEFAULT_MAX_REDIRECTS
} = {}) {
  const request = requireFetch(fetchImpl);
  const redirectLimit = requireMaxRedirects(maxRedirects);

  return async function dxtradeFetch(input, init = {}) {
    let url = input instanceof URL ? new URL(input.toString()) : new URL(String(input));
    let redirects = 0;

    while (true) {
      const response = await request(url, {
        ...init,
        redirect: "manual"
      });

      const nextUrl = nextRedirectUrl(response, url);
      if (nextUrl === null) return response;

      if (redirects >= redirectLimit) {
        throw new Error("DXtrade redirect limit exceeded");
      }

      // DXtrade's API login is POST-based. Native fetch may rewrite POST to GET
      // for 301/302/303 responses, which produced HTTP 405 from the redirected
      // endpoint. We intentionally preserve the original method, headers, and
      // body for the DXtrade redirect chain.
      url = nextUrl;
      redirects += 1;
    }
  };
}

export const DXTRADE_REDIRECT_POLICY = Object.freeze({
  mode: "manual-preserve-method",
  maxRedirects: DEFAULT_MAX_REDIRECTS
});
