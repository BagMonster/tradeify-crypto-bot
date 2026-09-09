# D-066 — Owner-controlled non-harvest safety-halt countdown

**Status:** Implemented locally; awaiting explicit owner merge approval.

## Decision

The owner rejected automatic non-harvest safety halts as too frequent and too disruptive. A non-harvest condition may therefore create a durable safety halt only after this owner-visible cycle:

1. Warning 1 is sent immediately in the owner Telegram chat.
2. Warnings 2, 3, 4, and 5 follow five minutes apart.
3. The durable stop is eligible only after the fifth five-minute interval: 25 minutes after warning 1.
4. `/pausehalt` does not clear the underlying condition. It restarts that same pending condition at warning 1 and grants another 25-minute cycle.
5. A condition that clears before the deadline clears its pending warning cycle automatically.

Each warning identifies the reason, book where applicable, deadline, and the immediate correction path.

## Exceptions

These remain automatic and do not await owner warning-cycle approval:

- D-064 harvest safety halts, including missing fresh broker account data and unconfirmed harvest flattening;
- the per-book −$600 entry brake.

The +$250 D-064 harvest contract and the 22:00 UTC account-day reset are unchanged.

## Scope

The controller covers non-harvest durable safety-halt sources and the account-wide D-060 full-flatten daily lock. It persists the single account-wide pending cycle in PostgreSQL so a Railway restart does not discard its owner-visible countdown. A 30-second worker timer advances warnings independent of Binance price-tick timing.

## Operator surface

- `/status` displays a pending owner-warning halt when one is active.
- `/pausehalt` restarts the pending condition at warning 1.
- Existing recovery commands (`/harvestrecover`, `/rematch`, `/rerun`) retain their specific duties only after their corresponding halt has actually fired.

## Verification

- Regression tests assert five warnings at five-minute intervals and a hard stop only after the 25-minute cycle.
- Regression tests assert `/pausehalt` restarts the same condition with another 25-minute deadline.
- Regression tests assert recovery removes a pending cycle without firing a halt.
