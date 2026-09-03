# Tradeify Crypto Bot — Implementation Decision Log

This log records approved and proposed changes to the production bot.

> **Current production (2026-09-01):** Five ring grids from `config/instruments.json` under **D-060**, one-sided per instrument with position-linked exits under **D-059**. Live continuity: `docs/6th_AUTHORITATIVE_PROJECT_STATE_Tradeify_Crypto_Bot.md`. D-049 remains the historical SOL resize that D-060 replaced. **D-062 (DRAFT)** would replace enabled ZEC/USD with INJ/USD; it is not live until the owner merges and deploys.

## D-062 — Swap ZEC/USD for INJ/USD

**Status:** DRAFT — awaiting owner approval. Not on live Railway until merged and the trading worker is deployed.

ZEC sits outside its ±12–33% band 23.6% of measured days and was +87.75% versus its 200-day MA with no open lots. No MA length brings the live print inside the outer short. INJ uses its own fit: 5.0% bands, dead zone 3, 12 levels, ±20% to ±75%, derived base $12.23, cap $6,300. Enabled set becomes SOL, DOGE, INJ, AAVE, AVAX. ZEC profile stays registered.

Full decision: `docs/decisions/D-062-swap-zec-for-inj.md`.

## D-060 — Multi-asset grid and account-level risk supervisor

**Status:** LIVE on `main` as of 2026-09-01. Railway trading worker is running all five enabled books with automatic execution ON.

Ring geometry, caps, lot steps, and prefixes live in `config/instruments.json` for SOL/USD, DOGE/USD, ZEC/USD, AAVE/USD, and AVAX/USD. `baseUsd` is derived from each cap. Account supervisor: brake −$300 per instrument, 50% cut at −$1,000 on losers only, flatten all books at −$1,250 until 22:00 UTC. Daily loss limit $1,500.

Telegram reads fan out; `/kill` is global; `/resume`, `/reconcile`, and `/rematch` require an instrument.

Full decision: `docs/decisions/D-060-multi-asset-grid.md`.

## D-059 — One-sided grid, position-linked exits, unread book fails closed

**Status:** LIVE on `main` (PR #61, then generalized by the D-060 ring guard).

EXIT and protective paths close live same-side tickets by `positionCode`. ENTRY stays OPEN but is blocked while an opposing ticket exists on that instrument. Unreadable positions return `ACCOUNT_DATA_UNAVAILABLE`. Flatten is not done until a confirming flat read.

Heartbeat close and the live partial-close canary remain open defects.

Full decision: `docs/decisions/D-059-one-sided-grid-and-position-linked-exits.md`.

## D-057 — Multiple SOL/USD broker tickets are a valid book

**Status:** APPROVED and on `main`. Extended by D-060 to multiple enabled instruments. Signed net is the sum per instrument. Foreign symbols still lock the account.

Full decision: `docs/decisions/D-057-multi-sol-broker-tickets.md`.

## D-056 — Autonomous chronicle publishing

**Status:** APPROVED to build; **not enabled**. `CHRONICLE_AUTONOMOUS_PUBLISH` stays false.

Full decision: `docs/decisions/D-056-autonomous-chronicle-publish.md`.

## D-054 — Unread broker fails closed

**Status:** APPROVED and governing. An unread book is `ACCOUNT_DATA_UNAVAILABLE`, never net 0.

Full decision: `docs/decisions/D-054-unread-broker-fail-closed.md`.

## D-041 — Live-touch production semantics

**Status:** APPROVED; still governing every book.

Live Binance touches; exits before entries; confirmed-fill-only state advancement.

Full decision: `docs/decisions/D-041-sol-live-touch-production-semantics.md`.

## D-045 — Final live activation controls

**Status:** APPROVED; still governing the two execution locks.

Full decision: `docs/decisions/D-045-final-sol-live-activation.md`.

## D-046 — Telegram ring observability

**Status:** APPROVED. Display now follows each instrument’s D-060 definition, not the old single `GRID_DEFINITION`.

Full decision: `docs/decisions/D-046-telegram-ring-observability.md`.

## D-047 — Telegram broker-confirmed notifications

**Status:** APPROVED and implemented.

Full decision: `docs/decisions/D-047-telegram-live-notifications.md`.

## D-048 — OpenAI / Gemini development companion

**Status:** APPROVED. Companion worker only.

Full decision: `docs/decisions/D-048-simplified-openai-development-companion.md`.

## D-049 — SOL grid resize and original three-layer daily risk ladder

**Status:** APPROVED historically (PR #37, 2026-08-25). **Live SOL geometry and the account ladder are D-060.** Keep this entry for the $28.68 / $6,600 / 4.5% / dead-zone-2 shape that was migrated off.

Full decision: `docs/decisions/D-049-sol-risk-ladder-and-resize.md`.

## D-050 — Audited two-step virtual reconcile

**Status:** APPROVED and live. Multi-instrument form is `/reconcile INSTRUMENT` then `/confirmreconcile CODE INSTRUMENT`.

Full decision: `docs/decisions/D-050-audited-virtual-reconcile.md`.

## D-052 — Phase 2c read-only repository inspection

**Status:** APPROVED. Companion worker only.

Full decision: `docs/decisions/D-052-repo-inspection-tools.md`.

## D-053 — Matched-book rematch

**Status:** APPROVED. Multi-instrument form is `/rematch INSTRUMENT` then `/confirmrematch CODE INSTRUMENT`.

Full decision: `docs/decisions/D-053-matched-book-rematch.md`.

## D-040 — Frozen SOL outer-heavy baseline

**Status:** APPROVED 2026-08-23; sizing superseded by D-049, then by D-060.

Full original decision: `docs/decisions/D-040-sol-outer-heavy-v1.md`.
