# 6th_AUTHORITATIVE_PROJECT_STATE_Tradeify_Crypto_Bot.md

**Status:** Current authoritative continuity document  
**Written:** 2026-08-26 evening PDT  
**Repo:** `BagMonster/tradeify-crypto-bot`  
**Main tip this document describes:** `9438cf73` — *D-054: unread DXtrade book is not a flat book*  
**Supersedes:** `docs/5th_AUTHORITATIVE_PROJECT_STATE_Tradeify_Crypto_Bot.md` (2026-08-22) and every earlier project-state / session-handoff note as the continuity source for BMTB1 and the live SOL body.

The 5th document remains historical context for pre-live-resize work. Do not treat it as the live book, companion capability, or next-slice list.

---

## One-screen status

**Trading body:** healthy and intentional. Do not “fix” it.  
**BMTB1 voice:** live on Railway **Tradeify Dev Companion** with identity, body-map, five sticky latches, and D-052 read-only GitHub tools.  
**BMTB1 eyes:** not live. Snapshot helpers exist only on stale PR #47. The trading worker on `main` does not publish a live snapshot row.  
**Next code slice:** recreate **D-051** on `9438cf73` (or a descendant). Not Phase 2d. Not a squash-merge of PR #47.  
**Operator lock:** do **not** `/reconcile` or `/rematch` while SHORT2 is open and books already match.

---

## Who BMTB1 is

BMTB1 = Bag Monster Tradeify Bot, Telegram `@BagMonsterTradeifyBot`.

He is the OpenAI development companion, not the trading runtime.

| Piece | Role |
|---|---|
| Trading worker (`index.mjs` on Railway) | Body. Places DXtrade orders. Owns slash commands, grid, halt, rematch, reconcile. |
| Companion worker (`dev-companion.mjs` on **Tradeify Dev Companion**) | Voice. `/code` jobs via Postgres `ai_dev_jobs`. |
| Postgres | Shared brain: jobs, sticky operator latches, (future) live snapshot row. |
| DXtrade + Binance + SOL grid | Body organs. Companion must never hold DXtrade credentials or place orders. |

Slash commands stay on the trading worker and are never forwarded to OpenAI.

---

## Live trading body (do not disturb)

Owner `/status` after the D-054 trading-worker deploy (2026-08-26 evening):

```
Mode: LIVE / PRODUCTION LIVE
Auto-execution: ON
Bot: RUNNING                    ← safety_halt false AND operator_killed false
Virtual net SOL: -0.44
DXtrade broker net SOL: -0.44
DXtrade net source: metrics
DXtrade account data fresh: YES (35ms)
SOL broker position open: YES
Open virtual lots: 1
Occupied rings: 1/20
Armed rings: 20/20
Last fill: SELL @ $95.91 (2026-08-26T15:59:10.937Z)   ← SHORT2
Halted until rollover: NO
D-049 drawdown: −$2.34
Brake / cut / flatten: READY
```

Books match. Halt is off. Rematch is not needed.

| Command | Now |
|---|---|
| `/reconcile` | Forbidden while SHORT2 is open. Flattens virtual lots. Legal only when DXtrade is actually flat. |
| `/rematch` | Will refuse. Requires the exact reconciliation-mismatch safety halt. Halt is not latched. |
| `/resume` | Not needed. Not paused. |

Leave the short alone. The grid should manage SHORT2 tranches toward the live MA.

Live geometry remains **D-049**: deadZone 2, 10×10 rings, base $28.68 × 1.5, ceiling $6600, ladder −$300 / −$1000 / −$1250.

---

## What is on `main` (`9438cf73`)

| Decision | PR | SHA | State |
|---|---|---|---|
| D-048 | #40–#45 | through `03ebf88` | Live. Identity, body-map, five sticky latches. |
| D-049 | #37 | `9372332` | Live geometry and risk ladder. |
| D-050 | #46 | `b3c0a6d1` | `/reconcile` + `/confirmreconcile`. Flat-broker virtual flatten only. |
| D-052 | #48 | `40ffcb45` | Phase 2c read-only GitHub tools on the companion. |
| D-053 | #49 | `af455f6` | `/rematch` + signed SELL/SHORT net. |
| D-054 | #50 | `9438cf73` | Unread broker net is `null` / `ACCOUNT_DATA_UNAVAILABLE`. Does not latch recon halt. |
| D-051 | #47 stale | not on `main` | Approved. Must be recreated. |

Phase 2d (proposal-bound GitHub writes) is not started and is not next.

Open PR **#24** (draft SOLUSDT 5m export) is unrelated. Ignore for BMTB1.

---

## BMTB1 can / cannot

**Can (companion on `main`):** speak in `/code`; read code-body map; read five sticky latches if the owner ran those commands; call `list_repo_files`, `read_repo_file`, `search_repo_code` on this repo when `GITHUB_TOKEN` is on the companion worker.

**Cannot:** see live fills unless `/status` was latched or D-051 lands; place or close DXtrade orders; clear a halt; `/reconcile` or `/rematch` from `/code`; write GitHub, merge, or deploy Railway.

---

## D-051 — approved, not on `main`

Stale PR: https://github.com/BagMonster/tradeify-crypto-bot/pull/47  
Branch `feature/d051-live-body-snapshot` @ `797caa98`, based on D-050 (`b3c0a6d1`). Do not squash-merge it.

Helpers on that branch may be copied. Required changes before any new merge:

1. Recreate on current `main` so D-052 GitHub tools survive.
2. Wire the 15s + `/status` publisher on the **trading** worker only.
3. Capture broker net with `trustedSignedNet()`. Never unsigned quantity. Never coerce unread to `0`.
4. Diagnosis must name unread vs rematch vs reconcile. SHORT2 open → never recommend `/reconcile`.
5. Deploy trading worker first, companion second.

---

## Architecture that must not be broken

```
Owner Telegram
  ├─ slash commands  → trading worker → DXtrade / Postgres bot_state
  └─ /code + prose    → trading worker enqueues ai_dev_jobs
                         → companion claims job
                         → BODY MAP + (future) LIVE SNAPSHOT + operator pack
                         → OpenAI (+ optional GitHub tools)
                         → trading worker delivers reply
```

| Service | Must have | Must not have |
|---|---|---|
| Trading worker | DXtrade creds, `AUTO_EXECUTE`, Telegram token, future snapshot publisher | `GITHUB_TOKEN`, `OPENAI_API_KEY` |
| Companion worker | `OPENAI_API_KEY`, `DATABASE_URL`, `GITHUB_TOKEN` | DXtrade creds, order code |

Pre-existing `solanaRingQueries` / `pg` CI noise has been accepted on recent merges. Do not “fix CI” by touching ring geometry.

---

## Pickup files

- `docs/6th_AUTHORITATIVE_PROJECT_STATE_Tradeify_Crypto_Bot.md` (this file)
- `docs/implementation-decision-log.md`
- `docs/openai-dev-companion-phase2.md`
- `docs/decisions/D-051-live-body-snapshot.md` (approved scope; implementation still pending)
- `docs/decisions/D-052-repo-inspection-tools.md`
- `docs/decisions/D-053-matched-book-rematch.md`
- `docs/decisions/D-054-unread-broker-fail-closed.md`
- `docs/telegram-command-reference.md`
- `src/account/dxtradeSignedNet.js` (`trustedSignedNet`)
- `dev-companion.mjs`
