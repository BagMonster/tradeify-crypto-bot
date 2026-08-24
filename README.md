# Tradeify Crypto Bot

Owner-operated Tradeify Crypto automation for a `$50,000` Instant Funding account with the 95% profit-split add-on.

The active production strategy is the frozen SOL research baseline **`sol-outer-heavy-v1`**. The worker is still deployed behind both automatic-execution locks until the separately approved live activation checkpoint.

## Current architecture

- One Node.js Railway worker
- Railway PostgreSQL for durable account, audit, strategy, virtual-lot, and execution state
- Owner-only Telegram control
- Binance `SOLUSDT` for external/live strategy price references
- DXtrade `SOL/USD` for Tradeify account state, broker reconciliation, and eventual execution
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
- separate 0.01 SOL inactivity heartbeat after 25 days without a confirmed trade; heartbeat state never mutates ring state

## Current execution state

Automatic execution remains OFF. Both settings are required to remain false during the locked deployment:

```text
Railway: AUTO_EXECUTE=false
config/strategy.json: execution.autoExecute=false
```

The production-shaped SOL order, confirmation, virtual-lot, reconciliation, and protective-flatten paths exist behind those locks. A submitted or acknowledged DXtrade order is never treated as a fill; strategy state advances only after broker fill confirmation.

A persistent mismatch between the signed virtual SOL total and the DXtrade net `SOL/USD` position blocks new strategy actions and creates a safety halt.

## Railway start command

```text
npm start
```

## Telegram commands

```text
/status
/health
/dxpreflight
/kill
/resume
/confirmresume CODE
/flat
/whoami
/help
```

See the complete operator guide: [Telegram command reference](docs/telegram-command-reference.md).

## Governance and implementation records

- [Implementation decision log](docs/implementation-decision-log.md)
- [D-039 — SOL transition](docs/decisions/D-039-solana-transition.md)
- [D-041 — SOL live-touch production semantics](docs/decisions/D-041-sol-live-touch-production-semantics.md)
- [DXtrade API endpoint reference](docs/dxtrade-api-endpoint-reference.md)
- [Post-Automation Addendum A](docs/post-automation-development-agent-addendum.md)

The post-automation development-agent addendum remains future scope and does not change the trading worker or grant production trading access.
