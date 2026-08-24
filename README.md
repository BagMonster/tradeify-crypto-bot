# Tradeify Crypto Bot

Owner-operated Tradeify Crypto automation for a `$50,000` Instant Funding account with the 95% profit-split add-on.

The active production strategy is the frozen SOL research baseline **`sol-outer-heavy-v1`**. Final live activation is owner-approved under D-045 after a successful real 0.01 SOL DXtrade lifecycle canary.

## Current architecture

- One Node.js Railway worker
- Railway PostgreSQL for durable account, audit, strategy, virtual-lot, and execution state
- Owner-only Telegram control
- Binance `SOLUSDT` for live strategy price references
- DXtrade `SOL/USD` for Tradeify account state, broker reconciliation, and execution
- One net DXtrade SOL position; independent strategy lots are tracked virtually and reconciled to the broker net quantity

## Frozen SOL strategy

- 200-day simple moving average from completed UTC daily closes
- 4.5% bands
- no entries inside ±18% of the MA
- 8 BUY rings below the MA and 8 SHORT rings above it
- active distances from ±22.5% through ±54.0%
- USD sizing starts at `$6` and grows ×`1.8` outward
- maximum two virtual lots per ring
- 0.5-band re-arm excursion
- 4 exit tranches: 10%, 20%, 30%, then the complete remainder
- tranche targets move 25%, 50%, 75%, and 100% from entry toward the current MA
- live production semantics: eligible exits are processed before entries on every live touch
- 0.01 SOL quantity increment
- hard virtual gross-exposure ceiling: approximately `$1,830`
- funded-account daily loss protection: `$1,500`, evaluated from live equity
- separate 0.01 SOL inactivity heartbeat after 25 days without a confirmed bot trade; heartbeat state never mutates ring state

## Live execution controls

Automatic strategy orders are possible only when **both** execution controls are enabled and the worker is in live mode:

```text
Railway: APP_MODE=live
Railway: AUTO_EXECUTE=true
config/strategy.json: execution.autoExecute=true
```

The repository strategy control may be deployed in an ARMED state while Railway `AUTO_EXECUTE=false`; that state cannot place automatic grid orders. `AUTO_EXECUTE=true` is rejected unless `APP_MODE=live`.

Every normal runtime safety gate remains independent: owner pause, safety halt, account lockout, current DXtrade account/equity data, fresh Binance SOLUSDT data, account floors, daily-loss protection, exposure ceiling, and virtual-lot/broker reconciliation. A submitted or acknowledged DXtrade order is never treated as a fill; strategy state advances only after broker fill confirmation.

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

`/levels` shows the complete live 8×8 SOL ladder, frozen USD sizes, estimated SOL quantities, and armed/occupied state. `/rings` gives a compact read-only view of where live SOL sits relative to the current MA and next BUY/SHORT rings.

See the complete operator guide: [Telegram command reference](docs/telegram-command-reference.md).

## Governance and implementation records

- [Implementation decision log](docs/implementation-decision-log.md)
- [D-039 — SOL transition](docs/decisions/D-039-solana-transition.md)
- [D-040 — frozen SOL outer-heavy strategy](docs/decisions/D-040-sol-outer-heavy-v1.md)
- [D-041 — SOL live-touch production semantics](docs/decisions/D-041-sol-live-touch-production-semantics.md)
- [D-042 — owner-approved SOL live lifecycle canary](docs/decisions/D-042-owner-approved-sol-live-canary.md)
- [D-044 — DXtrade SOL position-effect order shape](docs/decisions/D-044-dxtrade-position-effect-order-shape.md)
- [D-045 — final SOL live activation](docs/decisions/D-045-final-sol-live-activation.md)
- [D-046 — Telegram SOL ring observability](docs/decisions/D-046-telegram-ring-observability.md)
- [DXtrade API endpoint reference](docs/dxtrade-api-endpoint-reference.md)
- [Post-Automation Addendum A](docs/post-automation-development-agent-addendum.md)

The post-automation development-agent addendum remains future scope and does not change the trading worker or grant production trading access.
