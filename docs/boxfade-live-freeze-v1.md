# Box-Fade Live Freeze v1

Written before running the multi-variant BTCUSD backtest.

## Goal
Find which of the 9 box-fade filter combinations works best on live-like
BTCUSD data, using rules that can also work across many crypto pairs.

## Shared rules (all 9 variants)
- Data: Dukascopy BTCUSD 5m + 1d
- Box: prior UTC calendar day high/low (fixedDaily)
- RSI(14) on 5m: long only if RSI <= 32; short only if RSI >= 68
- Stop: 3 * ATR(14 on 5m), anchored to the box edge (not entry price)
- Target: opposite box edge
- Time stop: 4 hours (48 five-minute bars)
- Hard flat: 21:45 UTC
- One open position at a time
- Costs: 0.04% commission per side, 0.05% slippage per fill
- Research risk cap: $100 per trade (size from stop distance)

## Regime (multi-asset ready)
- Daily ATR% and daily ADX(14)
- For day D, use only the prior 120 completed days (D-120 ... D-1)
- Compute percentile of day D's ATR% inside those 120 prior values
- Default trade permission: percentile between 40 and 60 inclusive AND ADX <= 25
- No lookahead: current day is never included in its own percentile window

## Variant differences only
1. confirm + VWAP
2. unsharp baseline
3. confirm baseline
4. confirm + bias + VWAP
5. confirm + SMA bias
6. confirm + expanded regime (percentile 40-60, ADX filter off)
7. unsharp + VWAP
8. unsharp + bias + VWAP
9. unsharp + SMA bias

## Notes
- These are research results for live-design, not automatic live trading.
- AUTO_EXECUTE remains false.