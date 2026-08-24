# D-047 — Telegram broker-confirmed live trade and safety notifications

**Status:** APPROVED by owner on 2026-08-24; implementation in progress on `feature/telegram-live-notifications`.

## Decision

Add owner-only automatic Telegram notifications for broker-confirmed SOL production events without changing `sol-outer-heavy-v1`, its ring geometry, execution ordering, account-risk rules, reconciliation behavior, or order-routing semantics.

The owner approved **individual notifications** for each confirmed grid entry, each confirmed tranche exit, each fully closed virtual lot, and each completed inactivity-heartbeat round trip. Safety messages use a deliberately louder presentation than normal trade messages. Trade messages use a useful-middle detail level: ring, side, broker-confirmed fill price, confirmed quantity, virtual-lot identity, tranche when applicable, current MA/target context when safely available, and relevant durable state information. Raw broker payloads and secrets are never shown.

The notification layer may report only durable/authoritative production outcomes. A submitted or acknowledged DXtrade order must never be described as a fill. Trade notifications are emitted only after the broker-confirmed fill has been accepted by the existing execution path and the corresponding durable strategy/account state transition has succeeded where applicable.

Initial notification classes:

- confirmed grid entry;
- confirmed tranche exit;
- fully closed virtual lot;
- completed inactivity-heartbeat round trip;
- safety halt / reconciliation mismatch / account lockout requiring owner attention;
- confirmed protective flatten.

Presentation convention:

- normal confirmed entry: `🟢`;
- tranche/profit-taking activity: `💰`;
- fully closed lot / successful heartbeat: `✅`;
- warning: `⚠️`;
- safety halt, reconciliation mismatch, account lockout, or protective flatten requiring attention: `🚨`.

Telegram delivery is observational only. Delivery failure must never roll back a confirmed fill, retry an order, mutate virtual-lot/ring state, suppress a protective action, or weaken an independent safety gate. Notification payloads must be field-whitelisted and must not contain credentials, raw broker payloads, owner identifiers, session tokens, or arbitrary exception text.

Notifications use durable event identities with at-most-once delivery semantics. The bot claims a notification identity before attempting Telegram delivery. An already-claimed identity is not automatically resent after retries or restarts, preventing duplicate success messages if a process fails after Telegram accepts a message but before local delivery status is updated.

## Required verification

- no fill notification before broker confirmation;
- no duplicate notification for the same durable event under retry/restart conditions;
- Telegram delivery failure cannot change trading/account state or trigger an order retry;
- entry, tranche exit, full-lot close, heartbeat completion, reconciliation/account-lockout, and protective-flatten formatting are covered by automated tests;
- notifications are delivered only to the configured owner destination;
- no raw transport error or secret-bearing payload is included in notification/audit records;
- GitHub Actions pass and the Railway deployment is healthy before production use.

D-047 does not authorize any strategy, risk, execution, sizing, account-rule, or manual-trading change.
