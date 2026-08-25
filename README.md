# Tradeify Crypto Bot

Owner-operated Tradeify Crypto automation for a `$50,000` Instant Funding account with the 95% profit-split add-on.

The active production strategy is **`sol-outer-heavy-v1`** under **D-049** sizing and the three-layer daily risk ladder (merged to `main` via PR #37 on 2026-08-25). Final live activation remains owner-approved under D-045.

## Current architecture

- One Node.js Railway worker
- Railway PostgreSQL for durable account, audit, strategy, virtual-lot, execution, risk-ladder, and Telegram-notification state
- Owner-only Telegram control and automatic live notifications
- Binance `SOLUSDT` for live strategy price references
- DXtrade `SOL/USD` for Tradeify account state, broker reconciliation, and execution
- One net DXtrade SOL position; independent strategy lots are tracked virtually and reconciled to the broker net quantity

## Production SOL strategy (D-049)

- 200-day simple moving average from completed UTC daily closes
- 4.5% bands
- no entries inside ±13.5% of the MA (`deadZoneBands: 2`)
- 10 BUY rings below the MA and 10 SHORT rings above it
- active distances from ±13.5% through ±54.0%
- USD sizing starts at `$28.68` and grows ×`1.5` outward
- maximum two virtual lots per ring
- 0.5-band re-arm excursion
- 4 exit tranches: 10%, 20%, 30%, then the complete remainder
- tranche targets move 25%, 50%, 75%, and 100% from entry toward the current MA
- live production semantics: eligible exits are processed before entries on every live touch
- 0.01 SOL quantity increment
- hard virtual gross-exposure ceiling: `$6,600`
- funded-account daily loss protection: `$1,500`, evaluated from live equity
- three-layer daily risk ladder (D-049):
  - entry brake at −$300 (block new entries; exits continue)
  - 50% partial cut at −$1,000
  - full flatten + halt-for-day at −$1,250
  - protective cut/flatten bypass the 0.05% slippage cap
- separate 0.01 SOL inactivity heartbeat after 25 days without a confirmed bot trade; heartbeat state never mutates ring state

D-049 supersedes only the sizing, ring geometry, exposure ceiling, and heartbeat parameters from D-040. Live-touch semantics, activation gates, and account floors remain as previously approved.

## Live execution controls

Automatic strategy orders are possible only when **both** execution controls are enabled and the worker is in live mode:

```text
Railway: APP_MODE=live
Railway: AUTO_EXECUTE=true
config/strategy.json: execution.autoExecute=true
```

The repository strategy control may be deployed in an ARMED state while Railway `AUTO_EXECUTE=false`; that state cannot place automatic grid orders. `AUTO_EXECUTE=true` is rejected unless `APP_MODE=live`.

Every normal runtime safety gate remains independent: owner pause, safety halt, account lockout, current DXtrade account/equity data, fresh Binance SOLUSDT data, account floors, daily-loss protection, D-049 risk ladder, exposure ceiling, and virtual-lot/broker reconciliation. A submitted or acknowledged DXtrade order is never treated as a fill; strategy state advances only after broker fill confirmation.

A persistent mismatch between the signed virtual SOL total and the DXtrade net `SOL/USD` position blocks new strategy actions and creates a safety halt.

## Verified live lifecycle canary

On 2026-08-23 the owner-triggered V2 canary completed successfully:

- 0.01 SOL BUY confirmed at `$93.83`
- project minimum hold satisfied
- exact linked DXtrade position closed at `$93.88`
- broker account confirmed flat afterward
- no pending order remained

The canary is historical verification and is blocked while automatic grid execution is ON.

## Railway start command

```text
npm start
```

## Telegram commands

```text
/status
/health
/levels
/rings
/dxpreflight
/solcanary
/kill
/resume
/confirmresume CODE
/flat
/whoami
/help
```

`/levels` shows the complete live 10×10 SOL ladder, USD sizes, estimated SOL quantities, and armed/occupied state. `/rings` gives a compact read-only view of where live SOL sits relative to the current MA and next BUY/SHORT rings.

## Automatic Telegram notifications

D-047 adds owner-only push notifications for authoritative production outcomes:

- confirmed grid entries;
- each confirmed tranche exit;
- fully closed virtual lots;
- completed inactivity-heartbeat round trips;
- reconciliation mismatches and runtime safety halts;
- Tradeify account lockouts;
- confirmed protective flatten events;
- D-049 partial-cut and full-flatten protective actions when those paths fire.

Trade notifications are emitted only after broker confirmation and durable strategy-state advancement where applicable. PostgreSQL stores a durable notification identity before Telegram delivery so retries and restarts do not automatically duplicate the same success message. Telegram delivery is observational only: a Telegram failure cannot roll back a fill, retry an order, mutate ring state, delay a protective action, or weaken a safety gate.

See the complete operator guide: [Telegram command reference](docs/telegram-command-reference.md).  
See the notification behavior summary: [Telegram live notifications](docs/telegram-live-notifications.md).

## Governance and implementation records

- [Implementation decision log](docs/implementation-decision-log.md)
- [D-039 — SOL transition](docs/decisions/D-039-solana-transition.md)
- [D-040 — frozen SOL outer-heavy strategy](docs/decisions/D-040-sol-outer-heavy-v1.md)
- [D-041 — SOL live-touch production semantics](docs/decisions/D-041-sol-live-touch-production-semantics.md)
- [D-042 — owner-approved SOL live lifecycle canary](docs/decisions/D-042-owner-approved-sol-live-canary.md)
- [D-044 — DXtrade SOL position-effect order shape](docs/decisions/D-044-dxtrade-position-effect-order-shape.md)
- [D-045 — final SOL live activation](docs/decisions/D-045-final-sol-live-activation.md)
- [D-046 — Telegram SOL ring observability](docs/decisions/D-046-telegram-ring-observability.md)
- [D-047 — broker-confirmed live trade and safety notifications](docs/decisions/D-047-telegram-live-notifications.md)
- [D-048 — simplified OpenAI development companion](docs/decisions/D-048-simplified-openai-development-companion.md)
- [D-049 — SOL resize + daily risk ladder](docs/decisions/D-049-sol-risk-ladder-and-resize.md)
- [DXtrade API endpoint reference](docs/dxtrade-api-endpoint-reference.md)
- [Post-Automation Addendum A](docs/post-automation-development-agent-addendum.md)

The post-automation development-agent addendum remains future scope for broader agent capabilities beyond the Phase 1 companion already recorded in D-048.
