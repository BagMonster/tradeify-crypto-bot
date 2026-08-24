# D-047 — Telegram broker-confirmed live trade and safety notifications

**Status:** DRAFT for owner review; not governing until explicitly approved.

## Proposed decision

Add owner-only automatic Telegram notifications for broker-confirmed SOL production events without changing `sol-outer-heavy-v1`, its ring geometry, execution ordering, account-risk rules, reconciliation behavior, or order-routing semantics.

The notification layer may report only durable/authoritative production outcomes. A submitted or acknowledged DXtrade order must never be described as a fill. Trade notifications are emitted only after the broker-confirmed fill has been accepted by the existing execution path and the corresponding durable strategy/account state transition has succeeded where applicable.

Initial notification classes:

- confirmed grid entry;
- confirmed tranche exit;
- fully closed virtual lot;
- completed inactivity-heartbeat round trip;
- safety halt / reconciliation mismatch / account lockout requiring owner attention;
- confirmed protective flatten.

Telegram delivery is observational only. Delivery failure must never roll back a confirmed fill, retry an order, mutate virtual-lot/ring state, suppress a protective action, or weaken an independent safety gate. Notification payloads must be field-whitelisted and must not contain credentials, raw broker payloads, owner identifiers, session tokens, or arbitrary exception text.

## Required verification

- no fill notification before broker confirmation;
- no duplicate notification for the same durable event under retry/restart conditions;
- Telegram delivery failure cannot change trading/account state or trigger an order retry;
- entry, tranche exit, full-lot close, heartbeat completion, safety halt/reconciliation mismatch/account lockout, and protective flatten formatting are covered by automated tests;
- notifications are delivered only to the configured owner destination;
- GitHub Actions pass and the Railway deployment is healthy before production use.
