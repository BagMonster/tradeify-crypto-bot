# D-038 — Fast-track BTC grid activation

**Status:** APPROVED by owner on 2026-08-23.

## Decision

The production BTC grid will not wait for calendar-duration shadow periods or for natural BTC moves to happen before technical validation can complete.

The following waiting requirements are retired for activation readiness:

- fixed 24-hour, 7-day, 90-day, or 180-day shadow waiting periods;
- minimum shadow trade-count requirements;
- any requirement to wait for a naturally occurring grid trigger before technical validation can pass.

Validation will instead use deterministic replay and injected production-shaped inputs to exercise every frozen grid level, restarts, stale-data behavior, duplicate/rejected order handling, account-floor events, confirmed-fill state advancement, and PostgreSQL recovery.

## Grid-specific gates

Legacy gates from the retired Bollinger/RSI strategy do not govern the production grid. In particular, activation of the frozen grid does not depend on indicator warm-up, regime permission, news blackout, legacy per-trade risk caps, daily soft-stop, profit ceiling, or the former 21:45 UTC hard-flat rule.

The production grid retains only controls that directly protect the funded account or prevent corrupted execution state:

- BTC only; SOL remains disabled;
- fresh, valid Binance `BTCUSDT` market data for new grid actions;
- current Tradeify account/equity state before new grid actions;
- $1,500 daily-loss protection;
- maximum-loss / payout floor protection;
- owner pause, safety halt, and account lockout;
- DXtrade netting / one signed BTC position model;
- configured maximum notional;
- 25-second minimum entry hold guard where applicable;
- idempotent order identity and duplicate-order protection;
- submitted/acknowledged orders are not fills;
- grid reference, counters, and pointers advance only after a confirmed broker fill;
- protective account actions outrank entry delays, pause, and Binance-signal availability.

## Fast-track path

1. Build the production Binance feed, deterministic frozen grid engine, PostgreSQL state, account rules, and guarded execution path while both automatic-execution locks remain false.
2. Exercise the production path through deterministic replay/failure injection rather than waiting for natural market movement.
3. Verify tests and GitHub Actions, then deploy with execution disabled and verify Railway/PostgreSQL/Telegram startup and recovery.
4. Perform one separately approved, controlled minimum-size live execution lifecycle canary: submit -> confirmed fill -> persisted state -> reconciliation -> controlled close.
5. If the canary is clean, present the final owner activation checkpoint for the frozen `$250 / $550 / $1,250` BTC grid.

D-038 does **not** itself authorize live automatic trading and does not change either execution lock. `AUTO_EXECUTE=false` and `execution.autoExecute=false` remain required until the separate final activation decision.

## Supersession

D-038 supersedes calendar-duration and natural-signal waiting requirements in D-002, D-009, D-034, D-037, and any older manual text to the extent those requirements would delay activation solely to accumulate elapsed shadow time or naturally occurring signals. It does not supersede account-loss protections, execution correctness, D-004 security blocking findings, D-007 operator documentation, or the requirement for explicit final live activation approval.

> Repository note: this approval is recorded here immediately so implementation can proceed without ambiguity. It must also be appended verbatim or equivalently summarized in `docs/implementation-decision-log.md` before the production branch is merged.
