# 6th authoritative project state — Tradeify Crypto Bot

**Status:** Current continuity source  
**As of:** 2026-09-01 evening PDT (`main` tip includes `ab000230`)  
**Supersedes:** `docs/5th_AUTHORITATIVE_PROJECT_STATE_Tradeify_Crypto_Bot.md` (August 22 BTC-research handoff). The 5th state is historical. Do not act on its “BTC grid candidate / AUTO_EXECUTE false / box-fade” framing.

---

## What is live right now

Owner-operated Railway trading worker on a **$50,000 Tradeify Crypto Instant Funding** account (95% split). Automatic execution is **ON** (`APP_MODE=live`, Railway `AUTO_EXECUTE=true`).

The worker runs **five independent ring grids** from `config/instruments.json`, not the old single SOL module constants and not the August 22 BTC research ladder.

| Instrument | Strategy id | Feed | Rings/side | Distance from 200d MA | Cap |
|---|---|---|---:|---|---:|
| SOL/USD | `sol-ring-grid-v1` | SOLUSDT | 10 | ±10.0% … ±55.0% | $6,300 |
| DOGE/USD | `doge-ring-grid-v1` | DOGEUSDT | 12 | ±9.0% … ±42.0% | $6,300 |
| ZEC/USD | `zec-ring-grid-v1` | ZECUSDT | 8 | ±12.0% … ±33.0% | $6,300 |
| AAVE/USD | `aave-ring-grid-v1` | AAVEUSDT | 12 | ±18.0% … ±67.5% | $6,300 |
| AVAX/USD | `avax-ring-grid-v1` | AVAXUSDT | 12 | ±16.0% … ±60.0% | $6,300 |

- Anchor: 200-day SMA of completed UTC daily closes (Binance).
- Broker: DXtrade on Tradeify, one book per instrument.
- Lot step: 0.01 on every enabled book.
- Per ring: 2 virtual lots; 0.5-band re-arm.
- Exits: four tranches back toward the live MA.
- Live-touch: **exits before entries** (D-041).
- One direction at a time **per instrument** (D-059). Long SOL and short AAVE at the same time is allowed. Long and short SOL at the same time is not.
- Entries are `positionEffect: OPEN`. Exits and protective reductions close by `positionCode` (D-059 / PR #61).
- Unread broker book is unknown, never flat (D-054).

`baseUsd` is derived from the cap, not hardcoded. SOL is no longer the D-049 $28.68 / $6,600 shape.

---

## Account risk (D-060 supervisor)

Evaluated on combined account-day P&L. Day rolls **22:00 UTC**. Daily loss limit **$1,500**.

| Layer | Trigger | Scope |
|---|---|---|
| Entry brake | −$300 | That instrument only. Exits continue. Other books may still enter. |
| Partial cut | −$1,000 | 50% of **losing** books only. Winners are not trimmed. |
| Flatten | −$1,250 | Every instrument. Entries blocked until rollover. |

If any book cannot be read, the supervisor fail-closes and brakes **all** books. Unread is not treated as $0.

---

## Two Railway services

| Service | Job |
|---|---|
| Trading worker (`npm start` / `index.mjs`) | Grids, DXtrade, Telegram polling, risk supervisor |
| Companion worker | `/code` BMTB1, GitHub read tools, chronicle control |

Watch paths on the trading service: `src/**`, `index.mjs`, `package.json`, `package-lock.json`, `config/**`, `Procfile`. **Do not watch `docs/**`.** A docs-only merge must not restart a live grid.

---

## Telegram (owner only)

Reads default to **all five books** and are split at Telegram’s 4096-character cap (`[1/n]` pages). Pass an instrument to see one book: `/status SOL`, `/levels DOGE`.

| Command | Effect |
|---|---|
| `/status` `[INSTRUMENT]` | Account risk header, then each book |
| `/health` `[INSTRUMENT]` | Worker, Postgres, MA, execution |
| `/levels` `[INSTRUMENT]` | Ring ladder |
| `/rings` `[INSTRUMENT]` | Price vs MA and zone |
| `/kill` | Pause **every** instrument |
| `/resume INSTRUMENT` then `/confirmresume CODE INSTRUMENT` | Lift pause for one book |
| `/reconcile INSTRUMENT` then `/confirmreconcile CODE INSTRUMENT` | Flatten **virtual** lots when DXtrade is already flat. No broker order. Pause stays. |
| `/rematch INSTRUMENT` then `/confirmrematch CODE INSTRUMENT` | Keep virtual lots when nets already agree. Do not use this to clear a leftover lot after a manual close. |
| `/flat` `[INSTRUMENT]` | Manual flatten instructions |
| `/b` | Button panel. Confirm* commands have no buttons. |

Full operator text: `docs/telegram-command-reference.md`.

---

## Persistence

Live rings live in `ring_grid_state` keyed by `(strategyId, instrument)` — e.g. `sol-ring-grid-v1` / `SOL/USD`.

The pre-D-060 row remains in `solana_grid_state` under `sol-outer-heavy-v1`. `/status` after PR #66 reads the live ring table. Do not treat the old SOL notebook as the live book.

---

## Known remaining defects (do not pretend these are fixed)

1. **Heartbeat close still OPENs.** `solanaHeartbeat.js` still calls `adapter.place({ actionType: "HEARTBEAT_CLOSE" })`. After 25 quiet days it can open a 0.01 long then a 0.01 short instead of closing. Armed on SOL only.
2. **`placePositionPartialClose` is not broker-canaried.** Most tranche exits use it.
3. **Virtual lot ↔ `positionCode` is not stored at entry.** Exits resolve live same-side tickets at exit time.
4. **`config/strategy.json` still describes the old single SOL book.** Runtime truth is `config/instruments.json`.

---

## What is not current

- Box-fade, BTC $250/$550/$1,250 research ladder, “both locks false.”
- Single-instrument `sol-outer-heavy-v1` as the live strategy id.
- D-049 $6,600 / $28.68 SOL geometry as the live SOL book.
- Treating D-059 or D-060 as un-deployed drafts. Both are on `main` and running.

---

## Authority order

1. Live `main` code and `config/instruments.json`.
2. This document and `docs/implementation-decision-log.md` (read `main`).
3. Individual `docs/decisions/D-0xx-*.md` files.
4. `docs/5th_AUTHORITATIVE_PROJECT_STATE_Tradeify_Crypto_Bot.md` — archive only.
