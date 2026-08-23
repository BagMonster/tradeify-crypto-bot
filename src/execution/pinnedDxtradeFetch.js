function requireFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  return fetchImpl;
}

export function createPinnedDxtradeFetch({
  fetchImpl = globalThis.fetch
} = {}) {
  const request = requireFetch(fetchImpl);

  return async function dxtradeFetch(input, init = {}) {
    return request(input, {
      ...init,
      redirect: "follow"
    });
  };
}

export const DXTRADE_REDIRECT_POLICY = Object.freeze({
  mode: "native-follow"
});
