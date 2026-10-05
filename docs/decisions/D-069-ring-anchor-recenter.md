# D-069 — Ring anchor recenter after a confirmed flat account

**Status:** Owner-approved for live validation on 2026-10-05; implementation awaiting PR review and merge.

Every ring-grid instrument begins with an anchor multiplier of `1.0`, preserving
the existing 200-day-MA geometry. Each literal Binance trade beyond an outer
boundary records the furthest upper or lower excursion durably. The excursion
does not move, close, retarget, resize, or otherwise affect open inventory.

Only after DXtrade reports the entire account flat, every virtual book is flat,
and no order is in flight does a shift become eligible. The coordinator holds
new entries for nine seconds and requires multiple healthy flat snapshots. It
then moves each eligible anchor so the first outer ring lands exactly on the
recorded extreme. Later shifts stack in either direction; there is no decay.

The feature does not change ring geometry, sizing, caps, the exposure pool, the
risk ladder, harvest, or flattening. There is no backtest and no kill switch by
owner decision. ZEC is re-enabled as a normal book in this change; there is no
special disabled-to-enabled recenter behavior.
