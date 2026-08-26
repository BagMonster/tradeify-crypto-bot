# OpenAI Development Companion — Phase 2 plan

Phase 1 stays conversational. Phase 2 is the first time BMTB1 can inspect live body state without the owner pasting Telegram output, then propose GitHub changes under owner confirmation.

## Gates

- Reconciliation halt cleared via D-050: **done 2026-08-26**.
- Five-slot operator latches live: **done**.
- Automatic execution remains owner-gated. Companion still must not place orders.

## Phase 2a — live body snapshot (read-only)

**Status:** implemented under D-051.

Trading worker writes a sanitized row to Postgres on each status refresh:

- Binance last price and trade time
- 200-day MA
- virtual net, open lots, occupied/armed rings
- last confirmed fill side/price/time
- broker SOL open yes/no and net units
- pause, safety halt, ladder flags

Companion reads that row on every job. No DXtrade credentials on the companion service.

Trading worker publish path: 15-second timer plus `/status`. Table: `sol_companion_live_snapshot`.

## Phase 2b — halt-first diagnosis

**Status:** implemented under D-051.

If snapshot or `/status` shows pause, halt, or virtual≠broker, the first sentence must say that and name the exact command still needed (`/rings`, `/health`, `/reconcile`) instead of asking for a generic paste.

## Phase 2c — repo inspection tools

Owner-confirmed, read-only GitHub tools limited to `BagMonster/tradeify-crypto-bot`:

- list files
- read a path
- search code

No write, no merge, no Railway deploy control.

## Phase 2d — proposal-bound writes

Only after the owner types an explicit confirm phrase:

1. companion opens a feature branch
2. pushes a scoped patch
3. opens a PR
4. reports the PR URL in Telegram

Merge and Railway deploy stay owner actions.

## Out of Phase 2

- Sending DXtrade orders from `/code`
- Clearing safety halt from chat
- Changing D-049 sizes without a written decision
- Reading `.env` or secrets
