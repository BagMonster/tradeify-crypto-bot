# D-050 — Audited two-step virtual reconcile

**Status:** APPROVED by the owner 2026-08-26.
**Does not change:** D-049 geometry, risk ladder, live-touch semantics, or D-045 activation gates.

## Why

A manual DXtrade flatten (owner sold the leftover `0.06 SOL` in the app before the D-049 ring cutover) left the bot holding a stale virtual short lot. Reconciliation then latched a safety halt: virtual net `-0.06` vs broker flat. There was no audited operator path to empty virtual inventory without raw SQL.

## Decision

Add owner-only Telegram commands that mirror `/resume`:

1. `/reconcile` — inspect broker + virtual book, refuse if DXtrade still shows an open SOL position, issue a 6-digit code that expires in 10 minutes.
2. `/confirmreconcile CODE` — verify the code with a `reconcile:`-prefixed challenge hash, require the broker still flat, empty every virtual lot, rearm all 20 rings, write `SOL_VIRTUAL_RECONCILE_APPLIED`, and clear the safety halt.

Hard limits:

- No DXtrade order is placed, modified, or canceled.
- The operator pause is not removed. `/resume` remains a separate two-step after `/status` shows broker flat and virtual net `0.00`.
- A `/resume` code cannot confirm a reconcile, and a reconcile code cannot confirm a resume.
- No raw SQL. Persistence goes through `persistence.state.save` with the existing optimistic version check.
- Slash-command only. No inline button.

## Repair sequence for the current halt

1. Confirm DXtrade `SOL/USD` is flat (`/status` shows position open `NO`).
2. `/reconcile`
3. `/confirmreconcile <code>`
4. `/status` again — virtual net must be `0.00`, safety halt cleared, operator pause still active.
5. Only then `/resume` / `/confirmresume`.

## Related code

- `src/state/solanaReconcile.js`
- `src/solanaTradeifyService.js`
- `src/telegramBot.js`
- `src/database.js` (`clearSafetyHalt`)
- `tests/solanaReconcile.test.mjs`
- `tests/solanaReconcileCommand.test.mjs`
