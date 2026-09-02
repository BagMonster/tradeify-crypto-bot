# Telegram command reference

**Live books:** SOL/USD, DOGE/USD, ZEC/USD, AAVE/USD, AVAX/USD  
**Operator:** owner Telegram user only  
**Execution:** ON only when `APP_MODE=live` and Railway `AUTO_EXECUTE=true`

Unauthorized users get `Not authorized`. `/whoami` is the exception so the owner can find their numeric id.

Replies longer than 4096 characters are split into `[1/n]` pages. That is normal for `/status` across five books.

---

## Button panel

`/b` (`/buttons`, `/menu`) shows the same commands as tappable buttons.

**Confirm commands have no buttons.** `/confirmresume`, `/confirmreconcile`, and `/confirmrematch` need a typed one-time code plus the instrument name. A button may request a code. Only typing it confirms.

---

## Read commands

Omit the instrument to see every enabled book. Add `SOL`, `DOGE`, `ZEC`, `AAVE`, or `AVAX` (or the full `SOL/USD` form) to see one.

### `/status [INSTRUMENT]`

Account-risk header first (combined day P&L, exposure, ladder, who is braked), then each book:

- strategy id (`sol-ring-grid-v1`, `doge-ring-grid-v1`, …)
- feed and DXtrade instrument
- execution locks and pause/halt
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

Six-digit code, 10 minutes, **one instrument**. Does not resume by itself.

### `/confirmresume CODE INSTRUMENT`

Example: `/confirmresume 123456 SOL`

Lifts the operator pause for that book only. Does not clear a safety halt, stale data, lockout, ladder halt, or execution lock.

### `/reconcile INSTRUMENT`

Use when DXtrade is already flat on that instrument and the virtual notebook still holds lots (manual close, leftover ring `1/2`, and so on).

Refused while DXtrade still shows an open position on that check.

### `/confirmreconcile CODE INSTRUMENT`

Empties virtual lots, rearms rings, writes an audit event, clears a reconciliation halt. **Does not** place a DXtrade order. **Does not** lift the operator pause. Then `/status INSTRUMENT`. If both sides are zero and you want it trading, `/resume` separately.

### `/rematch INSTRUMENT`

Opposite of reconcile. Allowed only while the exact reconciliation-mismatch halt is latched **and** a fresh broker net already matches the virtual net.

Do **not** rematch after a manual flatten. That keeps the stale lot. Use `/reconcile` instead.

### `/confirmrematch CODE INSTRUMENT`

Keeps current virtual lots, clears only that halt, lifts the pause. No broker order.

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
- Rematch refused, books disagree — if the broker is flat, that is a reconcile, not a rematch.
- `braked today: all five` with $0 combined P&L — supervisor could not read a book and fail-closed. Unread ≠ flat.
- Safety halt still on after resume — resume only lifts the pause.
- Canary blocked — automatic execution is ON.
