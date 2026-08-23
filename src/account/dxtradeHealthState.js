export function createDxtradeHealthState() {
  let diagnostic = null;

  return Object.freeze({
    markHealthy() {
      diagnostic = null;
    },
    markError(value) {
      diagnostic = typeof value === "string" && value.trim() ? value.trim() : "category=DXTRADE_ERROR http=NONE api=NONE";
    },
    getText() {
      return diagnostic ? `ERROR ${diagnostic}` : "OK";
    }
  });
}
