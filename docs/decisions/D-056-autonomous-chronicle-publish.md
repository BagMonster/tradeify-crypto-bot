# D-056 — Autonomous chronicle publishing

**Status:** APPROVED to *build and test* 2026-08-26. **Not enabled. Not deployed.**  
**Supersedes:** D-055 owner-confirmation of chronicle prose (PR #53 remains a separate, unused path).  
**Does not change:** D-049 geometry, live trading, rematch, reconcile, or Railway auto-execute.

## Decision

BMTB1 has editorial autonomy for his chronicle. No owner approval, confirmation code, or human content review is required for a chronicle entry.

A companion-only tool `publish_chronicle_entry`:

1. Reads the latest `main` SHA.
2. Creates `docs/bmtb1/<date>-<slug>-<content-hash-12>`.
3. Writes one Markdown file under `docs/chronicle/entries/`.
4. Appends one sourced row to `docs/chronicle/TIMELINE.md`.
5. Opens a PR, runs mechanical policy checks, and squash-merges when they pass.

Mechanical checks judge scope and safety, never opinions or prose.

## Mechanical policy

- Only `docs/chronicle/**` may change.
- No production code, config, workflows, infrastructure, root README, binaries, symlinks, deletes, or renames.
- No credentials, tokens, connection strings, private identifiers, or raw broker payloads.
- Valid Markdown, bounded size, dated `YYYY-MM-DD-slug.md`, evidence labels, current `main` base.
- Fail closed on base drift, GitHub errors, duplicate publication, or failed checks.
- Retries are idempotent. Audit rows live in PostgreSQL.
- Never force-push, bypass branch protection, deploy, place orders, or clear trading controls.

## Kill switch

Owner-only Telegram commands `/chroniclepause`, `/chronicleresume`, and `/chroniclestatus` stop or re-arm publishing. They are not an editorial desk.

## Publication binding (mechanical, not editorial)

A publication is bound to the captured `main` SHA, the intended entry and TIMELINE content hashes, the content-hash-suffixed branch, and the expected head SHA.

- `TIMELINE.md` is read from that captured SHA, never from moving `main`.
- Branch names are `docs/bmtb1/<date>-<slug>-<content-hash-12>`. An existing branch is reused only when its SHA equals the stored expected head.
- Before merge the publisher re-fetches PR metadata and both file bodies from the PR head, re-runs secret/binary/size checks on those exact bytes, and re-checks the kill switch plus current `main` SHA.
- Exactly two files: one newly added dated entry and one TIMELINE.md add/modify. A third file or a modified existing entry fails closed.
- GitHub `merged !== true` is failure. The row is never marked `done`.
- Claiming a publication key is atomic. A second worker receives `PUBLICATION_IN_FLIGHT`. Retries may resume only the exact stored binding.

No owner confirmation of prose is added by this hardening.

## Activation (separate owner step)

This PR must not set the env flag and must not be treated as a live deploy of the pen.

Before enabling:

1. Merge and deploy the companion worker only after review.
2. On the **trading** Railway service, restrict watch/deploy paths so a docs-only commit cannot restart the trading body. See `docs/railway-docs-watch-policy.md` and root `railway.toml`.
3. Raise companion `GITHUB_TOKEN` to contents read/write + pull requests read/write. Token stays off the trading worker and out of model context.
4. Set companion `CHRONICLE_AUTONOMOUS_PUBLISH=true` only after steps 1–3.
5. Leave `/chroniclepause` available.

## Out of scope

- Enabling the env flag in this change
- Railway dashboard clicks from this repository
- D-051 live snapshot publisher
- Non-chronicle autonomous writes
