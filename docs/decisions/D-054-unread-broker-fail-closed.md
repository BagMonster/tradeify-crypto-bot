# D-054 — Unread DXtrade book is not a flat book

Date: 2026-08-26

## Problem

After SHORT2 filled −0.44 SOL, `/status` showed:

- virtual net −0.44
- `SOL broker position open: NO`
- `DXtrade broker net SOL: unavailable`
- `DXtrade account data fresh: NO`

The runtime treated a missing monitor snapshot as `brokerNetUnits = 0`. That false zero vs virtual −0.44 raised the reconciliation halt. Unread and mismatch were the same path.

## Decision

1. `trustedSignedNet()` returns `null` unless the monitor snapshot has a finite signed net and `/positions` did not fail.
2. `reconciliationStatus()` treats a non-finite broker net as **unread**, not as zero.
3. Unread returns `ACCOUNT_DATA_UNAVAILABLE` and does **not** latch the reconciliation halt.
4. A true finite mismatch still returns `RECONCILIATION_BLOCKED`.
5. `/status` and `/health` force `accountMonitor.pollOnce()` before printing broker lines.
6. An unreadable `/positions` envelope must not discard a successful metrics snapshot. Mark the net unread instead.

## Operator path

Do not `/reconcile` while SHORT2 is open.

After the trading worker is on this commit:

1. `/status` — expect a numeric broker net or an explicit overlay/monitor error.
2. If broker net is −0.44, `/rematch` then `/confirmrematch CODE`.
3. If broker net stays unavailable, the worker still cannot read DXtrade. Check Railway trading-worker logs, not the companion.

## Related code

- `src/account/dxtradeSignedNet.js`
- `src/account/dxtradeAccountMonitor.js`
- `src/runtime/solanaRuntime.js`
- `src/solanaOwnerService.js`
- `index.mjs`
