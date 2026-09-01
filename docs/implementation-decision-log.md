# Tradeify Crypto Bot — Implementation Decision Log

This log records approved and proposed changes or additions to the baseline build process in `Tradeify_Familiar_Format_Build_Manual.md`.

An approved entry supersedes the corresponding baseline requirement or adds a governing build gate. An entry marked **approved** is not **implemented** until its affected files, settings, or process step have been completed and its required test has passed.

> **Current production strategy note (2026-08-25):** Live SOL grid geometry and sizing are governed by **D-049**, not the original D-040 numeric table. D-040 remains the source of live-touch, virtual-lot, and activation structure except where D-049 explicitly supersedes sizing, ring count, exposure ceiling, and heartbeat compliance.

For the full historical log body through D-047, see git history on `main` prior to the D-049 docs sync. The governing recent SOL decisions are summarized below.

## D-057 — Multiple SOL/USD broker tickets are a valid book

**Status:** APPROVED to build 2026-08-27; not merged to `main` until owner `/kill` + trading-worker deploy.

Several `SOL/USD` DXtrade tickets are allowed. Signed net is the sum. Lockout remains for foreign instruments and count mismatches. Virtual-lot ↔ ticket-id binding is not in this change.

Full decision: `docs/decisions/D-057-multi-sol-broker-tickets.md`.

## D-056 — Autonomous chronicle publishing

**Status:** APPROVED to build and test 2026-08-26; **not enabled**.

BMTB1 may publish `docs/chronicle/**` entries with mechanical checks and automatic squash-merge. No prose approval. Companion env flag stays off in this change. Trading Railway must ignore docs-only commits before enablement.

Publications bind captured main SHA, content hashes, hash-suffixed branch, and expected head SHA. TIMELINE.md is read from that SHA. Merge requires exactly two files, head-byte hash match, live kill-switch + main re-check, and GitHub `merged === true`. Claims are atomic; `merged !== true` is never marked done.

Full decision: `docs/decisions/D-056-autonomous-chronicle-publish.md`.

## D-040 — Frozen SOL outer-heavy grid baseline (superseded in part by D-049)

**Status:** APPROVED 2026-08-23; **sizing/geometry/ceiling/heartbeat parameters superseded by D-049** on 2026-08-25.

Original freeze: 200-day MA; 4.5% bands; dead zone ±18%; 8 rings/side ±22.5%…±54%; base $6 × 1.8; ceiling ~$1,830; heartbeat 25 days.

Full original decision: `docs/decisions/D-040-sol-outer-heavy-v1.md`.

## D-041 — SOL live-touch production semantics

**Status:** APPROVED 2026-08-23; still governing.

Live Binance touches; exits before entries; confirmed-fill-only state advancement.

Full decision: `docs/decisions/D-041-sol-live-touch-production-semantics.md`.

## D-045 — Final SOL live activation

**Status:** APPROVED 2026-08-23 after successful V2 canary; still governing activation controls.

Full decision: `docs/decisions/D-045-final-sol-live-activation.md`.

## D-046 — Telegram SOL ring observability

**Status:** APPROVED and implemented; display geometry follows current `GRID_DEFINITION` (10×10 under D-049).

Full decision: `docs/decisions/D-046-telegram-ring-observability.md`.

## D-047 — Telegram broker-confirmed live trade and safety notifications

**Status:** APPROVED and implemented; extended by D-049 protective cut/flatten notification classes.

Full decision: `docs/decisions/D-047-telegram-live-notifications.md`.

## D-048 — Simplified OpenAI development companion

**Status:** APPROVED 2026-08-24; Phase 1 companion path.

Full decision: `docs/decisions/D-048-simplified-openai-development-companion.md`.

## D-049 — SOL grid resize, ring geometry change, and three-layer daily risk ladder

**Status:** APPROVED by owner; **implemented and merged to `main` via PR #37 on 2026-08-25** (squash `9372332`).

### What changed

| Parameter | D-040 | D-049 |
|---|---|---|
| deadZoneBands | 4 (±18%) | 2 (±13.5%) |
| activeLevelsPerSide | 8 | 10 |
| baseUsd | 6 | 28.68 |
| growth | 1.8 | 1.5 |
| grossExposureCeilingUsd | ~1830 | 6600 |
| heartbeatDays | 25 (decision) / 30 stale config | 25 |

### Risk ladder

- Entry brake −$300 (block entries; exits continue)
- Partial cut −$1,000 at 50% of each open virtual lot (remaining **and** original quantity reduced)
- Full flatten −$1,250 with halt until next 22:00 UTC account-day rollover
- Protective cut/flatten bypass `execution.slippageCapPct`
- Evaluated on live equity including unrealized vs previous day **closed** balance

### Unchanged

`maDays` 200, `bandPct` 0.045, positions per ring 2, re-arm 0.5, lot step 0.01, tranche weights, 0.18% round-trip floor, live-touch exits-before-entries, $1,500 daily-loss protection, account floors, reconciliation, owner pause / safety halt / lockout, D-045 activation model.

### Deploy constraint

State must be 20 rings. Old 16-ring state fails closed until flat re-init or migration. Never run D-049 size with the ladder disabled.

### Rollback

Restore D-040 sizing constants; set `riskLadder.enabled=false`; keep `heartbeatDays=25`.

Full decision: `docs/decisions/D-049-sol-risk-ladder-and-resize.md`.

## D-050 — Audited two-step virtual reconcile

**Status:** APPROVED by owner 2026-08-26; implemented on `feature/d050-reconcile-command`.

Owner-only `/reconcile` + `/confirmreconcile CODE` flattens stale virtual lots and clears the reconciliation safety halt when DXtrade is already flat. It does not place orders and does not remove the operator pause.

Full decision: `docs/decisions/D-050-audited-virtual-reconcile.md`.

## D-052 — Phase 2c read-only repository inspection

**Status:** APPROVED by owner 2026-08-26; implemented on `feature/d052-repo-inspection`.

BMTB1 `/code` may list, read, and search `BagMonster/tradeify-crypto-bot` through companion-worker GitHub tools. No writes, merge, deploy, or trading tools.

Full decision: `docs/decisions/D-052-repo-inspection-tools.md`.

## D-059 — One-sided grid, position-linked exits, unread book fails closed

**Status:** DRAFT — awaiting owner approval.

EXIT intents close live same-side SOL/USD broker tickets by `positionCode`; protective cut and flatten operate across every SOL ticket, and flatten is successful only after a confirming flat-book read. ENTRY intents remain OPEN orders but are blocked while any opposing-side SOL ticket exists. A failed or invalid positions read returns `ACCOUNT_DATA_UNAVAILABLE` and places no order; failed post-flatten verification returns `NOT_VERIFIED`.

This decision documents the material one-sided strategy rule shipped in PR #61 and requires owner approval before deployment. The heartbeat close bug, live partial-close canary, virtual-lot-to-position binding, and multi-asset expansion remain out of scope.

Full decision: `docs/decisions/D-059-one-sided-grid-and-position-linked-exits.md`.
