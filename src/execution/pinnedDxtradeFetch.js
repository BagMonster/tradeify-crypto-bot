const REQUIRED_HOSTNAME = "dx.tradeifycrypto.co";
const REQUIRED_BASE_PATH = "/dxsca-web";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 3;

function requireFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  return fetchImpl;
}

function requireMaxRedirects(value) {
  if (!Number.isInteger(value) || value < 0 || value > 5) {
    throw new TypeError("maxRedirects must be an integer from 0 to 5");
  }
  return value;
}

function pinnedUrl(input) {
  const url = input instanceof URL ? new URL(input.toString()) : new URL(String(input));
  if (
    url.protocol !== "https:" ||
    url.hostname !== REQUIRED_HOSTNAME ||
    url.port !== "" ||
    url.username ||
    url.password ||
    (url.pathname !== REQUIRED_BASE_PATH && !url.pathname.startsWith(`${REQUIRED_BASE_PATH}/`))
  ) {
    throw new Error("Unexpected redirect outside the pinned DXtrade REST origin");
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
    let url = pinnedUrl(input);
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

      const nextUrl = pinnedUrl(new URL(location, url));
      url = nextUrl;
      redirectCount += 1;
    }
  };
}

export const DXTRADE_REDIRECT_POLICY = Object.freeze({
  hostname: REQUIRED_HOSTNAME,
  basePath: REQUIRED_BASE_PATH,
  maxRedirects: DEFAULT_MAX_REDIRECTS
});
