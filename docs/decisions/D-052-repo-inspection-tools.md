# D-052 — Phase 2c read-only repository inspection

**Status:** APPROVED by owner on 2026-08-26 (build request in Telegram).

## Decision

BMTB1 may inspect `BagMonster/tradeify-crypto-bot` from `/code` using three read-only GitHub tools:

- `list_repo_files`
- `read_repo_file`
- `search_repo_code`

The tools run on the companion worker only. They use `GITHUB_TOKEN` on that worker. They never run on the trading worker.

## Rules

- Owner and repo are hardcoded. Other repositories are rejected.
- Default ref is `main`.
- `.env`, `credentials`, `secrets`, and key/PEM paths are blocked.
- Search queries are rewritten so `repo:` / `org:` / `user:` cannot escape this repository.
- Missing `GITHUB_TOKEN` fails closed with a clear error. The companion still answers without pretending it read GitHub.
- No write, branch, PR, merge, or Railway deploy tool is included.
- No DXtrade client and no trading-state mutation.

Owner confirmation for this phase is the existing owner-only `/code` gate. Per-call confirmation is reserved for Phase 2d writes.

## Deploy

On the `Tradeify Dev Companion` Railway service only:

```text
GITHUB_TOKEN=<fine-grained token, contents:read on BagMonster/tradeify-crypto-bot>
```

Do not add this token to the trading worker.

## Out of scope

- Live body snapshot publisher (D-051)
- Proposal-bound GitHub writes (Phase 2d)
- Orders, halt-clear, merge, deploy
