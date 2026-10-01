// Display-only price formatting for Telegram and owner text.
//
// Coins like PEPE trade near $0.000004, which two- or four-decimal currency
// formatting rounds to "$0.00". Prices under $0.01 are shown in scientific
// notation with four significant figures ($4.270e-6); everything else keeps the
// existing currency style. Never used for order sizing or broker requests.

const SMALL_PRICE_USD = 0.01;

export function formatPrice(value, { maximumFractionDigits = 4 } = {}) {
  if (!Number.isFinite(value)) return "unavailable";
  if (value !== 0 && Math.abs(value) < SMALL_PRICE_USD) {
    return `${value < 0 ? "-" : ""}$${Math.abs(value).toExponential(3)}`;
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits
  }).format(value);
}
