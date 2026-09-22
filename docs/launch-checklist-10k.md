# $10K launch checklist

The order matters. Every step is there for a reason, and the switch-over (Part B) is
arranged so **the bot cannot place a trade until you have checked everything and
turned trading on yourself.**

Tick each box as you go. If anything does not match what is written here, stop, set
`AUTO_EXECUTE=false`, and investigate before continuing.

---

## Part A — Before buying the account

These run against the closed $50K account, which cannot trade, so they are risk-free.

### A1. Create the deadman watcher service

The watcher code is merged, but **nothing is watching the bot until this service exists.**

- [ ] Railway → project **Tradeify Crypto Bot** → **New** → **GitHub Repo** → same repo. Name it `deadman`.
- [ ] `deadman` → **Settings** → **Config file path**: `/watchdog/railway.toml`
- [ ] `deadman` → **Variables**: add reference variables pointing at the trading worker's values:
      `DATABASE_URL`, `DATABASE_SSL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_ID`
- [ ] At healthchecks.io create a free check (**period 5 min, grace 5 min**). Turn on its Telegram or email alert. Copy the ping URL into `deadman` → **Variables** → `HEALTHCHECK_PING_URL`.
- [ ] `deadman` logs show:
      `DEADMAN watchdog started: checking bot_liveness every 60s, stale after 5m, … external monitor ON`

### A2. Deadman drill (pre-funding check 4)

- [ ] Stop the trading worker in Railway (`tradeify-crypto-bot` → its active deployment → stop/remove).
- [ ] Within about 6 minutes, Telegram: **🚨 DEADMAN: TRADING BOT IS SILENT**
- [ ] Redeploy or restart the trading worker.
- [ ] Within about a minute of it booting: **✅ DEADMAN: BOT HEARTBEAT RESTORED**

### A3. Confirm no alerts are being dropped

In Railway, open the **Postgres** service's data/query view (or connect with `psql` using the service's connection string):

```sql
SELECT created_at, payload FROM events
WHERE kind = 'TELEGRAM_NOTIFICATION_REJECTED'
ORDER BY id DESC LIMIT 20;
```

- [ ] No rows dated after the 2026-09-21 deploys. (Older rows are the alerts that were silently dropped before PR #92.)

### A4. Confirm the daily session rotation is healthy (part of pre-funding check 1)

- [ ] In the trading worker's logs after 22:15 UTC, `Daily DXtrade session rotation complete for 6 sessions.`, and no **SESSION ROTATION FAILED** alert on Telegram.

### A5. Decide: launch on the current geometry, or re-fit first

The `10k` profile is confirmed. The **ring geometry** (band, dead zone, levels) is still the one fitted for the $50K era. Band and dead zone are percentages of the moving average, so they carry over to a smaller account. But:

- The geometry fitter has two open defects: it tests against a $1,500 daily limit and a $6,600 pool, not $300 and $2,200.
- The simulator still models the logic from before PR #87.

So the $10K numbers have **not been backtested**.

- [ ] **Your call:** launch now and let the $10K account be the proving ground (that is its purpose), or fix the fitter and simulator and re-fit first.

---

## Part B — Switch-over to the new account

Do these in one sitting, in this order.

### B1. Buy the account

- [ ] Buy the **$10,000 Tradeify Crypto Instant Funding** account.
- [ ] From Tradeify's credentials email, note the DXtrade **username, domain, password, account code**, and the **REST base URL** (check whether it is the same as the current `DXTRADE_REST_BASE_URL`).

### B2. Make it impossible for the bot to trade yet

- [ ] Trading worker → **Variables** → `AUTO_EXECUTE` = `false`. Do not redeploy yet.

### B3. Stop the trading worker

- [ ] Stop it.
- [ ] Expect the deadman's **TRADING BOT IS SILENT** alert. That is correct; ignore it.
- [ ] Wait **2 minutes**. The reset in B4 refuses to run while the bot's heartbeat is fresh.

### B4. Reset the database

This clears the old account's balance, peak and daily state, after copying it into an archive.

- [ ] In the **Postgres** service's query view (or `psql`), paste the entire contents of `scripts/reset-for-new-account.sql` and run it.
- [ ] You should see: `Reset complete. Archive schema: archive_<timestamp>. bot_state: 1 rows archived and cleared; …`
- [ ] If instead you see **"The trading bot is still running"**: nothing was changed. Confirm the worker is stopped, wait 2 minutes, and run it again.

What it clears, and why each must go:

| Table | Holds | Left in place, it would… |
|---|---|---|
| `bot_state` | Old balance, **$49K peak**, max-loss floor | Set the max-loss floor to min($10,000, $49,465.75 − $600) = **$10,000**. A new account starts *at* $10,000, and the rule is "flatten and lock when equity ≤ floor", so **the bot would be stuck in flatten-and-lock from its first tick and never trade** |
| `sol_risk_ladder_state` | Each day's starting balance ($47,929) | Trigger a baseline-mismatch halt |
| `daily_ledger` | Realised P&L per day | Count old losses against the new day |
| `session_harvest_state`, `halt_warning_cycle`, `hybrid_watermark` | Old account's day and order state | Carry stale state onto the new account |

It keeps the ring state (every book is flat; ring sizes are rebuilt from the profile), the order and alert history, events and market data. The script was tested against a real Postgres server with the bot's own tables: it refused while the heartbeat was fresh, archived and cleared when stopped, and the bot then rebuilt its state as $10,000 balance / $9,400 floor.

### B5. Point the bot at the new account

Trading worker → **Variables**:

- [ ] `DXTRADE_USERNAME`, `DXTRADE_DOMAIN`, `DXTRADE_PASSWORD`, `DXTRADE_ACCOUNT_CODE`: the new account's values
- [ ] `DXTRADE_REST_BASE_URL`: only if Tradeify gave a different one
- [ ] `ACCOUNT_PROFILE` = `10k`
- [ ] `AUTO_EXECUTE` is still `false`

### B6. Start the worker and read the boot log

- [ ] `Account profile "10k": $10,000 account, daily limit -$300, … flatten -$250, harvest +$75, pool $2,200 soft / $2,250 hard, per-coin cap $25,000.`
- [ ] `Exposure pool: ARMED. No new entries at or above $2,200 account exposure; no single fill past $2,250.`
- [ ] `Deadman heartbeat: writing bot_liveness every 30s for the external watchdog.`
- [ ] `Automatic execution: OFF` (or `ARMED … still blocked`)
- [ ] `HYBRID: … =MATCH` for all five books
- [ ] No red errors, apart from the known `deleteWebHook` deprecation warning and at most one `409 Conflict` in the first few seconds of a redeploy.
- [ ] Telegram: **✅ DEADMAN: BOT HEARTBEAT RESTORED**

### B7. Check it on Telegram

`/status`:
- [ ] Broker equity and balance **$10,000.00**, day-open balance $10,000.00, unrealised $0.00
- [ ] `daily loss limit: -$300.00`
- [ ] Ladder: brake −$120, cuts at −$100 / −$150 / −$200, flatten −$250
- [ ] `exposure pool: $0.00 of soft $2,200.00 / hard $2,250.00 (0%) · OPEN`
- [ ] `harvest: +75.00 · READY`
- [ ] Every book: `Cap: $25,000.00`, DXtrade broker net 0.00, virtual net 0.00

`/health`:
- [ ] Execution client **OK**. This is the check that would have caught 09-19.

`/dxpreflight`:
- [ ] Instrument settings come back for the new account.

### B8. Confirm the database rebuilt correctly

```sql
SELECT balance, high_water, mll_floor, safety_halt, operator_killed FROM bot_state;
```

- [ ] `10000.00 | 10000.00 | 9400.00 | false | false`

### B9. Turn trading on

- [ ] Trading worker → **Variables** → `AUTO_EXECUTE` = `true` → redeploy.
- [ ] Boot log: `Automatic execution: ON (Railway=ON, mode=live).`
- [ ] `/status` one more time.

---

## Part C — The first days: observe what could not be tested beforehand

Two of the four pre-funding checks can only happen on a live, funded account. The
$10K account is where they are observed. Treat these days as supervised.

- [ ] **Check 1: session expiry survived.** `/health` shows `reauths today` above zero at some point, with no action from you, or the 22:15 UTC rotation keeps passing.
- [ ] **Check 2: a real protective cut filled.** Only happens if the ladder triggers. Look for the cut notification, and `RISK_SUPERVISOR_PARTIAL_CUT` with `"executed": true` in events.
- [ ] **Check 3: the exposure gate refused an entry.** The **⛔ EXPOSURE CEILING REACHED** alert, then **✅ ENTRIES RESUMED**.
- [ ] **Check 4: deadman fired in a drill.** Done in A2.

Each day, morning and evening:

- [ ] `/status`: pool usage, day P&L against −$300, all books MATCH
- [ ] No **TRADING BOT IS SILENT** / **RISK CHECKS HAVE STOPPED** alerts
- [ ] No **PROTECTIVE CUT FAILED** alerts
- [ ] The A3 query still returns no new rows

---

## Part D — Stop immediately if

- **PROTECTIVE CUT FAILED** repeats, or **ENTRY/EXIT BLOCKED** does not recover within minutes
- The day's P&L passes −$200 with the pool full and still falling
- Any **SAFETY HALT** you do not understand
- `/status` and DXtrade disagree about positions

How to stop, least to most drastic:

1. `/kill`: pauses new activity on every book. Exits and the ladder keep running.
2. `AUTO_EXECUTE=false` in Railway, then redeploy: the bot can no longer place any order.
3. `/flatall CONFIRM`: flattens every book through the bot.
4. **Close positions in the DXtrade platform yourself.** Always available, and the only option if the bot cannot reach the broker.

---

## Later: moving to $100K

The same Part B procedure, with these differences:

- Review every number in `config/profiles/100k.json` and set `"confirmed": true`. The bot refuses to start on it until you do.
- `ACCOUNT_PROFILE` = `100k`
- Run the database reset again. Each run archives into its own new schema.
- Never run the $10K and $100K accounts on opposite sides of the same coin at the same time. Tradeify treats that as hedging across accounts.
