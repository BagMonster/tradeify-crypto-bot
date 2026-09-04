# D-063 — Tiered cut ladder, $10,000 cap, −$600 per-instrument brake

**Status:** DRAFT — awaiting owner approval. Owner has authorized merge and trading-worker deploy of this draft.
**Extends:** D-060.
**Changes strategy behaviour:** yes — when combined day P&L is cut, and how large future entries can be. Ring distances are unchanged.

## Decision

Replace the single 50% cut at −$1,000 with an ordered ladder. Flatten and the daily loss limit stay where they are.

| Combined account day P&L | Action |
|---|---|
| −$500 | cut 10% of each losing instrument |
| −$750 | cut 20% |
| −$1,000 | cut 50% |
| −$1,250 | full flatten, held until 22:00 UTC rollover |

`config.cutTiers` holds the two shallow rungs. `partialCutUsd` / `partialCutFraction` remain the deepest cut so an absent `cutTiers` array is byte-for-byte the old ladder.

Per-instrument entry brake moves from −$300 to −$600. Cap on every enabled book moves from $6,300 to $10,000. `baseUsd` stays derived. Flatten −$1,250 and daily limit −$1,500 do not change.

No ordering is required between a cut tier and the entry brake. The brake is one book's day P&L; the cut is the combined account. A 10% cut at −$500 before a −$600 brake is intended.

## Why

The old cut re-fires on every evaluation below −$1,000 and therefore cascades, but it starts late. Over 1,323 days the worst day was −$1,153.71, leaving $346.29 versus the $1,500 daily limit.

Shallow early bites use the same cascade earlier:

| | Now | With this change |
|---|---|---|
| Total | $6,423.10 | **$8,616.79** |
| Worst day | −$1,153.71 | **−$812.69** |
| Margin to the $1,500 limit | $346.29 | **$687.31** |
| Breaches | 0 | 0 |
| Full flattens | 0 | 0 |

The 10% tier fired 1,775 times, the 20% tier 8 times, and the 50% tier and flatten never fired.

## Honest limits

- One historical path, 2023-01 to 2026-08. Profit figures move around neighbouring cells. **Margin improvement is the robust finding** — it held across roughly 30 configurations, all with zero breaches and zero flattens.
- Most profit in every configuration was earned before November 2025.
- Tier fractions swept 10%–30% kept margin in $633–$731, so 10% is not a lucky cell.
- $10,000 was chosen over a higher-scoring $12,600 because $12,600's neighbours scored about half as much.

## Open positions

Ring distance is `bandPct × (deadZoneBands + level)`. The cap is not in that formula. Raising the cap only changes `baseUsd` for *future* entries. Existing lots keep quantity and tranche targets (entry price and MA). No flatten, reconcile, or rematch is required.

## Rollback

Set `capUsd` back to 6300, `entryBrakeUsd` back to 300, and delete `cutTiers`. No code revert is required.

## Out of scope

No geometry change. Heartbeat close and the partial-close canary stay open. Flatten and daily-limit dollars stay at 1250 / 1500.
