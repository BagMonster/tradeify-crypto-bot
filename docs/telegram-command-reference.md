# Telegram command reference

**Live books:** SOL/USD, DOGE/USD, INJ/USD, AAVE/USD, AVAX/USD
**Operator:** owner Telegram user only  
**Execution:** ON only when `APP_MODE=live` and Railway `AUTO_EXECUTE=true`

Unauthorized users get `Not authorized`. `/whoami` is the exception so the owner can find their numeric id.

Replies longer than 4096 characters are split into `[1/n]` pages. That is normal for `/status` across five books.

---

## Button panel

`/b` (`/buttons`, `/menu`) shows the same commands as tappable buttons.

**Confirm commands have no buttons.** `/confirmresume`, `/confirmreconcile`, `/confirmrematch`, `/confirmharvestrecover`, and `/confirmrerun` need a typed one-time code. A button may request a code. Only typing it confirms.

---

## Read commands

Omit the instrument to see every enabled book. Add `SOL`, `DOGE`, `INJ`, `AAVE`, or `AVAX` (or the full `SOL/USD` form) to see one.

### `/status [INSTRUMENT]`

Account-risk header first (combined day P&L, exposure, ladder, who is braked), then each book:

- strategy id (`sol-ring-grid-v1`, `doge-ring-grid-v1`, …)
- feed and DXtrade instrument
- execution locks and pause/halt
- D-064 harvest state (`READY`, `PENDING`, `CONFIRMED`, or `HALTED`) and whether ordinary tranche exits are enabled
- geometry and cap
- 200-day MA
- virtual net, virtual exposure, open lots, occupied/armed rings, state version
- that instrument’s DXtrade net and freshness

Does not place an order.

### `/health [INSTRUMENT]`

Worker, PostgreSQL, MA provider, execution state, broker freshness.

### `/levels [INSTRUMENT]`

That book’s BUY and SHORT rings: trigger vs current MA, USD size, estimated units, `ARMED` / `DISARMED` / `FULL`.

### `/rings [INSTRUMENT]`

Where live price sits versus the MA: dead zone, BUY zone, or SHORT zone.

### `/dxpreflight`

Reads DXtrade instrument settings. Does not place an order.

### `/solcanary`

Lifecycle canary. Blocked while automatic execution is ON.

### `/flat [INSTRUMENT]`

Manual flattening instructions. Informational. Protective flatten is the risk supervisor, not this command.

---

## Control commands

### `/kill`

Pauses **every** instrument. Survives a Railway restart. Blocks new entries. Protective actions can still run.

### `/resume INSTRUMENT`

Six-digit code, 10 minutes, **one instrument**.

### `/confirmresume CODE INSTRUMENT`

Example: `/confirmresume 123456 SOL`

Lifts the operator pause for that book only. Does not clear a safety halt, stale data, lockout, ladder halt, or execution lock.

### `/reconcile INSTRUMENT`

Use when DXtrade is already flat on that instrument and the virtual notebook still holds lots (manual close, leftover ring `1/2`, and so on).

Refused while DXtrade still shows an open position on that check.

### `/confirmreconcile CODE INSTRUMENT`

Empties virtual lots, rearms rings, writes an audit event. **Does not** place a DXtrade order. **Does not** lift the operator pause.

### `/harvestrecover`

Account-wide D-064 recovery for one case only: the harvest is halted because its initial fresh broker-account read was unavailable. It first reads every enabled book and refuses unless every virtual net matches a fresh DXtrade net. A failed harvest flatten, a different safety halt, unread broker data, or any mismatch remains blocked.

### `/confirmharvestrecover CODE`

Repeats the all-book reconciliation and fresh account-data checks, then clears only the same D-064 fresh-data halt. It does not change virtual lots, place or cancel a DXtrade order, or lift the operator pause. If fresh account-day P&L is at least the harvest threshold, normal D-064 harvesting immediately resumes.

### `/rematch INSTRUMENT`

Allowed while a reconciliation-mismatch safety halt is latched **and** a fresh broker net already matches the virtual net. That includes:

- the original SOL sentence (`SOL virtual-lot state does not reconcile to the DXtrade net SOL position; owner review required`)
- the D-060 15-minute sentence (`INJ/USD virtual-lot state does not reconcile to the DXtrade net position after 15 minutes; owner review required`)

Do **not** rematch after a manual flatten if virtual lots still exist. That keeps the stale lot. Use `/reconcile` instead. If both sides are already zero, rematch is the clear path.

### `/confirmrematch CODE INSTRUMENT`

Keeps current virtual lots, clears that halt, lifts the pause. No broker order.

### `/re-run`

Account-wide. Allowed only while the latched halt is a production runtime error (`…production runtime error; owner review required`) **and** every enabled book already matches a fresh DXtrade net.

Does **not** change virtual lots. Does **not** place an order. Does **not** lift an operator pause. `/rerun` is the same command.

### `/confirmrerun CODE`

Example: `/confirmrerun 123456`

Clears that runtime halt only. Then `/status`. Bot should read RUNNING unless `/kill` is also on.

---

## Chronicle and companion

### `/chroniclestatus` `/chroniclepause` `/chronicleresume`

Kill switch for autonomous chronicle publishing. Publishing also needs `CHRONICLE_AUTONOMOUS_PUBLISH=true` on the companion worker. Off by default.

### `/code` `/devstatus` `/devreset` `/devexit`

Owner-only development conversation. Processing runs on the companion worker. It cannot place, modify, or close trades from this chat.

### `/whoami`

Numeric Telegram user id. No owner gate.

### `/help`

Command list plus the button panel.

---

## Automatic notifications

Broker-confirmed or durable safety events only (D-047 / D-049 / D-060):

- grid entry, tranche exit, lot closed
- heartbeat completed (if that path ever confirms both legs)
- reconciliation mismatch, account lockout, runtime safety halt
- protective cut / flatten

Telegram failure cannot undo a fill or delay a protective action.

---

## Common corrections

- `message is too long` on an old worker — upgrade past PR #65, or use `/status SOL`.
- Five identical SOL templates — upgrade past PR #66.
- `Not authorized` — wrong Telegram account; `/whoami`.
- `/resume` without a name — `Specify an instrument`.
- Reconcile refused, broker open — flatten DXtrade first.
- Rematch refused, books disagree — if the broker is flat and virtual lots remain, that is a reconcile, not a rematch.
- Rematch refused on the 15-minute halt — deploy the rematch-15m-halt fix, then `/rematch` the named book.
- `braked today: all five` with $0 combined P&L — supervisor could not read a book and fail-closed. Unread ≠ flat.
- Safety halt still on after resume — resume only lifts the pause. A leftover runtime-error halt is `/re-run` when every book already matches.
- Canary blocked — automatic execution is ON.
