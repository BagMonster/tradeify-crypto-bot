# D-062 — Swap ZEC/USD for INJ/USD

**Status:** DRAFT — awaiting owner approval.
**Extends:** D-060.
**Changes strategy behaviour:** yes — which fifth book is live, not how orders are placed.

## Decision

Remove ZEC/USD from the enabled five-book set and enable INJ/USD on INJ's own fitted geometry. Leave the ZEC profile registered so historical state and tests that name ZEC/USD still resolve. Do not disable-and-keep a ZEC config row; the live file states one five-book set: SOL, DOGE, INJ, AAVE, AVAX.

## Why ZEC is out

Live (2026-09-02): ZEC ~$811.26 versus a 200-day MA of $432.10, **+87.75%**. Active span is ±12.0% to ±33.0%, so price is above every SHORT ring and no entry is possible.

Across 1,129 measured days ZEC sat outside its rings **23.6% of the time — the worst of nine candidates**. Its fitted band is also the narrowest (±12–33%), which is why it falls out so readily.

No moving-average length repairs the live print:

| MA days | Approx MA | Distance vs $811 | Inside ±33%? |
|--------:|----------:|-----------------:|:-------------|
| 200 | $432 | +87.8% | no |
| 150 | (shorter) | still outside | no |
| 10 | $534 | +37.5% | no |

Shorter anchors also destroy the research result: 200 days earned $13,289; 150 earned $4,475; 50 **lost** $79, because a short average chases a rally and plants SHORT rings into it.

ZEC held **no open positions** at swap time. The book was above every ring, so nothing is orphaned.

## Why INJ

INJ is out of range **12.0%** of measured days, about half of ZEC's dead time, and earned $4,496 standalone on its own fitted geometry.

## INJ geometry (not ZEC's)

| | ZEC (removed) | INJ (added) |
|---|---|---|
| bandPct | 3.0% | **5.0%** |
| deadZoneBands | 3 | 3 |
| activeLevelsPerSide | 8 | **12** |
| ring span | ±12.0% .. ±33.0% | **±20.0% .. ±75.0%** |
| baseUsd (derived) | $63.95 | **$12.23** |
| outermost ring | $1,092.63 | **$1,058.16** |
| capUsd | $6,300 | $6,300 |

`baseUsd` is derived as `capUsd / unitGross`. Do not store it in config. Growth 1.5 over 12 levels yields $12.23 and gross **$6,300.00**.

Lot check: 0.01 INJ at $5.061 is $0.0506, under the $12.23 innermost ring.

## Telegram

The `/b` home panel and fallback book list use INJ in ZEC's slot. Live `/b` still reads `service.instruments` after deploy, so the panel follows config even if the fallback list were stale. Resume / reconcile / rematch on the INJ screen send `INJ/USD`.

## Deploy note

INJ will begin entering as soon as this deploys, unlike dormant ZEC. Deploy at a chosen moment, then `/status` must show INJ with ±20%–75% and no ZEC book.

## Out of scope

No geometry change to SOL, DOGE, AAVE, or AVAX. No `accountRisk` change. ZEC remains in `instrumentProfile.js`. Heartbeat close, partial-close canary, and the stale allocator comment are untouched.
