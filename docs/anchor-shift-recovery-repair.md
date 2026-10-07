# Anchor-shift recovery repair

## Verified failure

Railway deployment `df7c4ff7-8d1a-46b1-9ed4-600b2957ec37` runs main
`08031ea544cfd3880f5f9ac9a190adadd7aaaf21` (PR #139).
At 2026-10-07 10:48:07 UTC and 11:11:07 UTC, its watcher logged:
`Anchor shift confirmation check failed: newMultiplier must be positive`.
The monitor publisher repeatedly logged the same exception as an account DB
sync failure, even though anchor processing precedes that sync.

`computeShift()` returns `multiplier`; the runtime saved its state before
passing that object to a history writer expecting `newMultiplier`. Validation
failed before the history INSERT. The coordinator retained its pending hold;
the watcher retried without a terminal Telegram outcome.

The production integration test also exposed slash characters in anchor
notification event keys. The notification formatter permits no slash, so both
shift-success and excursion alerts could be rejected. Keys now use the existing
alphanumeric order prefix.

## Repair behavior

- Validate the complete state/history pair before any write.
- Acquire one PostgreSQL client and transact the state update and history INSERT.
- Use local SQL/lock timeouts and a client query timeout for this transaction.
- Recheck current fresh account-flat, virtual-flat and no-order-in-flight proof
  before each book, before persistence and before COMMIT.
- Update live memory only after COMMIT. Serialize price processing and shifts
  for each instance so an older excursion save cannot overwrite the shift.
- Keep the existing nine-second hold and strictly later snapshot requirement.
  Missing/stale/unhealthy proof cancels; a 30-second confirmation deadline cancels.
- A write failure stops the automatic retry loop. An explicit entry-only block
  remains, and /status shows the failure. The alert lists completed, failed and
  unprocessed books. Per-book transactions allow partial account completion,
  accurately reported; this is not an account-wide transaction.
- If rollback is confirmed, a new owner recovery command must pass fresh-flat
  verification and another nine-second hold. An uncertain COMMIT outcome refuses
  retry until owner review. Restart is not a reconciliation procedure.
- Failure/cancellation alerts bypass the database claim and ordinary delivery
  queue so a database outage cannot prevent their initial send. They deduplicate
  within the worker, not durably across restarts. Telegram/network failure still
  cannot guarantee delivery; failure state remains visible in /status.
- Audit writes do not prevent terminal completion.

Sizing, exposure-pool decisions, risk tiers, protective cuts/flatten, harvest,
ring calculations, execution enablement and instrument re-enable logic are not
changed. The hold only blocks entries; protective methods are not serialized
behind it. No historical row backfill or anchor schema migration is included.
The existing notification-kind constraint gains ANCHOR_SHIFT_FAILED.

## Existing state-only rows: separate reconciliation

This patch prevents new partial state/history writes. It does not reconstruct
history lost by earlier deployments. ZEC must retain its current multiplier and
cleared excursion and must not be recalculated from the old extreme. AAVE may
also have acquired a state-only row during retries even while its runtime memory
still displayed multiplier 1; do not assume only ZEC is affected.

Live table definitions and rows have NOT been inspected: the connected Railway
OAuth tools expose neither SQL execution nor database credential values.
Before re-enabling execution, inspect all instruments through a read-only
PostgreSQL session, including:

```sql
BEGIN READ ONLY;
SELECT instrument, multiplier, last_shift_at, upper_extreme, lower_extreme,
       upper_boundary_at_extreme, lower_boundary_at_extreme, updated_at
FROM ring_anchor_shift_state ORDER BY instrument;
SELECT shifted_at, instrument, side, extreme, ma_now, old_multiplier, new_multiplier
FROM ring_anchor_shift_history ORDER BY shifted_at DESC, id DESC;
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name IN ('ring_anchor_shift_state', 'ring_anchor_shift_history')
ORDER BY table_name, ordinal_position;
SELECT conrelid::regclass AS relation, conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid IN (to_regclass('ring_anchor_shift_state'),
                   to_regclass('ring_anchor_shift_history'));
ROLLBACK;
```

Any backfill requires separate owner approval, verified original values, and an
idempotent transaction. Do not fabricate an old multiplier, MA, side or extreme
from the rounded Telegram display, rerun the old excursion, or change live
geometry as a substitute for history repair. Keep AUTO_EXECUTE=false pending
that review. The owner merges and deploys manually.

## Validation

`npm install` installs development dependencies; `npm test` runs every test.
The new development-only PGlite dependency runs a local PostgreSQL engine,
including production DDL/SQL, PL/pgSQL rejection triggers and rollback. It does
not access Railway or the funded account. It tests actual Telegram command
routing, owner service, monitor, shared production watcher, D060 runtime,
state/history commit and formatted success/failure delivery.

Coverage includes state/history rejection, old multiplier validation, multiple
books with one failure, stale/missing/repeated snapshots, virtual lots/orders,
confirmation timeout, stalled monitor publication and notification claims,
uncertain COMMIT acknowledgement, concurrent price processing, ZEC preservation,
and flatness revoked between writes and COMMIT. Every broker/execution boundary
is a local test fixture, and order-call counts remain zero.

## Saved-state history reconciliation (follow-up)

The previous non-atomic worker left ZEC (10:40:59.200Z) and AAVE
(11:42:15.734Z) with a saved multiplier and last-shift timestamp but no history.
The owner supplied `/anchors` and `/anchorhistory` evidence confirms this gap;
the old worker overlapped the repaired worker during the deployment. This is
legacy partial state, not evidence that the repaired atomic transaction failed.
No rounded Telegram value is used to reconstruct a shift.

`/anchorreconcile` reads the enabled books' persisted state and checks for a
history or reconciliation record at each exact `last_shift_at`. It previews
missing records without requiring database exports, credentials or manual SQL.
`/anchorreconcile CONFIRM` polls DXtrade and requires automatic execution OFF,
a healthy snapshot no older than six seconds, zero broker positions, no virtual
lots or orders in flight, no active/failed anchor recovery, and matching runtime
and saved anchor multiplier/timestamp. It checks these conditions before writing
and again before committing. The command is owner-authorized using the existing
Telegram authorization wrapper; there is no confirmation button.

A new additive `ring_anchor_shift_reconciliations` table stores exact PostgreSQL
numeric multiplier text, the saved shift timestamp, reconciliation timestamp and
`SAVED_STATE_WITHOUT_HISTORY` provenance. Its primary key is instrument plus
shift timestamp. All affected books are recorded in one bounded transaction,
with their state rows locked in deterministic order and rechecked. Duplicate
requests are idempotent. Existing ordinary shift history is excluded.

The command never updates `ring_anchor_shift_state`, ordinary shift history,
in-memory geometry, excursions, execution flags, entry holds, risk/harvest state
or virtual inventory. It does not shift RUNE or invoke recovery. Original side,
extreme, MA and old multiplier remain unknown. `/anchorhistory` combines ordinary
shifts and explicitly labeled **RECONCILED SAVED STATE** entries, displaying the
latest ten. `/anchors` keeps the ordinary shift count and separately displays
reconciled saved states. Deployment creates the empty additive table; no existing
anchor/history rows are reconciled automatically.

Expected command responses:

- Preview: `ANCHOR HISTORY RECONCILIATION — PREVIEW`, affected instruments, exact
  saved multiplier and shift timestamp, and the typed confirmation instruction.
- Success: `ANCHOR HISTORY RECONCILED`, each recorded instrument/timestamp and
  explicit notice that original details are unknown and geometry is unchanged.
- Safety refusal: `ANCHOR HISTORY RECONCILIATION REFUSED`; no audit writes.
- Persistence/verification failure: `ANCHOR HISTORY RECONCILIATION FAILED`; no
  automatic retry, no anchor changes, inspect preview/history before retrying.
  A lost COMMIT acknowledgement may mean the audit rows committed; the response
  deliberately does not claim rollback certainty. Reinspection avoids duplicates.

After owner merge and deployment, leave `AUTO_EXECUTE=false`. Send the read-only
`/anchorreconcile` preview and review its actual saved values. Separately authorize
`/anchorreconcile CONFIRM` to append the missing audit evidence. Inspect
`/anchorhistory` and `/anchors`. RUNE's pending excursion remains a separate
explicit `/anchorrecover CONFIRM` decision; this follow-up does not authorize it
or re-enabling execution. No manual SQL or fabricated history is required.
