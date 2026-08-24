# Telegram Live Notifications

Automatic owner-only notifications are governed by D-047.

The bot reports only broker-confirmed or durable safety outcomes. Submitted or acknowledged DXtrade orders are never described as fills.

Current notification classes:

- confirmed SOL grid entry;
- confirmed SOL tranche exit;
- fully closed SOL virtual lot;
- completed inactivity-heartbeat round trip;
- reconciliation mismatch / safety halt;
- Tradeify account lockout;
- confirmed protective flatten.

Delivery is observational only. Telegram failure cannot roll back trading state, retry an order, mutate ring state, delay a protective action, or weaken any independent safety gate. Durable notification identities provide at-most-once delivery across retries and restarts.
