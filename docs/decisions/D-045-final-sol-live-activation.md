# D-045 — Final SOL live activation

**Status:** APPROVED by owner on 2026-08-23 after the real SOL lifecycle canary completed successfully.

The owner has repeatedly directed the project to get the SOL bot started and provided standing approval to proceed through the live-activation sequence without repeatedly asking for the same approval. The required real lifecycle canary has now completed successfully: 0.01 SOL opened at $93.83, the minimum hold requirement was satisfied, the exact linked SOL position closed at $93.88, DXtrade confirmed the broker account flat, and the owner-visible DXtrade portfolio showed no open position or pending order afterward.

The frozen production strategy remains `sol-outer-heavy-v1` with the D-040 parameters and D-041 live-touch semantics. D-045 authorizes automatic production-grid execution once the activation deployment is healthy and the two execution controls are deliberately enabled. No strategy parameter, account floor, $1,500 daily-loss protection, approximately $1,830 gross virtual-exposure ceiling, owner pause, safety halt, account lockout, feed-freshness requirement, account-data freshness requirement, reconciliation invariant, protective flatten, or 25-second project minimum hold is weakened by this decision.

Activation uses two controls:

- repository strategy control: `config/strategy.json` → `execution.autoExecute=true`;
- Railway environment control: `AUTO_EXECUTE=true` with `APP_MODE=live`.

The repository may be deployed in an armed state with the strategy control true while the Railway control remains false. That armed state must not place automatic grid orders. `AUTO_EXECUTE=true` is valid only when `APP_MODE=live`; the execution guard still requires both execution controls to be true before a strategy order is submitted.

The completed V2 canary remains durable historical evidence and is not repeated as part of normal activation. The older V1 pending attempt remains historical only and must never be resubmitted.
