# D-068 — $33 proportional rollover harvest

**Status:** Approved by owner for the active `10k` profile on 2026-09-26; implementation pending review, merge, and Railway deployment.

## Decision

- Change the active `10k` profile harvest threshold from `$75` to `$33`.
- The existing account-day harvest remains a full, all-book harvest for profit earned during the current account day.
- A different rollover path has priority when the combined unrealised profit on **every open broker position in the configured Tradeify account**, calculated from each broker entry, is at least `$33`. This is explicitly **not** a `$33` requirement per coin.
- That rollover path closes only approximately `$33` of the **account-wide combined profit**, allocated proportionally across every profitable ticket. This includes ring, manual, adopted, and current-account-day inventory. Quantity is floored to each instrument's `0.01` lot step and the planned total must not exceed `$33`.
- Each partial close requires the exact live DXtrade `positionCode`; no ticket is inferred from virtual state. If any configured book cannot be read or priced, the rollover harvest fails closed rather than silently excluding it.
- On a confirmed rollover harvest, the account-day harvest is complete. As with the existing harvest contract, new touch-cross entries may occur while ordinary tranche-profit exits remain paused until the next 22:00 UTC rollover. Protective cuts and the loss flatten remain available.

## Safety behavior

- The plan is durable in `session_harvest_state` and records completed lot closes so a restart does not submit a second partial close.
- An unread broker response remains retryable and fail-closed. A rejected, changed, missing, or side-mismatched planned ticket creates a durable rollover-harvest halt; it cannot be bypassed with `/resume`.
- Broker-confirmed fills, not Binance marks, advance virtual inventory. Binance marks are used only to calculate the proportional plan; DXtrade remains the execution authority.

## Compatibility

This does not alter the daily-loss limit, per-coin cap, exposure pool, protective-cut ladder, immediate `-$250` full flatten, or the one-sided-per-instrument rule.
