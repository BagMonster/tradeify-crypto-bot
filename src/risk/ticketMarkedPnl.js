/**
 * Calculates an instrument's open P&L from its own broker tickets and a fresh
 * Binance mark.  DXtrade's account metrics expose account-wide equity, but not
 * reliable per-ticket P&L for this account; allocating that account value by
 * notional is not a valid per-instrument risk measurement.
 */

function positive(name, value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError(`${name} must be a positive number`);
  return number;
}

function signedQuantity(ticket, index) {
  const quantity = Number(ticket?.quantity);
  if (!Number.isFinite(quantity) || Math.abs(quantity) <= 1e-12) {
    throw new TypeError(`ticket ${index} quantity must be non-zero and finite`);
  }
  return quantity;
}

/**
 * @param {{ tickets: Array<{quantity: number, entryPrice: number}>, markPrice: number }} input
 * @returns {number} open P&L in USD, using signed ticket quantity
 */
export function ticketMarkedOpenPnlUsd({ tickets, markPrice }) {
  if (!Array.isArray(tickets)) throw new TypeError("tickets must be an array");
  if (tickets.length === 0) return 0;
  const mark = positive("markPrice", markPrice);
  return tickets.reduce((total, ticket, index) => {
    const quantity = signedQuantity(ticket, index);
    const entry = positive(`ticket ${index} entryPrice`, ticket?.entryPrice);
    return total + (quantity * (mark - entry));
  }, 0);
}
