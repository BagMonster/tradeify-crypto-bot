const PRIMARY_HOSTNAME = "dx.tradeifycrypto.co";
const PROVIDER_DOMAIN_SUFFIX = ".tradeifycrypto.co";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;

function requireFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  return fetchImpl;
}

function requireMaxRedirects(value) {
  if (!Number.isInteger(value) || value < 0 || value > 10) {
    throw new TypeError("maxRedirects must be an integer from 0 to 10");
  }
  return value;
}

function isTradeifyCryptoHost(hostname) {
  return hostname === PRIMARY_HOSTNAME || hostname.endsWith(PROVIDER_DOMAIN_SUFFIX);
}

function providerUrl(input) {
  const url = input instanceof URL ? new URL(input.toString()) : new URL(String(input));
  if (
    url.protocol !== "https:" ||
    !isTradeifyCryptoHost(url.hostname) ||
    url.port !== "" ||
    url.username ||
    url.password
  ) {
    throw new Error("Unexpected redirect outside the Tradeify Crypto HTTPS domain");
  }
  url.hash = "";
  return url;
}

function redirectLocation(response) {
  if (!REDIRECT_STATUSES.has(response?.status)) return null;
  const location = response.headers?.get?.("location");
  if (typeof location !== "string" || location.trim() === "") {
    throw new Error("Unexpected redirect without a DXtrade location header");
  }
  return location;
}

export function createPinnedDxtradeFetch({
  fetchImpl = globalThis.fetch,
  maxRedirects = DEFAULT_MAX_REDIRECTS
} = {}) {
  const request = requireFetch(fetchImpl);
  const redirectLimit = requireMaxRedirects(maxRedirects);

  return async function pinnedDxtradeFetch(input, init = {}) {
    let url = providerUrl(input);
    let redirectCount = 0;

    while (true) {
      const response = await request(url, {
        ...init,
        redirect: "manual"
      });
      const location = redirectLocation(response);
      if (location === null) return response;

      if (redirectCount >= redirectLimit) {
        throw new Error("Unexpected redirect limit exceeded for DXtrade REST request");
      }

      url = providerUrl(new URL(location, url));
      redirectCount += 1;
    }
  };
}

export const DXTRADE_REDIRECT_POLICY = Object.freeze({
  primaryHostname: PRIMARY_HOSTNAME,
  providerDomainSuffix: PROVIDER_DOMAIN_SUFFIX,
  maxRedirects: DEFAULT_MAX_REDIRECTS
});
