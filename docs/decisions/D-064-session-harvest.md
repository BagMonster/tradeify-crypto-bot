# D-064 — $100,000 five-book sizing and session harvest

**Status:** Approved for this PR after owner review; live on deployment only after merge.
**Scope:** Trading worker only. The companion worker receives no trading authority.

## Decision

- Each enabled book has a `$100,000` virtual-gross cap. There is no additional multi-book entry rejection solely because combined valid book exposure exceeds the retired single-strategy `$100,000` setting.
- The Tradeify account day runs from **22:00 UTC to 22:00 UTC**.
- A fresh, readable broker account-day P&L of **+$250 or more** triggers one session harvest. The value includes realized and unrealized P&L: equity minus the account-day opening balance.
- Harvest is evaluated before ordinary grid entries or tranche exits on each live tick.
- On trigger, the bot enters durable `PENDING`, pauses ordinary entries and exits, and closes every enabled broker book through the existing position-linked protective-close path.
- Only fresh broker confirmation that every enabled book is flat changes the day to `CONFIRMED`.
- While confirmed, new entries may occur only on the normal live touch-cross rule. Ordinary tranche-profit exits remain disabled until the next 22:00 UTC rollover.
- A terminal close rejection, unread broker book, or non-flat verification changes the day to `HALTED`, preserves the pause, sets the durable safety halt, and alerts the owner.
- Protective loss cuts and the account protective flatten always remain available.

## Operator visibility

Telegram and `/status` show harvest `READY`, `PENDING`, `CONFIRMED`, or `HALTED`. The worker sends notifications for pending, confirmed, halted, and account-day reset transitions. PostgreSQL stores the state keyed to the account-day key so a Railway restart cannot re-enable exits early or permit a second harvest.

## Deployment

The corrected sizing and harvest settings activate together in the first deployment after this PR merges. The current account day is immediately in scope: after startup, a fresh account snapshot at or above `+$250` begins the harvest path even if the bot was previously paused and manually flattened.

## Verification

The PR must pass syntax, full tests, D-064 state/restart tests, notification tests, and a final review of `/status` before merge. It must not be merged or deployed until those checks pass.
