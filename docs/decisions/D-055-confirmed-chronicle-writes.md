# D-055 — Owner-confirmed chronicle writes

**Status:** APPROVED by owner 2026-08-26 as Phase 2d for `docs/chronicle/**` only.  
**Does not change:** D-049 geometry, D-050 reconcile, D-053 rematch, D-054 unread handling, live trading, or companion merge/deploy authority.

## Decision

BMTB1 may propose Markdown under `docs/chronicle/**`. Every GitHub mutation stays owner-confirmed.

1. `GITHUB_TOKEN` lives on the companion worker only. Least privilege: contents read/write and pull requests read/write on `BagMonster/tradeify-crypto-bot`.
2. `propose_chronicle_write` stores an exact proposal in PostgreSQL (`ai_chronicle_proposals`): base SHA, branch, files, content hashes, commit message, PR title/body, expiry, audit state. Proposal creation performs no GitHub write except reading `main`.
3. Owner Telegram:
   - `/approvewrite PROPOSAL_ID` issues a six-digit code.
   - `/confirmwrite PROPOSAL_ID CODE` marks that exact proposal confirmed.
   - Challenge hash is `${salt}:github-write:${proposalId}:${code}`.
4. Only the companion worker executes confirmed proposals. Before writing it re-reads `main` and requires that SHA to equal the proposal base SHA. Drift fails closed.
5. Branches must use `docs/bmtb1/`. One commit. Open a PR. Never merge automatically. Never write `main`.
6. Execution is idempotent. A retry reuses an existing branch/PR instead of duplicating work.
7. Path traversal, symlink/parent segments, binary, file-size, total-size, secret-pattern, unauthorized user, wrong code, expired code, base drift, duplicate execution, and GitHub API failure all fail closed.
8. The owner receives a short audit result and PR URL. Credentials stay out of chat and model context.

## Out of scope

- Direct writes to `main`
- Merge, deploy, branch delete, force-push
- Production code, strategy config, workflows, `.env`, secrets
- D-051 live snapshot publisher
