# Tradeify Crypto Bot — Implementation Decision Log

This log records approved and proposed changes or additions to the baseline build process in `Tradeify_Familiar_Format_Build_Manual.md`.

An approved entry supersedes the corresponding baseline requirement or adds a governing build gate. An entry marked **approved** is not **implemented** until its affected files, settings, or process step have been completed and its required test has passed.

> **Current production note (2026-08-26):** Live SOL grid geometry and sizing are governed by **D-049**. Live book handling is governed by **D-050** (flat-broker virtual flatten), **D-053** (matched-book rematch + signed net), and **D-054** (unread broker data is not a flat book). Continuity: `docs/6th_AUTHORITATIVE_PROJECT_STATE_Tradeify_Crypto_Bot.md`. Main tip described there: `9438cf73`.

For the full historical log body through D-047, see git history on `main` prior to the D-049 docs sync. The governing recent SOL decisions are summarized below.

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

**Status:** APPROVED 2026-08-24; implemented. BMTB1 identity, body-map, five sticky operator latches on `main`.

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

**Status:** APPROVED by owner 2026-08-26; **implemented and merged to `main` via PR #46** (`b3c0a6d1`).

Owner-only `/reconcile` + `/confirmreconcile CODE` flattens stale virtual lots and clears the reconciliation safety halt when DXtrade is already flat. It does not place orders and does not remove the operator pause. **Forbidden while an open DXtrade short such as SHORT2 is still on the broker.**

Full decision: `docs/decisions/D-050-audited-virtual-reconcile.md`.

## D-051 — Live body snapshot for BMTB1

**Status:** APPROVED by owner 2026-08-26 as Phase 2a + 2b. **Not on `main`.** Stale PR #47 is based on D-050 and must not be squash-merged. Recreate on `9438cf73` (or a descendant) with `trustedSignedNet()`, rematch/unread diagnosis, trading-worker publisher, and D-052 GitHub tools preserved.

Full decision: `docs/decisions/D-051-live-body-snapshot.md`.

## D-052 — Phase 2c read-only repository inspection

**Status:** APPROVED by owner 2026-08-26; **implemented and merged to `main` via PR #48** (`40ffcb45`).

BMTB1 `/code` may list, read, and search `BagMonster/tradeify-crypto-bot` through companion-worker GitHub tools. No writes, merge, deploy, or trading tools. `GITHUB_TOKEN` lives on the companion worker only.

Full decision: `docs/decisions/D-052-repo-inspection-tools.md`.

## D-053 — Matched book rematch

**Status:** APPROVED by owner 2026-08-26; **implemented and merged to `main` via PR #49** (`af455f6`).

Signed SELL/SHORT net; `/positions` overlay; owner `/rematch` + `/confirmrematch CODE` only while the exact reconciliation-mismatch halt is latched and virtual net already agrees with a fresh broker net. Does not flatten lots and does not place orders.

Full decision: `docs/decisions/D-053-matched-book-rematch.md`.

## D-054 — Unread DXtrade book is not a flat book

**Status:** APPROVED by owner 2026-08-26; **implemented and merged to `main` via PR #50** (`9438cf73`).

`trustedSignedNet()` returns `null` unless the monitor snapshot has a finite signed net and `/positions` did not fail. Unread returns `ACCOUNT_DATA_UNAVAILABLE` and does **not** latch the reconciliation halt. `/status` and `/health` force a monitor poll before printing broker lines.

Full decision: `docs/decisions/D-054-unread-broker-fail-closed.md`.
