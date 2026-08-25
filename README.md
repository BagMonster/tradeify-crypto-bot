# Tradeify Crypto Bot

A SOL grid that actually respects the account.

Owner-operated automation for a **$50,000 Tradeify Crypto Instant Funding** account with the **95% profit-split** add-on. Not a vibe-trading Discord signal channel. Not a “trust me bro” DCA bot. A measured outer-heavy ring grid on Solana with hard floors, confirmed fills only, and a daily risk ladder that exists to keep the funded account alive.

**Live strategy:** `sol-outer-heavy-v1` under **D-049**  
**Activation:** owner-approved under **D-045**  
**Code merge:** PR #37 (2026-08-25)

---

## What this thing does

It watches live Binance `SOLUSDT` touches against a moving 200-day average, lays out concentric BUY/SHORT rings away from that average, and takes small, sized positions when price walks into the outer structure. Profits are harvested in tranches back toward the MA. The broker side is DXtrade `SOL/USD` on Tradeify — one net position, virtual lots on our side, reconcile or fail closed.

If the book drifts, the feed dies, or equity starts eating the day, the bot does not “average harder.” It brakes, cuts, or flattens.

---

## Stack

| Piece | Role |
|---|---|
| Railway Node worker | One process. One job. |
| PostgreSQL | Account state, virtual lots, execution ledger, risk-ladder day state, Telegram identities |
| Telegram | Owner-only cockpit + push alerts |
| Binance `SOLUSDT` | Strategy price / touches |
| DXtrade `SOL/USD` | Real money, real fills, real floors |

Independent long/short lots are tracked **virtually**, then netted to the single broker SOL position. Persistent mismatch → safety halt. No mystery inventory.

---

## The grid (D-049)

Think Saturn rings, but for SOL volatility:

- **Anchor:** 200-day SMA of completed UTC daily closes
- **Band width:** 4.5%
- **Dead zone:** no entries inside **±13.5%** of the MA
- **Active rings:** **10 BUY** below + **10 SHORT** above
- **Distances:** ±13.5% → ±54%
- **Size curve:** starts at **$28.68**, grows **×1.5** as rings move out
- **Per ring:** up to **2** virtual lots; **0.5-band** re-arm after price walks away
- **Exits:** four tranches — 10% / 20% / 30% / remainder — targets slide 25% / 50% / 75% / 100% of the way from entry back to the live MA
- **Lot step:** 0.01 SOL
- **Gross exposure ceiling:** **$6,600** virtual
- **Live rule:** on every touch, **exits before entries**

Outer rings carry the edge. Inner noise is mostly ignored on purpose.

D-049 only changed sizing, geometry, ceiling, and heartbeat compliance versus the original D-040 freeze. The live-touch model, activation gates, and account floors did not get rewritten for fun.

---

## Daily risk ladder (also D-049)

Funded accounts die from “one bad day,” not from a missing meme.

Measured against **live equity (incl. unrealized)** vs the prior account day’s **closed** balance. Tradeify day rolls at **22:00 UTC**.

| Layer | Trigger | Action |
|---|---|---|
| Brake | −$300 | New entries blocked; exits still run |
| Partial cut | −$1,000 | Close **50%** of every open virtual lot |
| Flatten | −$1,250 | Flat everything; halt until next day rollover |

Account daily-loss limit remains **$1,500**. The flatten sits inside that wall on purpose. Protective cut/flatten **bypass** the normal 0.05% slippage cap so emergency exits are not polite about volatility.

Never run the large D-049 size with the ladder turned off.

---

## Dual keys to the ignition

Automatic grid orders need **both**:

```text
Railway:     APP_MODE=live
Railway:     AUTO_EXECUTE=true
strategy.json: execution.autoExecute=true
```

`AUTO_EXECUTE=true` without `APP_MODE=live` is rejected. Repo ARMED + Railway off = no automatic orders. Even fully LIVE, independent gates still apply: pause, safety halt, lockout, stale feed/account data, floors, ladder, exposure ceiling, reconciliation.

**Fill doctrine:** submitted ≠ filled. Strategy state advances only on **broker-confirmed** fills.

---

## Canary receipts

2026-08-23 V2 lifecycle canary (historical proof, blocked while the grid is LIVE):

- 0.01 SOL BUY @ **$93.83** confirmed
- ≥25s hold
- exact linked position closed @ **$93.88**
- account flat, no leftover order

---

## Run it

```text
npm start
```

---

## Telegram cockpit

```text
/status          /health
/levels          /rings
/dxpreflight     /solcanary
/kill            /resume
/confirmresume CODE
/flat            /whoami
/help
```

- **`/levels`** — full 10×10 ladder, USD sizes, estimated qty, armed/occupied
- **`/rings`** — “where is price right now vs the rings?”

Owner-only. Unauthorized users get the digital cold shoulder.

### Push alerts (D-047 + D-049)

You hear about reality, not hopes:

- confirmed entries / tranche exits / full lot closes
- inactivity heartbeat round trips
- reconciliation mismatches, lockouts, safety halts
- protective flatten
- D-049 partial cut and full flatten when those layers fire

Alerts are **after** broker confirmation and durable state where required. Telegram failure cannot undo a fill, retry an order, or delay a protective action.

Full operator guide: [Telegram command reference](docs/telegram-command-reference.md)  
Notification notes: [Telegram live notifications](docs/telegram-live-notifications.md)

---

## Heartbeat

Tradeify inactivity closes accounts. After **25 days** with no confirmed bot trade, a separate **0.01 SOL** round trip runs (25s hold). It does **not** touch ring state, MA, or the ladder. It only keeps the account from going idle-dead.

---

## Governance (the boring binders that keep the fun legal)

- [Implementation decision log](docs/implementation-decision-log.md)
- [D-039 — SOL transition](docs/decisions/D-039-solana-transition.md)
- [D-040 — original outer-heavy freeze](docs/decisions/D-040-sol-outer-heavy-v1.md)
- [D-041 — live-touch semantics](docs/decisions/D-041-sol-live-touch-production-semantics.md)
- [D-042 — live canary approval](docs/decisions/D-042-owner-approved-sol-live-canary.md)
- [D-044 — DXtrade position-effect shape](docs/decisions/D-044-dxtrade-position-effect-order-shape.md)
- [D-045 — final live activation](docs/decisions/D-045-final-sol-live-activation.md)
- [D-046 — `/rings` + `/levels`](docs/decisions/D-046-telegram-ring-observability.md)
- [D-047 — live trade notifications](docs/decisions/D-047-telegram-live-notifications.md)
- [D-048 — OpenAI dev companion](docs/decisions/D-048-simplified-openai-development-companion.md)
- [D-049 — resize + daily risk ladder](docs/decisions/D-049-sol-risk-ladder-and-resize.md)
- [DXtrade API endpoint reference](docs/dxtrade-api-endpoint-reference.md)
- [Post-Automation Addendum A](docs/post-automation-development-agent-addendum.md)

---

## House rules

1. Facts over feelings. Confirmed fills only.
2. The ladder is not optional at D-049 size.
3. Manual trades in the same account will confuse reconciliation — don’t freestyle unless you mean to stop the bot.
4. If equity and virtual inventory disagree, the bot stops being clever and starts being safe.

Built to farm SOL mean-reversion the boring, funded-account-compatible way — with just enough swagger to remember why we’re here.
