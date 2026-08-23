# D-038 implementation checklist

This checklist is intentionally event-driven rather than calendar-driven. It does not require waiting for natural BTC grid triggers.

## Before live activation

- [x] Fresh security review completed with no critical/high blocking findings.
- [x] Frozen BTC grid engine exists as production-isolated code.
- [x] Binance BTCUSDT live-feed module exists with stale/duplicate/out-of-order handling.
- [x] PostgreSQL grid-state store exists with version conflict protection.
- [x] Grid-specific account-floor rules exist.
- [x] Double execution-lock guard exists.
- [x] Confirmed-fill-only state advancement exists.
- [x] Deterministic replay tests exercise level transitions without waiting for live market movement.
- [ ] GitHub Actions passes the production-grid branch.
- [ ] DXtrade hostname is hard-pinned before write capability.
- [ ] DXtrade order adapter is implemented and tested behind both disabled execution locks.
- [ ] Broker rejection/timeout/reconciliation paths are tested.
- [ ] PostgreSQL persistent order/idempotency ledger is implemented and tested.
- [ ] Production worker wiring is completed while execution remains disabled.
- [ ] Railway deploy/start/restart recovery is verified.
- [ ] D-007 Telegram operator reference and command parity are complete.
- [ ] Owner separately approves the one minimum-size live lifecycle canary.
- [ ] Canary submit -> confirmed fill -> persistence -> reconciliation -> controlled close is verified.
- [ ] Owner separately approves full frozen-grid live activation.

Neither this checklist nor D-038 changes `AUTO_EXECUTE=false` or `execution.autoExecute=false`.
