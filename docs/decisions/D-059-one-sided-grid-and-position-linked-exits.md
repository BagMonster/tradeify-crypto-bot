# D-059 — One-sided grid, position-linked exits, unread book fails closed

**Status:** DRAFT — awaiting owner approval.
**Supersedes:** nothing. **Extends:** D-044, D-049, D-054, D-057.
**Changes strategy behaviour:** yes — see §3. This is material and must be approved before deploy.

---

## 1. Why

Three defects were found on the live SOL grid on 2026-08-31.

### 1.1 Tranche exits opened positions instead of closing them

`solanaExecutionGuard.executeIntent` routed ENTRY and EXIT identically through
`adapter.place(...)`, which calls `client.placeMarketQuantityOrder(...)`, which always
sends `positionEffect: "OPEN"` (D-044). A tranche exit intended to buy back part of a
short instead opened a **new long ticket** and left the short untouched.

`actionType` was passed to the adapter but only ever reached the persistence ledger. The
adapter never branched on it.

### 1.2 The defect was invisible to reconciliation

D-057 made signed broker net the **sum** of all SOL/USD tickets, and reconciliation
compares virtual net to that sum. A 0.44 short plus a bug-created 0.02 long nets to
−0.42 — the same figure the virtual book holds after recording a 0.02 tranche exit.

**Net-based reconciliation cannot detect a hedge.** No halt fired. The account can hold
simultaneous long and short SOL tickets — prohibited by Tradeify and grounds for
termination — while every existing invariant reports healthy.

### 1.3 The D-049 ladder was disabled by the state that requires it

`resolveSingleSolPosition()` threw unless exactly one SOL position existed. Both
`executeProtectiveCut` and `executeProtectiveFlatten` called it first. With multiple
tickets open — the normal book under D-057 — the −$1,000 cut and −$1,250 flatten threw
before placing any order.

---

## 2. Decision — execution

1. **EXIT intents close against broker tickets.** An exit resolves live SOL/USD positions
   on the virtual lot's own side and closes by `positionCode`:
   - quantity equal to the whole ticket → `placePositionClose` (canary-verified path)
   - smaller → `placePositionPartialClose` (`positionEffect: CLOSE` + `positionCode` + quantity)
2. **ENTRY intents are unchanged** and still use `positionEffect: "OPEN"`.
3. **Exits fail closed.** No matching-side ticket, or a tranche larger than the open
   same-side quantity, returns `BLOCKED` and sends nothing.
4. **The ladder acts on every ticket.** `resolveSingleSolPosition()` is replaced by a
   multi-ticket reader. Flatten closes each ticket individually with its own
   `positionCode`; cut distributes the requested quantity proportionally across
   same-side tickets, floored to 0.01 SOL, remainder to the largest headroom.
5. **Flatten verifies.** After all legs report FILLED, positions are re-read. Anything
   remaining returns `NOT_FLAT`. An unreadable verification read returns `NOT_VERIFIED`.
   All legs reporting FILLED is not evidence the account is flat.
6. **Per-leg order codes** are `{baseCode}-{sha256(positionCode).slice(0,12)}` — stable
   across retries and restarts, stable when other legs have already closed, and fixed
   length so no derived code can exceed the 64-character limit.

## 3. Decision — strategy (MATERIAL)

7. **One direction at a time.** An ENTRY is refused whenever any opposing-side SOL
   ticket is open. `sol-outer-heavy-v1` becomes one-sided-at-a-time.

**This changes the strategy that was measured.** D-040 and D-049 numbers — $1,264.74
baseline and $4,043.62 at D-048 sizing — came from a two-sided grid where BUY and SHORT
lots could be open together. Under this rule, SHORT rings are blocked while any BUY lot
remains open and vice versa. Lots close over four tranches with the final tranche at the
MA, so a lot opened at −45% can block the opposite side for a long period.

**Consequence not yet measured:** during the Sept 2025 – Feb 2026 collapse, shorts above
the MA contributed materially. If this rule locks them out during that move, the risk
profile changes. **A one-sided re-run of `ring-grid-core.mjs` over the same 712 days is
required before this configuration is trusted, and is not a precondition for deploying
§2 or §4.**

Rationale for accepting it anyway: multiple same-side tickets are permitted (D-057), so
per-ticket closing under §2 is compliant only while the book is one-sided. §2 without §7
would leave the account able to hold both sides. The two ship together or not at all.

`buildProtectiveCutPlan` already throws *"D-049 protective partial cut requires all open
virtual lots to share one side"* — the D-049 ladder was written assuming one-sidedness.
§7 brings the strategy in line with a constraint the safety layer already enforces.

## 4. Decision — unread book (extends D-054)

8. Every position read inside the guard returns a result object, never throws. A failed
   read or an invalid payload returns `ACCOUNT_DATA_UNAVAILABLE`, emits an ERROR event,
   and places no order. An unread book is not a flat book and is not a mismatch.

---

## 5. Not in scope

- **`solanaHeartbeat.js` still calls `adapter.place({ actionType: "HEARTBEAT_CLOSE" })`**
  and will OPEN rather than close. The 25-day inactivity heartbeat opens a long then
  opens a short. 0.01 SOL, leaves a stray ticket each cycle. Separate change.
- **`placePositionPartialClose` remains broker-unvalidated.** Most tranche exits now use
  it. A live partial-close canary is required before auto-execution is re-enabled.
- **Binding each virtual lot to a `positionCode` at entry** (the D-057 deferred item).
  Exits resolve tickets by side at exit time rather than by stored id.
- **Multi-asset.** `instrumentProfile.js` supports BTC/USD and SOL/USD only.

## 6. Files

- `src/execution/solanaExecutionGuard.js` — full replacement
- `tests/solanaProductionPath.test.mjs` — expectation updates only
- `tests/solanaExitClosePath.test.mjs` — new

## 7. Deploy

`/kill` before the trading-worker deploy. Do not `/reconcile` while SHORT2 is open.
Confirm `/status` shows virtual net equal to summed broker net, no lockout, SHORT2
intact. Auto-execution stays off until the partial-close canary has run.

## 8. Rollback

Revert `src/execution/solanaExecutionGuard.js` to blob
`3ead09e5e6ebe28d1def77352d59362cd78feec7` and redeploy the trading worker. That restores
the two-sided grid **and both defects**, including a non-functional D-049 ladder whenever
more than one ticket is open. Rollback is only appropriate if the one-sided rule causes a
worse problem than the exit defect.
