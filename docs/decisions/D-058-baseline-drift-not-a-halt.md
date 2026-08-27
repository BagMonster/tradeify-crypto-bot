# D-058 — Mid-day D-049 baseline wobble is not a halt

**Status:** APPROVED to build 2026-08-27. The live grid must keep trading through tiny DXtrade day-open drift.

## Why

After a trading-worker restart, DXtrade `previousDayClosingBalance` (balance minus dayClosedPl) was $49,999.83 while the persisted D-049 baseline was $49,999.87. That $0.04 gap is fees from live fills. The old `> $0.01` check latched `D049_BASELINE_MISMATCH` even when virtual net already equalled broker net (−1.37).

## Decision

1. The persisted account-day baseline is the risk reference until the next 22:00 UTC rollover.
2. Mid-day inequality with DXtrade's derived day-open number does not brake, halt, or notify.
3. Worker boot clears only that exact baseline-mismatch halt reason so a deploy unsticks the live book.
4. Real book problems stay: unread net, virtual/broker disagree, foreign instrument, floors, operator pause.

## Deploy

Trading worker only. Then `/status`. If `/kill` is still on, `/resume` + `/confirmresume CODE`. Do not `/reconcile`.
