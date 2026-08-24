# D-041 — SOL live-touch production semantics

**Status:** APPROVED by owner on 2026-08-23.

## Decision

The frozen research strategy `sol-outer-heavy-v1` is translated from historical 5-minute OHLC touch evaluation into production using actual live Binance `SOLUSDT` trade touches.

For each incoming live market update:

1. update moving-ring re-arm observations;
2. evaluate and process all eligible exits first;
3. only after eligible exits are processed, evaluate eligible entries;
4. an entry or exit advances persistent strategy state only after a confirmed broker fill when automatic execution is enabled;
5. while execution is locked, the same production engine may emit shadow intents but must not pretend they filled.

The 200-day simple moving average remains based only on completed UTC daily closes. Ring levels and tranche targets use the current completed-day MA.

## Frozen strategy identity

- Strategy ID: `sol-outer-heavy-v1`
- Instrument: DXtrade `SOL/USD`
- Market/reference feed: Binance `SOLUSDT`
- 8 BUY rings and 8 SHORT rings
- 4.5% band width
- dead zone inside ±18%
- active distances: ±22.5%, ±27.0%, ±31.5%, ±36.0%, ±40.5%, ±45.0%, ±49.5%, ±54.0%
- USD notional sizing: $6 × 1.8^(level-1)
- entry quantity: floor(USD size / execution price) to 0.01 SOL
- maximum 2 virtual lots per ring
- re-arm distance: 0.5 band from the current moving ring
- 4 exit tranches: 10%, 20%, 30%, then all remaining units
- TP targets: 25%, 50%, 75%, 100% interpolation from entry toward current MA
- round-trip cost floor/ceiling: 0.18%
- modeled commission: 0.04% per side
- modeled slippage: 0.05% per fill
- hard gross strategy exposure ceiling: $1,830
- account daily loss protection: $1,500 continuous equity check
- 30-day inactivity protection requires a separate 0.01 SOL round trip that never mutates ring state

## Netting translation

DXtrade remains a netting account with at most one signed broker `SOL/USD` position. Independent research lots are represented as durable **virtual lots** inside strategy state. The expected broker quantity is the signed sum of all remaining virtual-lot quantities. BUY/SHORT ring identities and their tranche schedules remain independent in strategy state even when the broker position is netted.

Any material mismatch between the confirmed DXtrade net SOL quantity and the signed virtual-lot total is a fail-closed reconciliation condition requiring owner review before new entries.

## Activation boundary

This decision authorizes implementation of the production semantics. It does **not** itself authorize automatic live grid trading.

Both execution settings remain false during implementation:

- Railway `AUTO_EXECUTE=false`
- `config/strategy.json` → `execution.autoExecute=false`

The separately approved D-038 minimum-size live lifecycle canary and final owner activation checkpoint remain distinct steps.