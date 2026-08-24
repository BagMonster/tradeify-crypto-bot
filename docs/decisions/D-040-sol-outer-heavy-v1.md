# D-040 — Frozen SOL outer-heavy grid baseline

**Strategy ID:** `sol-outer-heavy-v1`  
**Status:** OWNER-APPROVED RESEARCH BASELINE, frozen 2026-08-23; NOT LIVE; implementation target only.

## Governing replacement

This decision replaces all remaining three-level BTC grid assumptions for the planned SOL strategy. No `BUY1-BUY3` / `SELL1-SELL3` counter model, confirmed-fill reference reset, or maximum-consecutive-same-side-fill rule may be carried into the SOL strategy.

## Reference

- Reference is the 200-day simple moving average of completed daily SOL closes.
- The reference updates when a new completed daily close enters the 200-day window.
- All ring distances are measured from the current moving average.
- A confirmed fill never becomes the reference.

## Ring geometry

- Band width: `4.5%` of the current 200-day MA.
- Dead zone: no active entry rings inside `±18%` of the MA; the first four 4.5% bands are skipped.
- Eight BUY rings below the MA and eight SHORT rings above the MA.

| Level | BUY distance | SHORT distance | Exact USD formula |
|---|---:|---:|---:|
| 1 | -22.5% | +22.5% | `6 * 1.8^0` |
| 2 | -27.0% | +27.0% | `6 * 1.8^1` |
| 3 | -31.5% | +31.5% | `6 * 1.8^2` |
| 4 | -36.0% | +36.0% | `6 * 1.8^3` |
| 5 | -40.5% | +40.5% | `6 * 1.8^4` |
| 6 | -45.0% | +45.0% | `6 * 1.8^5` |
| 7 | -49.5% | +49.5% | `6 * 1.8^6` |
| 8 | -54.0% | +54.0% | `6 * 1.8^7` |

Approximate USD notionals supplied with the freeze are `$6`, `$10.80`, `$19.44`, `$34.99`, `$62.99`, `$113.37`, `$204.07`, `$367.33` per side.

At fill time, the strategy computes SOL quantity from the USD notional and fill price, flooring to the `0.01 SOL` lot increment. The exact broker minimum SOL order quantity remains a live-execution discovery item unless separately confirmed.

## Entry behavior

- Entry evaluation uses completed/observed 5-minute SOL bars and high/low ring touches.
- An entry is eligible when price trades through an armed ring level and that ring has capacity.
- The outermost ring has no special reset or cycle behavior.

## Ring capacity and re-arm — owner-supplied rules

- Each ring may hold up to two positions at the same time.
- The owner also specified that a ring is locked while it holds any open position.
- After a position is fully closed, the ring becomes free only after price has moved at least `0.5` band away from the ring level and then returned.
- There is no maximum-consecutive-same-side-fill counter.

The two-position capacity statement and the statement that a ring is locked while any position is open are not yet executable together without an additional rule defining how/when the second simultaneous position can be opened. That point must be resolved before the production strategy module is considered complete.

## Exits

Every entry position is split conceptually into four exit tranches:

- weights: `1/10`, `2/10`, `3/10`, `4/10` of original lot size;
- targets move toward the current 200-day MA;
- final tranche clears any quantity remainder;
- no tranche may execute if its realized result after modeled/actual costs would be a loss;
- cost floor supplied by owner: `0.04%` commission plus `0.05%` slippage on each side.

The freeze does not yet state the exact target-price formula or target distance for tranche 1, 2, 3, and 4. That geometry is required before the exit engine can be implemented without inventing behavior.

Because the entry quantity is floored to `0.01 SOL`, a separate executable tranche-rounding rule is also required. In particular, an original position below `0.10 SOL` cannot preserve a non-zero 10% first tranche at a `0.01 SOL` increment. The production strategy must define how tranche quantities round and what happens when one or more weighted tranches would round below the broker lot increment.

## BUY/SHORT independence — production compatibility blocker

The research definition states that BUY and SHORT sides are fully independent and may both have open positions simultaneously.

The currently verified Tradeify/DXtrade account model is netting / one signed instrument position. Under netting, simultaneous independent long and short broker positions in the same `SOL/USD` instrument cannot be represented exactly: opposing executions offset the broker's single net position. Therefore this research behavior cannot be mapped truthfully to the current execution architecture without a separately approved resolution (for example, a verified hedge-mode account, or a strategy change that removes simultaneous opposite-side inventory).

Do not emulate two independent opposite-side live inventories inside the bot while the broker is netted; that would make internal ring state diverge from actual broker exposure.

## Risk limits

- Overall open-notional ceiling: approximately `$1,830` as supplied by the owner. The runtime must treat the configured ceiling as a hard gate before adding exposure.
- Tradeify daily-loss protection remains `$1,500`, checked using live equity including unrealized P&L.
- Existing maximum-loss / payout-floor protections, owner pause, safety halt, account lockout, DXtrade reconciliation, and confirmed-fill accounting remain applicable unless a later approved decision explicitly changes them.
- No automatic execution is authorized by D-040.

## Inactivity heartbeat

A 30-day inactivity heartbeat is mandatory and must be implemented as a separate minimum-size round trip that does not read, increment, arm, disarm, or otherwise mutate ring strategy state. Exact SOL minimum order quantity and heartbeat execution details must be verified before live activation.

## Data identity

- Strategy market/reference source: Binance `SOLUSDT`.
- Broker/account instrument: DXtrade `SOL/USD`.
- 5-minute OHLCV is the strategy trigger interval.
- 200-day MA uses completed daily closes only.
- Source and symbol identity must remain preserved throughout the data path.

## Still-required exact definitions before production implementation is complete

1. Exact four tranche target-price formulas relative to the moving 200-day MA.
2. How a ring can reach two simultaneous positions if it is locked whenever any position is open.
3. Exact re-arm excursion interpretation when the MA and therefore the ring level move: excursion direction and whether the threshold is measured against the contemporaneous moving ring or the ring price at close time.
4. Exact tranche quantity rounding at the `0.01 SOL` increment, including sub-minimum tranche behavior.
5. Deterministic ordering when one 5-minute bar touches multiple entry/exit levels and OHLC alone does not reveal the intrabar sequence.
6. Resolution of simultaneous independent BUY+SHORT inventory versus the verified DXtrade netting / one-signed-position account model.
7. Exact minimum SOL order quantity for the inactivity heartbeat and eventual live execution.

Until these are resolved, the migration branch must remain locked and must not silently invent production behavior. `AUTO_EXECUTE=false` and `execution.autoExecute=false` remain required.
