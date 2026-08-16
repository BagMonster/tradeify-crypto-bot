# Tradeify Crypto Bot

This repository is the Stage A foundation for a Telegram-controlled Tradeify bot.

## Current working features

- One Node.js worker designed for Railway
- Telegram long polling with inline control buttons
- One-user Telegram authorization
- PostgreSQL state that survives restarts
- Persistent pause and confirmed resume flow
- Tradeify dual-floor, daily-control, consistency, and position-sizing logic
- Read-only DXtrade discovery client with no order methods
- Completed, source-tagged PostgreSQL bar storage
- Idempotent 12-month Binance `BTCUSDT` historical backfill for `15m`, `4h`, and `1d`
- Deterministic Bollinger, RSI, ATR, and ADX calculations with fail-closed warm-up checks
- Deterministic Bollinger/RSI candidate evaluation with fail-closed regime checks
- Simulation-only Telegram signal-alert formatting with sanitized audit evidence
- Automated risk, read-only-client, storage, backfill, indicator, signal, and alert tests
- Automatic execution locked off

## Current safety state

The worker starts only when both of these settings are false:

- Railway variable `AUTO_EXECUTE=false`
- `config/strategy.json` value `execution.autoExecute=false`

Stage A exposes no DXtrade order, modification, cancellation, close-position, or flatten method. Binance is public historical data only and cannot place or control Tradeify trades. A calculated signal candidate or simulation alert does not make the live feed fresh, persist regime permission, bypass the shared risk gate, or authorize an order or position. Exact DXtrade size remains blocked until instrument lot rules are verified. The bot does not create orders or expose manual long/short commands.

The Chapter 25 alert publisher is a tested capability and is not called by the current worker. Live owner alerts begin only after a later chapter supplies a fresh validated feed and controlled evaluation loop; this checkpoint sends no production alert and places no order.

## Railway start command

```text
npm start
```

## Telegram commands

```text
/status
/health
/kill
/resume
/confirmresume CODE
/flat
/whoami
/help
```

Use the project build manual for the exact GitHub, Railway, PostgreSQL, and Telegram setup sequence.

## Project governance and future roadmap

- [Implementation decision log](docs/implementation-decision-log.md)
- [Post-Automation Addendum A - Owner-Only OpenAI Development Agent](docs/post-automation-development-agent-addendum.md)
- [DXtrade API endpoint reference](docs/dxtrade-api-endpoint-reference.md) - research-only survey of the DXtrade Developer Portal (REST + Push APIs); read this before any future DXtrade credential, authentication, client, session, or order-routing work, which remains gated behind the D-004 Codex Security checkpoint and the appropriate approved chapter.

The development-agent addendum is approved future scope only. It begins after the current trading automation roadmap, stability gates, final Telegram command documentation, and a fresh security checkpoint are complete. It does not change Stage A or enable execution.
