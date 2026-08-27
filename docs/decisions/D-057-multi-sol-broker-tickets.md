# D-057 — Multiple SOL/USD broker tickets are a valid book

**Status:** APPROVED to build 2026-08-27 by owner (Tradeify UI shows multiple open tickets; single-ticket lockout blocked the live grid).
**Does not change:** D-049 geometry, risk ladder, virtual lots, `/reconcile`, `/rematch`, or chronicle publishing.
**Does not enable:** foreign-instrument trading. A non-SOL/USD ticket still locks the account.

## Why

Tradeify/DXtrade lists each fill as its own open ticket. The outer-heavy grid is supposed to hold several ring lots at once. The old invariant treated `openPositionsCount > 1` or more than one `SOL/USD` row as a lockout. That stopped new grid actions even when every ticket was SOL.

## Decision

1. Several non-zero `SOL/USD` rows are valid.
2. Signed broker net is the **sum** of those rows (sell/short negative).
3. Notional is the sum of absolute ticket notionals.
4. Lockout remains only for:
   - a non-`SOL/USD` position, or
   - `openPositionsCount` not matching the non-zero position list, or
   - an unreadable `/positions` book.
5. Reconciliation still compares **virtual net** to **signed broker net**. It does not require ticket count === 1.
6. This change does **not** yet bind each virtual lot to a DXtrade position id. Flatten/cut still act on the signed SOL net.

## Files

- `src/account/dxtradeAccountMonitor.js`
- `src/account/dxtradeSignedNet.js`
- `tests/dxtradeAccountMonitor.test.mjs`
- `tests/dxtradeSignedNet.test.mjs`

## Deploy

`/kill` before trading-worker deploy. Do not `/reconcile` while SHORT2 is open. Confirm `/status` virtual net equals summed broker net, no lockout, SHORT2 intact, then resume.
