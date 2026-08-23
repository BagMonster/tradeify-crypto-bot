# D-038 next implementation

The next code change after CI is the DXtrade execution adapter and persistent order/idempotency ledger, still behind `AUTO_EXECUTE=false` and `execution.autoExecute=false`. Before those write methods are added, the live DXtrade REST hostname must be hard-pinned and the adapter tests must prove that rejected, timed-out, duplicate, or unconfirmed orders never advance grid state.
