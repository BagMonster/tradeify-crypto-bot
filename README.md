# Tradeify Crypto Bot

This repository is the Stage A foundation for a Telegram-controlled Tradeify bot.

## Current working features

- One Node.js worker designed for Railway
- Telegram long polling with inline control buttons
- One-user Telegram authorization
- PostgreSQL state that survives restarts
- Persistent pause and confirmed resume flow
- Tradeify dual-floor, daily-control, consistency, and position-sizing logic
- Thirteen automated risk tests
- Automatic execution locked off

## Current safety state

The worker starts only when both of these settings are false:

- Railway variable `AUTO_EXECUTE=false`
- `config/strategy.json` value `execution.autoExecute=false`

The Stage A foundation does not connect to DXtrade, create orders, or expose manual long/short commands.

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

The development-agent addendum is approved future scope only. It begins after the current trading automation roadmap, stability gates, final Telegram command documentation, and a fresh security checkpoint are complete. It does not change Stage A or enable execution.
