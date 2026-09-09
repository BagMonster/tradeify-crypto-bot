# D-065 — D-064 fresh-data grace and halt explanations

## Status

Approved for implementation on 2026-09-09. A separate owner confirmation is required before merge or production deployment.

## Problem

At the 22:00 UTC account-day rollover, the five-book risk supervisor could evaluate one Binance tick while the shared DXtrade account monitor was briefly older than its three-second freshness threshold. It then treated that transient read as an immediate, durable D-064 harvest halt, even though the next monitor poll was healthy.

The bot also needed a clear Telegram explanation for every actual safety halt. In particular, the D-064 formatter rejected instrument names containing `/`, so the fresh-data halt notification could be dropped after the halt was already persisted.

## Decision

1. `accountRisk.sessionHarvestFreshDataGraceMs` is `300000` (five minutes).
2. While account data is unreadable inside that grace window, all normal grid actions remain blocked. The bot does not place a new entry or ordinary exit from uncertain broker state.
3. The owner receives one `D-064 FRESH-DATA GRACE` Telegram alert per uninterrupted unread interval. It identifies the affected books, explains that a durable halt has not yet been latched, and instructs the owner to wait for fresh `/status` data rather than using `/resume`.
4. A fresh read inside the window clears the temporary block automatically. It does not alter virtual lots, broker orders, positions, harvest state, or an operator pause.
5. If broker account data remains unreadable for five minutes after at least one successful read in the worker, the bot persists the existing D-064 harvest halt and stays fail-closed.
6. Every current persisted safety-halt origin produces an owner Telegram alert with a corrective path:
   - D-064 fresh-data halt: verify fresh status and matching nets, then use `/harvestrecover` and its confirmation code.
   - 15-minute reconciliation halt: once nets match, use `/rematch INSTRUMENT` and its confirmation code.
   - Runtime-error halt: once every virtual/broker net matches, use `/rerun` and its confirmation code.
   - D-049 and account-wide protective flatten: inspect `/status` and DXtrade; `/resume` does not bypass their protection.

## Invariants

- DXtrade remains authoritative for account and position state.
- No uncertain broker state is treated as a flat account.
- The grace period is not a permission to trade; it only prevents a transient monitor delay from becoming an irreversible halt.
- A terminal D-064 flat-confirmation failure remains manual-review-only and is not eligible for `/harvestrecover`.
- Telegram alerts are owner-only and contain no credentials or raw broker response bodies.

## Verification

- D-064 tests cover first unread read, five-minute grace, automatic clearing on fresh data, and durable halting at grace expiry.
- Notification tests cover the grace alert, the D-064 recovery instruction, instrument names with `/`, reconciliation recovery, runtime recovery, D-049, and account-wide flatten text.
- Full syntax checks and the complete test suite must pass before merge.
