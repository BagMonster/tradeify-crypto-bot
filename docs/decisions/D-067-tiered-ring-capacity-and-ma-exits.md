# D-067 — Tiered ring capacity, profit-first entry gates, and MA final exits

**Status:** APPROVED for live deployment on `main`.

## Scope

All five live instruments use a hard **$200,000 maximum gross exposure on one active side**. BUY and SELL ladders retain identical geometry and sizing, but a coin may never carry both directional books at once.

Existing named ring lots are preserved at their original quantities and exit schedules. They count immediately against the new tier capacity. A legacy inner ring that already has two lots is not resized or closed, but may not receive another entry.

## Tiered capacity

- SOL/USD: levels 1–5 have one active lot each; levels 6–10 have two active lots each.
- DOGE/USD, INJ/USD, AAVE/USD, and AVAX/USD: levels 1–6 have one active lot each; levels 7–12 have two active lots each.
- A two-lot ring opens sequentially. Its first fill must satisfy the existing 0.5-band re-arm rule before a second fill can occur.
- A partial normal tranche exit does not free a lot slot. Only a full lot closure frees capacity.
- The existing outer-heavy 1.5 growth curve remains. Base size is recalculated so every permitted lot on one fully built side totals exactly $200,000.

## Profit-first entry gates

For a candidate ring on one side of a coin:

- An inner one-lot ring is blocked by every deeper active lot on that same side until each such lot has a broker-confirmed, bot-executed normal tranche exit.
- An outer two-lot ring is blocked by active same-side lots beginning two levels deeper and continuing outward. The immediately deeper level does not control it.
- The release belongs to an individual lot, not permanently to its ring. A later re-entry at the deeper ring must complete its own normal tranche exit before it releases nearer entries.
- A skipped sub-lot tranche, manual reduction, protective cut, protective flatten, and harvest action do not create a release.
- If an eligible deeper normal tranche exit and a nearer entry occur on one update, execute the exit and skip the entry. A later fresh crossing is required for that entry.

Example: DOGE BUY7 ignores BUY8 for the two-level gate. BUY9 and BUY10 control BUY7. If BUY9 is absent but BUY10 is active without a normal tranche exit, BUY7 cannot arm or re-arm.

## One-sided and hybrid behavior

- Any open BUY inventory blocks new SELL entries for that instrument, and vice versa.
- An adopted/manual position is exit-only: the bot manages its exits but never adds to that manual lot. Normal same-side ring entries may still occur under their ordinary capacity and profit-first gates. Manual inventory blocks opposite-side entries until it is closed.
- The moving average is a final-exit boundary. On the first live update at or beyond the MA, the bot closes all remaining bot-managed or adopted inventory on that side. It does not open the opposite side on that update.
- The confirmed harvest gate is absolute: while it pauses exits, it also prevents the moving-average final exit. The position remains until the account-day reset re-enables exits.

## Regression coverage

`tests/d067TieredRingStrategy.test.mjs` covers tier sizing, migration capacity, inner and two-level gates, broker-confirmed release semantics, manual and opposite-side entry blocking, moving-average exits, and harvest priority.
