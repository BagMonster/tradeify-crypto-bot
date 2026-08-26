# OpenAI Development Companion — Phase 2 plan

Phase 1 stays conversational. Phase 2 is the first time BMTB1 can inspect live body state without the owner pasting Telegram output, then propose GitHub changes under owner confirmation.

## Do not start Phase 2 until

- The current reconciliation halt is cleared: virtual lots match DXtrade net SOL, or the virtual book is intentionally flattened.
- Five-slot operator latches are live and `/status` + `/levels` can be reasoned about together.
- Automatic execution remains owner-gated. Companion still must not place orders.

## Phase 2a — live body snapshot (read-only)

Trading worker writes a sanitized row to Postgres on each status refresh:

- Binance last price and trade time
- 200-day MA
- virtual net, open lots, occupied/armed rings
- last confirmed fill side/price/time
- broker SOL open yes/no and net units
- pause, safety halt, ladder flags

Companion reads that row on every job. No DXtrade credentials on the companion service.

## Phase 2b — halt-first diagnosis

If snapshot or `/status` shows pause, halt, or virtual≠broker, the first sentence must say that and name the exact command still needed (`/rings`, `/health`) instead of asking for a generic paste.

## Phase 2c — repo inspection tools

Implemented under D-052. Owner-confirmed, read-only GitHub tools limited to `BagMonster/tradeify-crypto-bot`:

- `list_repo_files`
- `read_repo_file`
- `search_repo_code`

No write, no merge, no Railway deploy control. Requires `GITHUB_TOKEN` on the companion worker only.

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
