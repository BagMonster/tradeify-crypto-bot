# D-040 — Frozen SOL outer-heavy grid baseline

**Strategy ID:** `sol-outer-heavy-v1`  
**Status:** OWNER-APPROVED RESEARCH BASELINE, frozen 2026-08-23; implementation semantics resolved by the owner and D-041; not an automatic-execution authorization.

## Governing replacement

This decision replaces all remaining three-level BTC grid assumptions for the SOL strategy. No `BUY1-BUY3` / `SELL1-SELL3` counter model, confirmed-fill reference reset, or maximum-consecutive-same-side-fill rule carries into SOL.

## Reference

- 200-day simple moving average of completed UTC daily SOL closes.
- The MA updates when a new completed daily close enters the 200-day window.
- All ring distances and exit targets use the current MA.
- A confirmed fill never becomes the reference.

## Ring geometry and sizing

- Band width: `4.5%` of current MA.
- Dead zone: no entry rings inside `±18%`; first four bands are skipped.
- Eight BUY rings below MA and eight SHORT rings above MA.

| Level | BUY distance | SHORT distance | USD notional |
|---|---:|---:|---:|
| 1 | -22.5% | +22.5% | `$6.00` |
| 2 | -27.0% | +27.0% | `$10.80` |
| 3 | -31.5% | +31.5% | `$19.44` |
| 4 | -36.0% | +36.0% | `$34.992` |
| 5 | -40.5% | +40.5% | `$62.9856` |
| 6 | -45.0% | +45.0% | `$113.37408` |
| 7 | -49.5% | +49.5% | `$204.073344` |
| 8 | -54.0% | +54.0% | `$367.3320192` |

Sizing formula is `$6 × 1.8^(level-1)`. At a confirmed entry, SOL quantity is floored from the USD target to the `0.01 SOL` increment.

## Ring capacity and re-arm

- Maximum two virtual lots per ring.
- Every new fill sets that ring `armed=false`.
- A second fill may occur while the first lot remains open only after the ring re-arms.
- Re-arm distance is `currentMA × 0.045 × 0.5` measured from the current moving ring.
- Either direction away from the ring counts.
- When all remaining units for a ring are closed, that ring becomes armed immediately.
- There is no same-side consecutive-fill counter and no whole-ladder reset after the outer ring.

## Four-tranche exits

For tranche `t ∈ {1,2,3,4}`:

```text
target(t) = entry + (currentMA - entry) × (t / 4)
```

This places targets 25%, 50%, 75%, and 100% of the way from entry toward the current MA.

No tranche target may realize a modeled round-trip loss:

```text
long target  = max(target, entry × (1 + 0.0018))
short target = min(target, entry × (1 - 0.0018))
```

The `0.0018` floor represents two sides of `0.04%` commission plus `0.05%` slippage.

Tranche quantity rules:

1. intended weights are 1/10, 2/10, 3/10, 4/10 of original quantity;
2. non-final tranches floor to `0.01 SOL` and never exceed the remaining quantity;
3. a non-final tranche that floors below `0.01 SOL` is skipped and its done counter advances;
4. tranche four closes the entire remainder.

## Research-bar ordering and production translation

The verified `ringgrid3.mjs` research engine processes all touched exits before entries on each five-minute bar. It does not reconstruct an intrabar path.

D-041 translates this to production as **actual live Binance `SOLUSDT` touches with eligible exits processed before entries on each live update**.

## Netting translation

The research engine retains independent long and short tagged lots. The Tradeify/DXtrade account remains netted and may expose only one signed physical `SOL/USD` position.

Production therefore keeps the tagged research lots as durable **virtual lots** while the broker position is the signed aggregate of their remaining quantities. The bot must continuously reconcile:

```text
expected DXtrade net SOL = sum(signed remaining virtual SOL quantities)
```

A persistent mismatch blocks new strategy actions and requires owner reconciliation. This preserves ring/tranche accounting without pretending that the broker is in hedge mode.

## Risk and account limits

- Hard virtual gross-exposure ceiling: `$1,830`.
- Tradeify daily-loss limit: `$1,500`, checked from live equity including unrealized P&L.
- Existing maximum-loss/payout floor, owner pause, safety halt, account lockout, current account data, feed freshness, and confirmed-fill accounting remain applicable.
- Minimum project hold: 25 seconds.
- One net broker instrument position; no hedge-mode dependency.

## Inactivity heartbeat

- Tradeify inactivity deadline: 30 days without a trade.
- Production safety trigger: after 25 days without a confirmed bot trade.
- Heartbeat quantity: `0.01 SOL`.
- Heartbeat is a separate round trip and must never mutate a ring, virtual lot, tranche counter, MA, or ring armed state.
- The same 25-second project minimum hold applies to the heartbeat round trip.

## Data identity

- Strategy market/reference source: Binance `SOLUSDT`.
- Broker/account instrument: DXtrade `SOL/USD`.
- Research evidence: completed five-minute OHLCV.
- Live production trigger rule: actual Binance live trade touch under D-041.
- 200-day MA: completed UTC daily closes only.

## Activation boundary

D-040 freezes the strategy but does not turn on automatic execution. D-041 authorizes the production live-touch translation. The D-038 minimum-size live lifecycle canary remains a separate owner-approved step, followed by a separate final automatic-execution approval.

Until those checkpoints are completed, `AUTO_EXECUTE=false` and `execution.autoExecute=false` remain required.
