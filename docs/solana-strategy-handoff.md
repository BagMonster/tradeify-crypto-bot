# Solana Strategy Handoff

When the statistician finishes the SOL grid analysis, provide the following items. This is the remaining strategy-specific input needed by the prepared migration branch.

## Required strategy definition

- Strategy name and stable `strategyId`.
- Initial reference/anchor rule.
- BUY1, BUY2, BUY3 trigger distances from the active reference.
- SELL1, SELL2, SELL3 trigger distances from the active reference.
- Cash size in USD for each BUY and SELL level, or an explicit instruction if sizing must instead be expressed in SOL quantity.
- Reference-reset rule after a confirmed BUY fill.
- Reference-reset rule after a confirmed SELL fill.
- Maximum consecutive same-side fills and what an opposite-side fill resets.
- Any condition that re-arms or terminates the ladder.

## Execution assumptions to state explicitly

- Minimum SOL order size and quantity increment assumed by the backtest, if used.
- Commission/fee assumption.
- Slippage assumption.
- Whether the 25-second minimum entry hold changes any modeled fill.
- Maximum intended notional/exposure.
- Whether inventory may remain open across UTC day boundaries.

## Backtest result summary

Please include at least: tested date range, candle interval, number of fills/trades, net P&L after modeled costs, maximum drawdown, worst day, maximum position/notional reached, and any scenario that approached the $1,500 daily-loss or maximum-loss floor.

## Already prepared in GitHub

The migration branch already handles `SOLUSDT` Binance live data, `SOL/USD` DXtrade identity, account-position validation, order identity separation from BTC, strategy/instrument-namespaced persistent state, Telegram instrument wording, and locked Stage A operation. The old BTC grid is not used as a SOL fallback.

Automatic execution remains OFF while this handoff is pending.
