# D-049 — SOL grid resize, ring geometry change, and three-layer daily risk ladder

**Status:** APPROVED by the owner; implemented and merged to `main` via PR #37 on 2026-08-25.
**Supersedes:** the sizing, ring-geometry, gross-exposure-ceiling, and heartbeat parameters frozen in D-040 only. Everything else in D-040, D-041, D-045, D-046, D-047, and D-048 stands unchanged.

## Summary

Production SOL grid sizing was raised and ring geometry moved inward after measurement showed the prior formula over-reserved capital relative to realized worst days. A three-layer daily risk ladder was added so the larger size remains structurally protected against the $1,500 daily-loss limit.

## Governing parameters

| Parameter | Prior (D-040) | D-049 |
|---|---|---|
| `deadZoneBands` | 4 (±18%) | 2 (±13.5%) |
| `activeLevelsPerSide` | 8 | 10 |
| Active distances | ±22.5% … ±54% | ±13.5% … ±54% |
| `baseUsd` | 6 | 28.68 |
| `growth` | 1.8 | 1.5 |
| `grossExposureCeilingUsd` | ~1830 | 6600 |
| `heartbeatDays` | 25 (decision) / 30 (stale config) | 25 |

Unchanged: `maDays` 200, `bandPct` 0.045, `positionsPerRing` 2, `rearmBands` 0.5, `lotStep` 0.01, tranche weights 10/20/30/remainder, 0.18% round-trip floor, live-touch exits-before-entries, $1,500 daily-loss protection, account floors, reconciliation, owner pause / safety halt / lockout.

Ring USD size is `baseUsd × growth^(level − 1)` for levels 1…10 (first active ring is still deadZoneBands+1 bands from the MA).

## Risk ladder

Evaluated on live equity **including unrealized** against the previous account day's **closed** balance. Account day rolls at **22:00 UTC**.

| Layer | Threshold | Action |
|---|---|---|
| Entry brake | −$300 | Block new grid entries; exits continue |
| Partial cut | −$1,000 | Close 50% of every open virtual lot (remaining **and** original quantity reduced) |
| Full flatten | −$1,250 | Flatten all, halt trading until next daily rollover |

Protective cut and flatten orders **bypass** `execution.slippageCapPct`. All other integrity controls remain (idempotency, confirmed-fill-only advancement, reconciliation, positionEffect/positionCode, pause/halt/lockout).

A protective order that does not confirm raises a safety halt and an urgent owner alert.

## Research evidence (summary)

Over 712 tradeable days on the verified SOL 5m series: total return rose from about $1,265 to about $4,044; 27-window mean rose substantially with zero breaches on historical data; the ladder fired zero times on the historical path and is justified under stress. Full measurement detail lives in the owner-approved research decision package used to authorize this change.

## Deploy constraints

- Engine constants in `src/strategies/solanaGrid.js` and `config/strategy.json` must stay synchronized.
- State must contain **20** rings (10 per side). Old 16-ring state fails closed until flat re-init or migration.
- Do **not** run D-049 size with `riskLadder.enabled=false`.

## Rollback

Restore D-040 sizing constants and set `riskLadder.enabled` to `false`. Keep `heartbeatDays` at **25**. Never restore heartbeat 30.

## Related code

- `src/risk/dailyRiskLadder.js`
- `src/strategies/solanaGrid.js` (geometry, sizing, protective cut plan)
- `src/runtime/solanaRuntime.js`
- `config/strategy.json`
- PR #37 merge commit on `main`
