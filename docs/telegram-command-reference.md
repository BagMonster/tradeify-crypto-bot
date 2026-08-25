# Telegram Command Reference — Tradeify SOL Bot

**Strategy:** `sol-outer-heavy-v1` (D-049 sizing + daily risk ladder)  
**Operator:** owner-only  
**Current deployment gate:** final live activation is owner-approved under D-045. Automatic grid execution is ON only when `APP_MODE=live`, Railway `AUTO_EXECUTE=true`, and strategy `execution.autoExecute=true` are all satisfied.

All commands except `/whoami` require the configured owner Telegram user ID. Unauthorized users receive `Not authorized` and cannot invoke trading-control or development functions.

## Commands

### `/status`
Shows the current SOL bot, account, strategy, and execution state.

Expected fields include:
- app mode plus PRODUCTION LOCKED / ARMED / LIVE state
- Railway and strategy execution controls
- Tradeify balance, live equity, daily floor, MLL floor, and active-floor buffer
- Binance `SOLUSDT` feed health
- current completed-day 200-day SOL moving average
- virtual net SOL quantity
- virtual gross exposure versus the `$6,600` strategy ceiling
- open virtual lots, occupied rings, armed rings, and state version
- D-049 risk-ladder state when available (day baseline, drawdown, brake/cut/flatten flags)
- operator pause or safety-halt state when active

This command never places an order.

### `/health`
Checks that the Railway worker and PostgreSQL are reachable, the SOL 200-day moving-average provider is available, and reports the current automatic-execution state.

This command never places an order.

### `/levels`
Shows the entire production SOL ladder using the same current 200-day MA as the strategy.

For all **10 BUY and 10 SHORT** rings it reports:
- current Binance `SOLUSDT` trigger price;
- USD size (`$28.68 × 1.5^(level-1)` under D-049);
- estimated SOL quantity at that trigger price, floored to the `0.01 SOL` increment;
- current persistent ring state: `ARMED`, `DISARMED`, or `FULL`, with open-lot count where relevant.

Dead zone is ±13.5% of the MA; active rings run from ±13.5% through ±54%.

The trigger is a Binance strategy price. The eventual DXtrade `SOL/USD` fill can differ slightly. The displayed SOL quantity is therefore an estimate until the actual live trigger/fill event.

This command is read-only and never places an order or mutates ring state.

### `/rings`
Shows where the current live Binance `SOLUSDT` price sits relative to the current completed-day 200-day MA and the D-049 ring geometry.

It reports:
- `Dead zone`, `BUY ring zone`, or `SHORT ring zone`;
- a current crossed ring as `TOUCHED` or `THROUGH` when applicable;
- the next BUY ring below the current price;
- the next SHORT ring above the current price;
- dollar and percentage distance to each next ring;
- which side is closer;
- the USD size when a ring is currently crossed;
- risk-ladder summary when the runtime exposes it.

`/rings` deliberately ignores whether a ring is armed or occupied. Use `/levels` when you want current ring availability/state.

If the live Binance feed is stale/unavailable or the strategy MA is unavailable, the command returns a clear error and does not guess.

This command is read-only and never places an order or mutates ring state.

### `/dxpreflight`
Reads/validates the active DXtrade `SOL/USD` instrument settings using the existing preflight path. It does not call the order-placement endpoint.

Use this for broker/instrument metadata checks, not as proof that an order has filled or can be placed.

### `/solcanary`
Inspects or, while automatic grid execution is OFF, runs the separately owner-approved real DXtrade lifecycle canary.

The command is intentionally owner-only and is not available as an inline button. The verified V2 canary:
1. required no operator pause or safety halt, live equity above the active account floor, and a flat DXtrade account;
2. submitted exactly one `0.01 SOL` market BUY using a persistent canary order identity;
3. waited at least 25 seconds from the confirmed broker fill;
4. read the exact resulting DXtrade `SOL/USD` position and closed that position using the broker position code;
5. required a confirmed close fill and then verified the broker account was flat.

The verified V2 canary completed on 2026-08-23 with an open fill of `$93.83`, close fill of `$93.88`, and a flat broker account afterward. It never armed, disarmed, incremented, filled, or otherwise mutated a SOL strategy ring or tranche.

When automatic grid execution is ON, `/solcanary` is blocked and cannot start another round trip. The historical V1 pending attempt is never resubmitted.

### `/kill`
Immediately enables the durable operator pause in PostgreSQL. The pause survives a Railway restart.

It blocks new strategy entries. Existing protective account actions retain priority when required to protect the funded account.

### `/resume`
Starts the two-step resume process and returns a six-digit code that expires after 10 minutes.

The command does **not** resume by itself.

### `/confirmresume CODE`
Completes the two-step resume flow.

Example:

```text
/confirmresume 123456
```

The supplied code must be the current code generated by `/resume`. Removing the operator pause does not bypass a safety halt, stale account data, market-data failure, account lock, risk floor, exposure ceiling, risk ladder halt, reconciliation failure, or execution lock.

### `/flat`
Shows manual flattening instructions for `SOL/USD`.

This owner command is informational. Automatic protective flattening is performed by the production execution path only when its risk/safety conditions require it.

### `/code`
Enters the owner-only OpenAI development conversation. While this mode is active, ordinary owner text is queued through PostgreSQL to the separate `Tradeify Dev Companion` Railway worker and its response is returned in the same Telegram bot.

Phase 1 is conversational/read-only. It has no GitHub write capability and cannot place, modify, or close trades.

### `/devstatus`
Shows whether development mode is active, whether OpenAI conversation context exists, and how many development jobs are queued, processing, ready, or failed.

### `/devreset`
Starts a fresh OpenAI conversation by clearing the persisted response context. Development mode remains active.

### `/devexit`
Leaves development conversation mode. Existing OpenAI context is retained for a later `/code` session unless `/devreset` is used.

### `/whoami`
Shows the sender's immutable Telegram numeric user ID. This command is intentionally available without owner authorization so the owner can discover the ID needed during initial setup.

It does not reveal Telegram tokens or any other secret.

### `/help`
Shows the command list and opens the inline control menu.

## Inline buttons

| Button | Same behavior as |
|---|---|
| `Status` | `/status` |
| `Health` | `/health` |
| `Grid Levels` | `/levels` |
| `Ring Position` | `/rings` |
| `Pause Bot` | `/kill` |
| `Resume` | `/resume` |
| `Development` | `/code` |
| `Flat Instructions` | `/flat` |
| `Help` | `/help` |

Inline buttons use the same owner authorization check as slash commands. `/solcanary` is deliberately slash-command-only so it cannot be started by an accidental button tap.

## OpenAI development companion

D-048 keeps the development experience inside the current Telegram bot while OpenAI processing runs in a separate Railway worker. The production Tradeify worker remains the only Telegram polling process.

The Phase 1 path is:

```text
Owner Telegram message
  -> production Telegram worker
  -> PostgreSQL ai_dev_jobs
  -> Tradeify Dev Companion worker
  -> OpenAI Responses API
  -> PostgreSQL completed job
  -> production Telegram worker
  -> owner Telegram reply
```

Slash commands are never forwarded to OpenAI. Ordinary text is forwarded only while `/code` mode is active and only for the configured owner numeric Telegram ID.

The OpenAI API key exists only in the companion worker. The companion worker does not need the Telegram bot token or DXtrade credentials.

Phase 1 intentionally leaves a reusable development-tool boundary for a later owner-approved phase that may add repository inspection and confirmed GitHub branch changes without replacing this Telegram conversation architecture.

## Automatic live notifications

Under D-047 (and D-049 protective paths), the bot also sends owner-only push notifications without requiring a command. These messages are observational only; they do not place, retry, modify, cancel, or close orders.

The notification classes are:
- `🟢 SOL ENTRY CONFIRMED` — sent only after a DXtrade grid entry is broker-confirmed and the corresponding virtual-lot state is durably saved;
- `💰 SOL TRANCHE EXIT CONFIRMED` — one message for each broker-confirmed tranche exit after durable state advancement;
- `✅ SOL LOT FULLY CLOSED` — sent when the confirmed final exit removes the virtual lot;
- `✅ SOL INACTIVITY HEARTBEAT COMPLETE` — sent only after both heartbeat legs are confirmed; heartbeat activity never mutates ring state;
- `🚨 SOL SAFETY HALT — RECONCILIATION MISMATCH` — virtual net SOL and DXtrade net SOL disagree outside the reconciliation grace window;
- `🚨 TRADEIFY ACCOUNT LOCKOUT` — a foreign position, multiple broker positions, or a position-count mismatch locks new SOL actions;
- `🚨 SOL SAFETY HALT — RUNTIME ERROR` — the production runtime latches a safety halt after an internal processing failure;
- `🚨 PROTECTIVE FLATTEN CONFIRMED` — the funded-account protective path has broker-confirmed a flatten and reset grid state;
- `⚠️ D-049 PARTIAL CUT` — 50% de-risk cut confirmed at the −$1,000 ladder layer;
- `🚨 D-049 FULL FLATTEN` — daily flatten confirmed at the −$1,250 layer; trading halted until next 22:00 UTC rollover.

Trade notifications use broker-confirmed fill price, confirmed quantity, ring/lot identity, tranche where applicable, and current MA/target context when safely available. They never expose raw DXtrade payloads, credentials, session tokens, Telegram owner IDs, or arbitrary transport errors.

Notification identities are persisted in PostgreSQL before Telegram delivery. The same durable event is not automatically resent after a retry or restart, which prevents duplicate success messages. If Telegram delivery fails, trading state remains authoritative and the bot does not retry an order or roll back a confirmed fill.

## Safety and execution behavior

The production strategy is `sol-outer-heavy-v1` under **D-049**, using Binance `SOLUSDT` live touches and DXtrade `SOL/USD` account/execution state. Live strategy processing evaluates eligible exits before entries.

The worker keeps each ring fill as a durable virtual lot while the DXtrade account remains netted. If the signed total of virtual SOL inventory no longer reconciles to the broker's net SOL position, new strategy actions fail closed and require owner review.

Automatic strategy orders require both execution controls: Railway `AUTO_EXECUTE=true` and strategy `execution.autoExecute=true`. Railway `AUTO_EXECUTE=true` is accepted only with `APP_MODE=live`. Even with those controls ON, independent account, feed, floor, exposure, **D-049 risk ladder**, pause, safety-halt, and reconciliation gates can still block an order.

The automatic inactivity heartbeat is separate from ring state. If 25 days pass without a confirmed bot trade, it is designed to perform a minimum-size `0.01 SOL` round trip with the project 25-second minimum hold, ahead of the 30-day inactivity deadline, without changing any ring, tranche, or MA state.

## Manual/outside trades on the Tradeify account

The SOL grid does not adopt manual trades into its virtual ring ledger.

- A manual `SOL/USD` position changes the broker net SOL quantity without a matching bot virtual lot. The production reconciliation check therefore blocks strategy activity and can raise a safety halt until the broker position and bot virtual state are reconciled.
- A manual position in another instrument such as `XRP/USD` is treated as a foreign open position. The account monitor marks the account locked for the SOL bot, so new SOL grid actions are blocked while that foreign position is open.
- Realized P&L from manual trading still affects the Tradeify account balance/equity and therefore the account-level daily-loss and maximum-loss protections. It does not create, arm, disarm, or close a SOL ring lot.

For clean autonomous operation, avoid manual trades in the same Tradeify account while the SOL bot is live unless you intentionally intend to stop/reconcile the bot afterward.

## Common corrections

- `Not authorized` — use the configured owner Telegram account. `/whoami` can show the numeric sender ID.
- `The command failed` — check Railway logs; do not repeatedly retry an order-related action when broker state is uncertain.
- `/status` shows `ARMED` — the repository strategy control is ON but the Railway live execution control is still OFF.
- `/status` shows `LIVE` and `Auto-execution: ON` — both controls are enabled; eligible strategy touches may place real orders when every safety gate passes.
- `/rings` or `/levels` says feed unavailable/stale — the command intentionally refuses to calculate from an old live price.
- Canary is blocked — automatic grid execution is already ON, or another safety precondition is blocking it.
- Resume code rejected — run `/resume` again and use the newest six-digit code within 10 minutes.
- Safety halt remains after resume — `/resume` removes only the operator pause. Resolve the stated safety condition first.
- Feed/account data stale — new strategy entries remain blocked until fresh data returns.
- Reconciliation mismatch — confirm the actual DXtrade `SOL/USD` net position before any further strategy action.
- `/code` says the companion is not configured — the production worker was deployed without the Phase 1 queue bridge.
- Development request fails — check the `Tradeify Dev Companion` Railway worker and its OpenAI configuration; the trading runtime is independent of that failure.
