# D-060 — Multi-asset grid: five instruments, per-instrument geometry, account-level risk

**Status:** LIVE on `main` as of 2026-09-01. Trading worker is running all five enabled books with automatic execution ON.
**Extends:** D-044, D-049, D-054, D-057, D-059.
**Changes strategy behaviour:** yes, materially.

## Decision

Replace the hardcoded SOL grid geometry with one independently configured ring-grid instance per instrument: SOL/USD, DOGE/USD, ZEC/USD, AAVE/USD, and AVAX/USD. The sole live configuration surface is `config/instruments.json`; it carries geometry, cap, verified lot step, order-code prefix, enabled state, and account-risk limits.

`baseUsd` is derived rather than configured:

```
unitGross = sum(level = 1..levels) 2 × growth^(level - 1)
baseUsd = capUsd / unitGross
```

## Geometry

| Instrument | Band | Dead zone | Levels | Cap |
|---|---:|---:|---:|---:|
| SOL/USD | 5.0% | 1 | 10 | $6,300 |
| DOGE/USD | 3.0% | 2 | 12 | $6,300 |
| ZEC/USD | 3.0% | 3 | 8 | $6,300 |
| AAVE/USD | 4.5% | 3 | 12 | $6,300 |
| AVAX/USD | 4.0% | 3 | 12 | $6,300 |

The former SOL compatibility configuration (4.5% / dead-zone 2 / ten levels / $6,600) was re-sized. Byte-identical D-049 sizing is waived.

## Account-level risk supervisor

The account supervisor evaluates all enabled instances in this order:

1. At combined account-day P&L of −$1,250 or worse, flatten every instrument and hold entries until the 22:00 UTC rollover.
2. At −$1,000 or worse, cut only losing instruments at `partialCutFraction` (0.50).
3. At −$300 or worse on one instrument's own day P&L, brake entries only for that instrument; exits continue and other instruments may continue.

Winners receive no partial cut. An unreadable book is not a zero book; the supervisor then brakes every instrument.

## Safety invariants

- D-059 remains in force per instrument: exits and protective reductions are linked `CLOSE` orders by `positionCode`; unread books return `ACCOUNT_DATA_UNAVAILABLE`; full flatten verifies the broker is actually flat.
- One-sided enforcement is per instrument. Long SOL and short AAVE are not cross-instrument hedging.
- State is keyed by `(strategyId, instrument)` in `ring_grid_state`.
- Unknown or malformed configuration fails closed.

## Live notes (2026-09-01)

This decision shipped and the trading worker booted the five-book runtime. Telegram fan-out overflow was fixed (PR #65). Per-instrument status text was fixed (PR #66). Open defects that this decision does not close: heartbeat still OPEN-closes; `placePositionPartialClose` is not broker-canaried; `config/strategy.json` still describes the retired single SOL book.
