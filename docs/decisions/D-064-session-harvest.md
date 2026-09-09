# D-064 — Session harvest (payoff grid)

**Status:** DRAFT / not authorized to deploy  
**Branch:** `feat/d064-session-harvest`  
**Worker:** trading worker only (`index.mjs` path). Do not deploy the companion worker for this.  
**Main tip when opened:** `b5dca9e`  
**Do not merge** until the owner’s independent ChatGPT audit passes.

## Intent

Turn the live five-book ring grid into a *payout-shaped* grid for Tradeify consistency:

1. When **combined day P&L** (same figure `/status` already prints) reaches **+$250**, flatten **every** enabled book.
2. After that harvest, **entries stay on**. New risk only on a live ring **touch-cross** (`entryCandidates`).
3. **Tranche exits stay off** until the 22:00 UTC account day rolls (`accountDayKey`, UTC+2 offset).
4. D-063 ladder is unchanged: brake **−$600**/instrument, cuts **10%/−$500**, **20%/−$750**, **50%/−$1,000** on *combined* day P&L, flatten **−$1,250**, daily **−$1,500**.
5. Risk flatten still wins. A −$1,250 day is a risk flatten (`flattenedToday`), which **does** brake entries until rollover. Harvest is not that path.

## What this PR does *not* do

- Does **not** raise `capUsd`. Live books stay **$10,000**. 10× is a later config change (`capUsd: 100000`), not this merge.
- Does **not** enable harvest. `sessionHarvestEnabled` is **false**. Merge + deploy is a no-op for execution.
- Does **not** resize open lots.
- Does **not** use `/reconcile`.
- Does **not** change companion voice.

## Enablement after audit (owner only)

1. Merge this PR. Deploy **trading worker only**. Confirm `/status` shows `harvest: OFF`.
2. Set `accountRisk.sessionHarvestEnabled` to `true` in a follow-up (still `$10,000` cap). Harvest will not fire at today’s ~$28 mark.
3. After a 22:00 UTC rollover, raise `capUsd` to `100000` if 10× new fills are still wanted. Open lots stay 1× until they die or a harvest closes them.

## Flags

| Flag | Meaning |
|---|---|
| `flattenedToday` | Risk flatten. Entries braked until rollover. |
| `harvestedToday` | Quota flatten. Entries **on**, tranche exits **off** until rollover. |
| `brakedToday` | Per-instrument entry brake at −$600 day P&L. |

Harvest fires **once** per `dayKey`. If refill then goes red, there is no second harvest.

## Audit checklist

- Disabled config cannot flatten at +$250.
- Enabled config flattens all books at +$250 and does **not** call `setEntryBrake(true)` for that action.
- After harvest, `nextExitAction` is not executed; `entryCandidates` still run.
- Combined −$1,250 still risk-flattens and brakes entries.
- Unread book is still `ACCOUNT_DATA_UNAVAILABLE`, not a harvest.
- Rollover at 22:00 UTC clears `harvestedToday` and turns tranche exits back on.
- `/status` account block prints harvest state without truncating `telegramBot.js`.
