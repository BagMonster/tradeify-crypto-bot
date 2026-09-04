# Live context for BMTB1

This is the deployed body as of D-062 / D-063. Prefer this over `config/strategy.json` and D-049.

## Five books

SOL, DOGE, INJ, AAVE, AVAX. ZEC is not enabled. Cap $10,000 each. Anchor is the 200-day SMA of completed UTC daily closes.

Exits are four tranches (weights 1/2/3/4) toward the live MA, closed by `positionCode` on the same side. Entries are OPEN and one-sided per instrument.

## Account ladder (combined day P&L, rollover 22:00 UTC)

- Brake −$600 on that instrument only
- Cut 10% of losers at −$500, 20% at −$750, 50% at −$1,000
- Flatten all books at −$1,250 until rollover
- Daily loss limit $1,500

## How to answer "what just happened"

1. Read SNAPSHOT `/alerts` first. Those texts are the live fill and warning tape.
2. Then `/status` if present. Virtual net matching DXtrade means the book is healthy.
3. Do not list the repository tree. Do not open with GitHub tools unless the owner asked about code.
4. A TRANCHE EXIT then NET MISMATCH WARNING 1/3 on the same second is usually the broker snapshot lagging one fill. Virtual already moved. Other books keep running. Do not tell the owner to `/reconcile` unless DXtrade is flat and virtual lots remain.
5. Warning 1/3 / 2/3 / 3/3 are the 5-minute recon tape. Halt is only after 15 minutes of a still-disagreed book.
