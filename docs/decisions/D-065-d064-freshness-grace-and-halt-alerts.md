# D-065 — D-064 broker-data outage notifications

## Status

Approved for implementation on 2026-09-09. A separate owner confirmation is required before merge or production deployment.

## Problem

At the 22:00 UTC account-day rollover, the five-book risk supervisor could evaluate one Binance tick while the shared DXtrade account monitor was briefly older than its three-second freshness threshold. It originally treated that transient read as a grid block and then could turn a short monitor outage into a durable D-064 harvest halt, even though the next monitor poll was healthy.

The bot also needed a clear Telegram explanation for every actual safety halt. In particular, the D-064 formatter rejected instrument names containing `/`, so the fresh-data halt notification could be dropped after the halt was already persisted.

## Decision

1. An unreadable shared DXtrade account snapshot is alert-only. It does not apply a D-064 entry brake, pause ordinary exits, or persist a safety halt.
2. The owner receives one `D-064 DXTRADE DATA OUTAGE` Telegram alert when a persisted outage episode starts. The episode survives a worker restart and quick fresh/unread flaps, so a new Telegram alert is not created for each monitor poll.
3. After 60 seconds of continuously fresh reads, the bot sends one `D-064 DXTRADE DATA RESTORED` notification and resolves the episode. A later outage starts a new episode.
4. The risk supervisor continues to record the condition for `/status`, but `index.mjs` does not use `ACCOUNT_DATA_UNAVAILABLE` as a normal grid gate. Each individual execution still performs its existing broker validation before an order can be sent.
5. A terminal D-064 harvest flat-confirmation failure remains a manual-review condition; this decision only changes unreadable shared-account snapshots.
6. Every current persisted safety-halt origin produces an owner Telegram alert with a corrective path:
   - D-064 fresh-data halt: verify fresh status and matching nets, then use `/harvestrecover` and its confirmation code.
   - 15-minute reconciliation halt: once nets match, use `/rematch INSTRUMENT` and its confirmation code.
   - Runtime-error halt: once every virtual/broker net matches, use `/rerun` and its confirmation code.
   - D-049 and account-wide protective flatten: inspect `/status` and DXtrade; `/resume` does not bypass their protection.

## Invariants

- DXtrade remains authoritative for account and position state.
- No uncertain broker state is treated as a flat account.
- A D-064 outage never erases independent loss-tier, protective-order, reconciliation, or account-wide safety gates.
- A terminal D-064 flat-confirmation failure remains manual-review-only and is not eligible for `/harvestrecover`.
- Telegram alerts are owner-only and contain no credentials or raw broker response bodies.

## Verification

- D-064 tests cover warning-only outages, no D-064 entry brake, no durable halt at five minutes, notification de-duplication across a fresh/unread flap, and the single restored notification after stable reads.
- Notification tests cover outage/restored text, instrument names with `/`, reconciliation recovery, runtime recovery, D-049, and account-wide flatten text.
- Full syntax checks and the complete test suite must pass before merge.
