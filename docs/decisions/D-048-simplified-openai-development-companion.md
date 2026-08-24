# D-048 — Simplified OpenAI development companion roadmap

**Status:** APPROVED by owner on 2026-08-24.

## Decision

The owner supersedes the bulky pre-implementation sequencing in Post-Automation Addendum A and authorizes immediate work on the OpenAI development companion.

The user experience remains inside the existing owner-only Telegram bot. The existing Tradeify worker remains the sole Telegram polling process. OpenAI conversation work runs in one separate Railway companion worker connected through a PostgreSQL-backed development job boundary.

## Phase 1

Phase 1 is conversational/read-only:

- `/code` enters owner-only development conversation mode in the existing Telegram bot;
- `/devexit` leaves development conversation mode;
- `/devreset` starts a fresh OpenAI conversation while remaining in development mode;
- `/devstatus` reports the development session and queue state;
- ordinary owner text while `/code` mode is active is queued to the separate companion worker;
- the companion worker calls the OpenAI Responses API and returns its answer through the existing Telegram bot;
- conversation continuity is persisted so Railway restarts do not silently discard the development session;
- the companion worker has no DXtrade credentials, no order-placement capability, no trading tools, and no authority to mutate production trading state;
- the OpenAI API key belongs only to the companion worker and is never placed in source, Telegram messages, logs, or the trading worker environment.

Phase 1 does not require the previously planned broad security program. Verification is focused on the behavior actually being added: owner authorization, development-mode routing, queue/restart behavior, OpenAI failure handling, and isolation from trading execution.

## Future write-capable phase

Phase 1 must intentionally leave room for the same Telegram development conversation to become write-capable later.

A later owner-approved phase may add GitHub repository inspection and proposal-bound GitHub writes after the owner and OpenAI companion discuss and confirm the agreed work. The intended future flow is conversation -> investigate -> propose changes -> owner confirms agreed scope -> isolated branch changes -> tests/checks -> report/PR -> later merge policy.

Phase 1 must therefore use a development-tool boundary that can later distinguish read capabilities from approved write capabilities without replacing the Telegram/OpenAI conversation architecture.

No GitHub write capability, automatic merge, or deployment-control capability is enabled by D-048 itself.

## Preserved constraints

D-048 changes development-agent sequencing only. It does not change `sol-outer-heavy-v1`, SOL ring geometry, sizing, risk/account protections, DXtrade execution semantics, reconciliation, protective flatten behavior, Telegram owner authorization, or the production trading worker's sole-poller architecture.
