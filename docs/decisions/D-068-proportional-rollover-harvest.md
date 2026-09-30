# D-068 — proportional rollover harvest

**Status:** Approved 2026-09-26; window narrowed 2026-09-29 to every account profile. Harvest dollars set to +$33 / +$165 / +$330.

## Decision

- Harvest dollars are profile-owned and scale with account size: `10k` +$33, `50k` +$165, `100k` +$330 (0.33% of account size).
- The existing account-day harvest remains a full, all-book harvest for profit earned during the current account day.
- D-068 may **start a new plan only** inside **22:05–22:08 UTC on every profile**. That is `22:00 UTC + rolloverHarvestDelayMinutes` through that instant plus `rolloverHarvestWindowMinutes`. Every file in `config/profiles/` sets delay `5` and window `3`.
- Inside that window, the rollover path has priority when the combined unrealised profit on **every open broker position in the configured Tradeify account**, calculated from each broker entry, is at least the profile harvest amount. This is explicitly **not** a per-coin requirement.
- Outside that window, a harvest hit is D-064 full flatten. An already-pending D-068 plan still finishes after 22:08 so a close in flight is not abandoned.
- That rollover path closes only approximately the profile harvest amount of the **account-wide combined profit**, allocated proportionally across every profitable ticket. This includes ring, manual, adopted, and current-account-day inventory. Quantity is floored to each instrument's `0.01` lot step and the planned total must not exceed the harvest amount.
- Each partial close requires the exact live DXtrade `positionCode`; no ticket is inferred from virtual state. If any configured book cannot be read or priced, the rollover harvest waits for fresh data and places no partial-harvest order; it does not omit that book.
- On a confirmed rollover harvest, the account-day harvest is complete. As with the existing harvest contract, new touch-cross entries may occur while ordinary tranche-profit exits remain paused until the next 22:00 UTC rollover. Protective cuts and the loss flatten remain available.

## Safety behavior

- The plan is durable in `session_harvest_state` and records completed lot closes so a restart does not submit a second partial close.
- An unread broker response remains retryable and fail-closed. A rejected, changed, missing, or side-mismatched planned ticket creates a durable rollover-harvest halt; it cannot be bypassed with `/resume`.
- Broker-confirmed fills, not Binance marks, advance virtual inventory. Binance marks are used only to calculate the proportional plan; DXtrade remains the execution authority.

## Compatibility

This does not alter the daily-loss limit, per-coin cap, exposure pool, protective-cut ladder, immediate full flatten, or the one-sided-per-instrument rule.
