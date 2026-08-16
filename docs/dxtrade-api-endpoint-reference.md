# DXtrade Developer API — Endpoint Reference (research only, not yet implemented)

**Status:** Research/documentation only. Nothing in this document has been implemented, and no DXtrade credentials, client code, or order-routing capability has been added to the repository as a result of it. Per the project's standing rule, any actual DXtrade credential/auth/client/session/order-routing work requires the D-004 Codex Security checkpoint and the appropriate approved chapter gate before implementation begins — this document is preparatory reading only, done at the owner's request, to identify which endpoints the bot will eventually need.

**Source:** https://demo.dx.trade/developers/#/ (DXtrade Developer Portal), read directly via browser on 2026-08-16. The portal lists 7 documents: DXtrade REST API, DXtrade Push API, DXtrade FIX Market Data API, DXtrade FIX Trading API, DXtrade Administrative REST API, DXtrade Amazon SQS API, DXtrade Report API, plus an "SSO for external links" resource. Only the REST API and Push API were read in full — the FIX APIs are B2B/institutional protocols not relevant to a single retail funded account, the Administrative REST API is for broker-side account/user management (deposits, withdrawals, user creation) not a client-side trading bot, the Amazon SQS API and Report API are broker-infrastructure/reporting tools, not applicable here.

## Two APIs relevant to this bot

**DXtrade REST API** — synchronous request/response, used for trading operations, account data, historical/current market data. This is the API the bot's `dxtradeClient.js` will eventually need for order placement, position/account queries, and historical candle backfill.

**DXtrade Push API** — asynchronous WebSocket API, used for real-time streaming updates (account portfolio changes, live quotes/candles, account events). Relevant for a future live-monitoring phase (replacing/supplementing polling), not for backtesting.

Base host for both, on the demo environment: `https://demo.dx.trade/dxsca-web/...` (REST) and a WebSocket equivalent for Push. Production would use the live platform's own host — not yet confirmed.

## Authentication (both APIs)

Two methods, both via the REST API's login endpoints:

- **Token auth** — `POST /dxsca-web/login` with `{username, domain, password}` returns a session token, used thereafter as `Authorization: DXAPI <token>` on every request. Also `POST /dxsca-web/loginByToken` (SSO-token variant) and `POST /dxsca-web/ping` (keep-alive) and `POST /dxsca-web/logout`.
- **HMAC auth** — a public/private token pair issued during onboarding; every request signed with a SHA2-256 HMAC over method+content+URI+timestamp, sent as `Authorization: DXAPI principal="...",timestamp=...,hash="..."`. Better suited to B2B; token auth is the simpler fit for a single-account retail bot.

No credentials, tokens, or actual login flow have been implemented — this is documentation only.

## REST API — endpoints relevant to backtesting (Chapter 26/27 scope)

**Market Data — `POST /dxsca-web/marketdata`** — the one that matters most right now. Takes a `Market Data Request` body:

```
{
  "eventTypes": [ { "type": "Candle", "candleType": "15m", "fromTime": "...", "toTime": "...", "count": ... } ],
  "symbols": "BTC/USD",
  "account": "<optional, only for multi-account commission/pricing setups>"
}
```

`eventTypes[].type` is either `Quote` (current bid/ask) or `Candle` (OHLC). For `Candle`, `fromTime`/`toTime` (UTC) and `count` (max candles returned) are supported. **`candleType` possible values, confirmed directly off the docs: `m` (1min), `5m`, `15m`, `30m`, `h` (1hr), `2h`, `4h`, `d` (day), `w` (week), `mo` (month).** This lines up exactly with the project's existing 15m/4h/1d Binance backfill timeframes — DXtrade's REST API can serve the same three timeframes natively, plus finer ones (down to 1-minute) if the box-fade research ever needs 5-minute DXtrade data instead of a Binance/browser workaround.

Candle response fields: `type`, `candleType`, `symbol`, `open`, `high`, `low`, `close`, `volume`, `time` (UTC). Quote response fields: `type`, `symbol`, `bid`, `ask`, `time`.

**Reference Data — instruments:**
- `GET /dxsca-web/instruments/{symbol}` / `/instruments/type/{type}` / `/instruments/query` — general instrument metadata (symbol, pip size, price increment, lot size, currency, trading hours, holidays). Confirms exact contract specs for BTC/USD (and SOL/USD if ever re-enabled).
- `GET /dxsca-web/accounts/{account code}/instruments/{symbol}` (and `/type/{type}`, `/query`) — account-specific instrument parameters (margin rate, min/max order size, trading status), which may differ from the generic instrument data above.

**Conversion Rates — `GET /dxsca-web/conversionRates?fromCurrency=...&toCurrency=...`** — current FX conversion rate between two currencies. Relevant if the account's base currency ever differs from an instrument's quote currency.

## REST API — endpoints relevant to the eventual live/paper execution phase (Chapter 27+, gated)

None of these should be implemented yet — listed here only so the research phase knows what exists.

**Trading:**
- `POST /dxsca-web/accounts/{account code}/orders` — Place Order. Body is a `Single Order Request` (orderCode, type: MARKET/LIMIT/STOP, instrument, quantity, side: BUY/SELL, positionEffect: OPEN/CLOSE, positionCode, limitPrice/stopPrice, priceOffset/priceLink for protection orders, tif: GTC/DAY/GTD, expireDate, metadata) or an `Order Group Request` (OCO or IF-THEN contingency groups — directly relevant to a future bracket-order design: stop-loss + take-profit as a linked group).
- `PUT /dxsca-web/accounts/{account code}/orders` — Modify Order. Requires the whole order request re-submitted (idempotency), ETag/If-Match conditional headers.
- `DELETE /dxsca-web/accounts/{account code}/orders/{order code}` (or `/orders/group`) — Cancel Order. Also conditional (ETag).
- `POST /dxsca-web/accounts/{account code}/close` — Bulk Close. Closes positions and/or cancels working orders in one call, optionally filtered by instrument.

**Account/portfolio queries (all GET, all support single or multi-account via `?accounts=`):**
- `/accounts/{account code}/portfolio` — open positions + working orders.
- `/accounts/{account code}/positions` — open positions only.
- `/accounts/{account code}/orders` — open orders only.
- `/accounts/{account code}/orders/history` — historical orders (all statuses), POST variant available for complex queries.
- `/accounts/{account code}/metrics` — live PnL/equity/margin/balance metrics; `include-positions` query param for per-position breakdown.
- `/accounts/{account code}/transfers` — cash transfers (deposits, withdrawals, PnL settlement, commissions).
- `/accounts/{account code}/events` — margin calls, liquidations.
- `/accounts/eodmetrics/{date}` — end-of-day account metrics for a specific date.
- `/accounts/{account}/tvLoginInfo` — TradingView login info (not relevant to this bot).
- `/users/{username}` — user info.

## Push API (WebSocket) — for a future live-monitoring phase, not backtesting

Two WebSocket endpoints: one for business events (`?format=&compression=`), one for market data (`/md?format=&compression=`). Both require a token obtained via the REST login endpoint first, then passed in the `session` field of each message. Subscription/unsubscription pairs exist for: Account Portfolios, Instruments, Instrument Details, Account Metrics, Account Events, Cash Transfers, and Market Data (Quotes and Candles). Each subscription streams updates as they happen rather than requiring polling — e.g., `AccountPortfoliosSubscriptionRequest` pushes the full portfolio every time an order or position changes, `AccountMetricsSubscriptionRequest` streams PnL/equity/margin at a server-configured interval. This would be the natural replacement for polling `/accounts/{account}/metrics` once (if) the bot moves to live monitoring, but implementing it is out of scope until that phase is approved.

## What this means for the project right now

For Step 26.7 onward and any future DXtrade-vs-Binance comparison work (D-001/D-002), the REST API's `POST /dxsca-web/marketdata` Candle endpoint is the concrete mechanism for eventually pulling DXtrade's own OHLC history at 15m/4h/1d — the same three timeframes already in use — to compare against the Binance-sourced backtest data per D-001/D-002's existing (unimplemented) comparison gate. That comparison, and any DXtrade credential/session/client work to make it possible, is still gated by the project's standing rule: no DXtrade credentials, authentication, sessions, clients, or order-routing capability before the appropriate approved chapter, with the D-004 Codex Security checkpoint enforced first. Nothing here starts that work — it only identifies which endpoint would eventually be used.
