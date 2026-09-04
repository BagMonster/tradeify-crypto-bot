# Tradeify Crypto Bot

Owner-operated automation for a **$50,000 Tradeify Crypto Instant Funding** account with the **95% profit-split** add-on.

**Live now:** five independent moving-MA ring grids on DXtrade — SOL, DOGE, INJ, AAVE, AVAX — under **D-060**, with one-sided books and position-linked exits (**D-059**). Automatic execution is **ON** when Railway `APP_MODE=live` and `AUTO_EXECUTE=true`.

Current continuity write-up: [6th authoritative project state](docs/6th_AUTHORITATIVE_PROJECT_STATE_Tradeify_Crypto_Bot.md)  
Chronicle: [Brutal Markets, Tamed By One](docs/chronicle/README.md)

---

## What it does

Each enabled instrument has its own 200-day MA, ring ladder, virtual lots, and order-code prefix. Binance supplies the touch price. DXtrade is the broker.

On every live touch the book looks at **exits first, then entries**. Tranche exits and protective cuts/flattens close existing tickets by `positionCode`. Entries still OPEN. A book may not hold long and short in the same instrument at once.

If a book drifts from the broker, the feed dies, or the day is eating equity, the bot brakes that book, cuts losers, or flattens the account. It does not average harder.

---

## Live books

Configured in `config/instruments.json`. `baseUsd` is derived from the cap.

| Instrument | Feed | Rings/side | From 200d MA | Cap |
|---|---|---:|---|---:|
| SOL/USD | SOLUSDT | 10 | ±10% … ±55% | $10,000 |
| DOGE/USD | DOGEUSDT | 12 | ±9% … ±42% | $10,000 |
| INJ/USD | INJUSDT | 12 | ±20% … ±75% | $10,000 |
| AAVE/USD | AAVEUSDT | 12 | ±18% … ±67.5% | $10,000 |
| AVAX/USD | AVAXUSDT | 12 | ±16% … ±60% | $10,000 |

Shared: 2 lots per ring, 0.5-band re-arm, 0.01 lot step, four-tranche exits back toward the MA.

---

## Account risk ladder

Tradeify day rolls at **22:00 UTC**. Daily loss limit **$1,500**.

| Layer | Trigger | Action |
|---|---|---|
| Brake | −$600 | Stop **that instrument’s** new entries. Exits still run. |
| Cut, tier 1 | −$500 | Close 10% of **losing** books only. |
| Cut, tier 2 | −$750 | Close 20% of losing books. |
| Cut, tier 3 | −$1,000 | Close 50% of losing books. |
| Flatten | −$1,250 | Flatten every instrument. Halt entries until rollover. |

Cuts are account-wide and measured on combined day P&L; the brake is measured on a
single instrument's day P&L, which is why a cut can fire before the brake. A cut
re-fires on every evaluation while the account stays below its tier, so it trims
repeatedly rather than once. Winners are never trimmed.

An unreadable book is not treated as flat. The supervisor then brakes every instrument.

---

## Dual keys

```text
Railway:  APP_MODE=live
Railway:  AUTO_EXECUTE=true
```

Per-instrument `execution.autoExecute` defaults on. Even LIVE, pause, safety halt, lockout, stale data, floors, ladder, exposure cap, and reconciliation can still block an order.

**Fill doctrine:** submitted ≠ filled. State moves only on broker-confirmed fills.

---

## Stack

| Piece | Role |
|---|---|
| Railway trading worker | `index.mjs` — grids, DXtrade, Telegram polling |
| Railway companion worker | BMTB1 `/code`, GitHub read tools |
| PostgreSQL | Account state, `ring_grid_state`, execution ledger, risk day state |
| Telegram | Owner cockpit + confirmed-event alerts |
| Binance | Strategy touches |
| DXtrade | Fills and floors |

---

## Telegram

```text
/status [INSTRUMENT]     /health [INSTRUMENT]
/levels [INSTRUMENT]     /rings [INSTRUMENT]
/dxpreflight             /solcanary
/kill
/resume INSTRUMENT       /confirmresume CODE INSTRUMENT
/reconcile INSTRUMENT    /confirmreconcile CODE INSTRUMENT
/rematch INSTRUMENT      /confirmrematch CODE INSTRUMENT
/flat [INSTRUMENT]       /whoami
/b                       /help
```

`/kill` is global. Resume / reconcile / rematch need the instrument name (`SOL`, `DOGE`, …). Confirm commands have no buttons. Long replies split into `[1/n]` pages.

Operator guide: [Telegram command reference](docs/telegram-command-reference.md)

---

## Heartbeat

After **25 days** with no confirmed bot trade, a 0.01-unit round trip is supposed to keep the Tradeify inactivity clock from closing the account. It is armed on SOL only. **The close leg is still a known defect** — it still goes through the OPEN quantity path. Do not treat heartbeat as a finished design.

---

## Docs map

- [6th project state](docs/6th_AUTHORITATIVE_PROJECT_STATE_Tradeify_Crypto_Bot.md) — what is live
- [Decision log](docs/implementation-decision-log.md)
- [D-063 tiered cut ladder](docs/decisions/D-063-tiered-cut-ladder.md)
- [D-062 swap ZEC for INJ](docs/decisions/D-062-swap-zec-for-inj.md)
- [D-060 multi-asset grid](docs/decisions/D-060-multi-asset-grid.md)
- [D-059 one-sided + close-by-position](docs/decisions/D-059-one-sided-grid-and-position-linked-exits.md)
- [D-049 historical SOL resize / original ladder](docs/decisions/D-049-sol-risk-ladder-and-resize.md)
- [Railway docs watch policy](docs/railway-docs-watch-policy.md)
- [Chronicle](docs/chronicle/README.md)

The August 22 [5th project state](docs/5th_AUTHORITATIVE_PROJECT_STATE_Tradeify_Crypto_Bot.md) is an archive of the BTC-research window. It is not the live bot.

---

## House rules

1. Confirmed fills only.
2. One side per instrument. Do not invent a hedge to “balance” a book.
3. Manual tickets on an enabled instrument desync the virtual notebook — flatten the broker, then `/reconcile INSTRUMENT`, or stop the bot.
4. Unread broker data is unknown, never zero.
5. Docs-only merges must not restart the trading worker.
