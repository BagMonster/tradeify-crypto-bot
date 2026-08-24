# D-039 — Transition production plan from BTC to SOL

**Status:** APPROVED by owner on 2026-08-23; implementation prepared on a locked migration branch; final SOL grid parameters pending statistician results.

## Approved change

The planned production trading instrument changes from BTC to Solana.

- DXtrade instrument: `SOL/USD`
- Binance market/reference symbol: `SOLUSDT`
- BTC production-grid rules are retained only as historical implementation evidence and must not be applied to SOL.
- The final SOL grid levels, sizing, reset behavior, and any strategy-specific parameters are intentionally not invented here. They will be supplied from the approved statistical analysis.

## Transition rules

1. Exactly one trading instrument may be enabled. During the SOL transition, `BTC/USD` is disabled and `SOL/USD` is enabled.
2. Binance remains the external live/reference market source and must preserve `source=binance` and `symbol=SOLUSDT` through the active data path.
3. DXtrade remains the account/broker interface for account state, positions, fills, reconciliation, and eventual execution using `SOL/USD`.
4. Old BTC grid state must never be interpreted as a SOL reference. Persisted grid state is namespaced by strategy identity and instrument so a new SOL strategy starts from a new SOL reference only while the account is flat and account data is healthy.
5. Order identity and the persistent execution ledger are namespaced so a SOL strategy cannot collide with old BTC state/version/grid tags.
6. Any non-SOL open position during SOL operation is an account-locking invariant violation requiring owner reconciliation.
7. No existing BTC percentages or dollar sizes are silently copied to SOL. The final SOL strategy module must match the statistician-approved strategy ID and parameters before the runtime can initialize a SOL grid.
8. While the SOL strategy is pending, the migration runtime may monitor SOL market/account data but must not instantiate the old BTC grid as a fallback.
9. Automatic execution remains OFF. Railway `AUTO_EXECUTE=false` and `config/strategy.json` `execution.autoExecute=false` remain required. D-039 does not authorize a live order or the final production activation.

## Prepared implementation boundary

The migration branch generalizes instrument selection across configuration, Binance live data, DXtrade account monitoring, DXtrade order construction, guarded execution, runtime symbol validation, Telegram status/preflight wording, persistent grid identity, and execution-ledger identity. The final strategy should therefore be delivered as strategy-specific logic/config rather than another asset-plumbing rewrite.

The migration branch is not to be merged into the deployed `main` branch until the SOL strategy is supplied, reviewed against the backtest assumptions, its strategy module/tests are added, and the full branch test suite is green.
