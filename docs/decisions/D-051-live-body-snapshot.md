# D-051 — Live body snapshot for BMTB1

**Status:** APPROVED by the owner 2026-08-26 as Phase 2a + 2b.
**Does not change:** D-049 geometry, D-050 reconcile, D-045 activation, or companion write authority.

## Why

Phase 1 made BMTB1 conversational, but live account facts still depended on the owner running `/status` and latching the paste. After the D-050 halt was cleared, the companion could be given sanitized telemetry without DXtrade credentials.

## Decision

1. The production trading worker writes one sanitized row to `sol_companion_live_snapshot` every 15 seconds and again whenever `/status` runs.
2. The companion worker reads that row on every `/code` job and prepends `LIVE BODY SNAPSHOT` plus a `DIAGNOSIS` block.
3. If the snapshot shows pause, safety halt, account lock, stale data, or virtual≠broker, the companion must lead with that and name the next owner command.
4. The snapshot contains only numbers, booleans, ring tags, and the existing operator-facing halt reason. No credentials, URLs, tokens, or raw DXtrade payloads.
5. Companion still cannot place orders, clear a halt, merge GitHub, or deploy Railway.

## Out of this decision

Phase 2c (repo read tools) and Phase 2d (proposal-bound GitHub writes) stay later. This slice is read-only telemetry.

## Related code

- `src/devCompanionLiveSnapshot.js`
- `src/devCompanionStore.js`
- `src/solanaTradeifyService.js` (`captureLiveSnapshot`)
- `index.mjs`
- `dev-companion.mjs`
