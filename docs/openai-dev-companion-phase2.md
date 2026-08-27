# OpenAI Development Companion — Phase 2 plan

Phase 1 stays conversational. Phase 2 is the first time BMTB1 can inspect live body state without the owner pasting Telegram output, then later propose GitHub changes under owner confirmation.

Continuity: `docs/6th_AUTHORITATIVE_PROJECT_STATE_Tradeify_Crypto_Bot.md`.

## Current gate status (2026-08-26)

- Five-slot operator latches are live (D-048).
- Live books match after D-054: virtual −0.44 = broker −0.44, `Bot: RUNNING`, SHORT2 open. There is no reconciliation halt to clear.
- Automatic execution remains owner-gated. Companion still must not place orders.
- Phase 2c (D-052) is **done on `main`**.
- Phase 2a/2b (D-051) is **approved and not on `main`**. Recreate on current `main`; do not merge stale PR #47.
- Phase 2d is **not next**.

Do **not** `/reconcile` or `/rematch` while SHORT2 is open and the books already match.

## Phase 2a — live body snapshot (read-only) — D-051, not on main

Trading worker writes a sanitized row to Postgres every 15 seconds and on `/status`:

- Binance last price and trade time
- 200-day MA
- virtual net, open lots, occupied/armed rings
- last confirmed fill side/price/time
- broker SOL open yes/no and **signed** net units from `trustedSignedNet()` (`null` if unread)
- pause, safety halt, ladder flags

Companion reads that row on every job. No DXtrade credentials on the companion service. Companion must not run the publisher.

## Phase 2b — halt-first diagnosis — same D-051 slice

If snapshot or `/status` shows pause, halt, unread broker data, or a true finite virtual≠broker mismatch, the first sentence must say that and name the exact command still needed.

Required naming:

- unread / `ACCOUNT_DATA_UNAVAILABLE` — not a mismatch; ask for `/status`; do not recommend `/reconcile`
- finite mismatch + exact recon halt + nets now agree — `/rematch` then `/confirmrematch CODE`
- DXtrade actually flat + leftover virtual lots — `/reconcile` then `/confirmreconcile CODE`
- open SHORT2 — never `/reconcile`

## Phase 2c — repo inspection tools — done (D-052 / PR #48)

Owner-confirmed, read-only GitHub tools limited to `BagMonster/tradeify-crypto-bot`:

- `list_repo_files`
- `read_repo_file`
- `search_repo_code`

No write, no merge, no Railway deploy control. Requires `GITHUB_TOKEN` on the companion worker only.

## Phase 2d — proposal-bound writes — not started, not next

Only after the owner types an explicit confirm phrase:

1. companion opens a feature branch
2. pushes a scoped patch
3. opens a PR
4. reports the PR URL in Telegram

Merge and Railway deploy stay owner actions. Do not implement 2d in the same PR as D-051.

## Out of Phase 2

- Sending DXtrade orders from `/code`
- Clearing safety halt from chat
- Changing D-049 sizes without a written decision
- Reading `.env` or secrets
- Deploying the companion worker in place of the trading worker
