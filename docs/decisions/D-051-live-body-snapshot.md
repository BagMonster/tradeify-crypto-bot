# D-051 — Live body snapshot for BMTB1

**Status:** APPROVED by the owner 2026-08-26 as Phase 2a + 2b. **Not implemented on `main` as of 9438cf73.**
**Does not change:** D-049 geometry, D-050 reconcile, D-053 rematch, D-054 unread handling, D-045 activation, or companion write authority.

## Why

Phase 1 made BMTB1 conversational, but live account facts still depend on the owner running `/status` and latching the paste. After D-054 the books already match. The companion can be given sanitized telemetry without DXtrade credentials.

## Decision

1. The production trading worker writes one sanitized row to `sol_companion_live_snapshot` every 15 seconds and again whenever `/status` (and `/health` if it already polls the monitor) runs.
2. The companion worker reads that row on every `/code` job and prepends `LIVE BODY SNAPSHOT` plus a `DIAGNOSIS` block.
3. Broker net in the snapshot must come from `trustedSignedNet()`. Unread stays `null`. Never coerce missing data to `0`. Never use unsigned `instrumentPosition.quantity` as net.
4. Diagnosis must distinguish:
   - broker net unread / `ACCOUNT_DATA_UNAVAILABLE` — not a mismatch; do not recommend `/reconcile`;
   - finite nets disagree — owner review; if the exact recon halt is latched and nets now agree, `/rematch` then `/confirmrematch CODE`;
   - DXtrade actually flat + leftover virtual lots — `/reconcile` then `/confirmreconcile CODE`;
   - an open short such as SHORT2 — never `/reconcile`.
5. If the snapshot shows pause, safety halt, account lock, stale data, or a true finite mismatch, the companion must lead with that and name the next owner command by slash name.
6. The snapshot contains only numbers, booleans, ring tags, and the existing operator-facing halt reason. No credentials, URLs, tokens, owner IDs, or raw DXtrade payloads.
7. Companion still cannot place orders, clear a halt, merge GitHub, or deploy Railway.

## Implementation constraint

Stale PR #47 (`feature/d051-live-body-snapshot` @ `797caa98`) was branched off D-050 and does **not** include D-052 GitHub tools, the publisher in `index.mjs`, `trustedSignedNet()`, or rematch/unread diagnosis. Do not squash-merge it onto current `main`. Recreate the slice on `9438cf73` or a descendant. Keep helper/test files if useful; rewrite capture net and diagnosis; keep D-052 `createGithubInspector` + `runCompanionToolLoop`.

Deploy trading worker first, companion second.

## Out of this decision

Phase 2d (proposal-bound GitHub writes) stays later. This slice is read-only telemetry plus halt-first diagnosis.

## Related code (intended)

- `src/devCompanionLiveSnapshot.js`
- `src/solanaLiveSnapshotCapture.js`
- `src/devCompanionStore.js`
- `src/account/dxtradeSignedNet.js`
- `index.mjs` (publisher on trading worker only)
- `dev-companion.mjs`
