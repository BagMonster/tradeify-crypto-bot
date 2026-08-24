# OpenAI Development Companion — Phase 1

Phase 1 adds a read-only OpenAI development conversation inside the existing owner-only Telegram bot while keeping OpenAI processing in one separate Railway worker.

## Runtime layout

- Existing Tradeify production worker: remains the only Telegram polling process and continues all SOL trading/account responsibilities.
- `Tradeify Dev Companion` Railway worker: processes development jobs from PostgreSQL and calls the OpenAI Responses API.
- Railway PostgreSQL: carries `ai_dev_sessions` and `ai_dev_jobs` between the two workers.

The companion worker does not start Telegram polling and does not load the DXtrade/trading configuration.

## Telegram commands

- `/code` — enter development conversation mode.
- `/devstatus` — show current development session and queue status.
- `/devreset` — clear the persisted OpenAI response context and remain in development mode.
- `/devexit` — leave development mode.

While development mode is active, ordinary owner text is queued to the companion. Slash commands remain normal Tradeify commands and are not sent to OpenAI.

## Railway companion service

Recommended service name:

`Tradeify Dev Companion`

Connect it to the same `BagMonster/tradeify-crypto-bot` repository and `main` branch after the Phase 1 pull request is merged.

Start command:

```text
npm run start:dev-companion
```

Required variables on the companion worker only:

```text
DATABASE_URL=<Railway PostgreSQL reference>
DATABASE_SSL=false
OPENAI_API_KEY=<OpenAI project API key>
```

Optional:

```text
OPENAI_MODEL=gpt-5.6
```

Do not add `TELEGRAM_BOT_TOKEN` or any DXtrade credential to the companion worker. The production Tradeify worker already owns Telegram polling and DXtrade execution.

## Phase 1 boundary

The companion can converse with the owner and maintain conversation continuity. It has no GitHub write tool, no merge/deploy capability, no DXtrade client, and no trading-state mutation capability.

The queue/tool boundary is intentionally reusable so a later owner-approved phase can add repository inspection and proposal-bound GitHub writes without replacing the Telegram conversation architecture.
