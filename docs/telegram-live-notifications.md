# Telegram live notifications

Automatic owner-only notifications are governed by D-047 and the D-049 / D-060 protective classes.

The bot reports only broker-confirmed or durable safety outcomes. Submitted or acknowledged DXtrade orders are never described as fills.

Current classes:

- confirmed grid entry (any enabled instrument);
- confirmed tranche exit;
- fully closed virtual lot;
- completed inactivity-heartbeat round trip;
- reconciliation mismatch / safety halt;
- Tradeify account lockout;
- runtime safety halt;
- D-060 / D-049 protective cut;
- D-060 / D-049 full flatten.

Delivery is observational only. Telegram failure cannot roll back trading state, retry an order, mutate ring state, delay a protective action, or weaken any independent safety gate.
