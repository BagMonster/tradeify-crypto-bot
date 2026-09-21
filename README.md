# Tradeify Crypto Bot

Owner-operated automation for **Tradeify Crypto Instant Funding** accounts on DXtrade: five independent moving-MA ring grids (SOL, DOGE, INJ, AAVE, AVAX) under one account-wide risk ladder.

Current continuity write-up: [6th authoritative project state](docs/6th_AUTHORITATIVE_PROJECT_STATE_Tradeify_Crypto_Bot.md)
Chronicle: [Brutal Markets, Tamed By One](docs/chronicle/README.md)

---

## Where things stand — 2026-09-21

- **The $50,000 funded account is closed.** It breached Tradeify's daily loss limit on 2026-09-19. The trigger was a DXtrade session expiry the bot could not recover from, which silently blocked every protective cut for eighty minutes. The underlying cause was that nothing capped account-wide exposure: it reached $41,079 on a $49,000 account.
- **The bot is deployed and running against the closed account** on the `50k` profile (below). DXtrade will not accept orders on a closed account, so it cannot trade.
- **The plan:** open a **$10,000** account as a proving ground, then scale to **$100,000** once the bot has proved itself on it.

### Fixed since 2026-09-19 (all merged and deployed)

| Change | What it does |
|---|---|
| `fix/dxtrade-session-recovery` | A `401` now clears the session, logs back in and retries (GET requests only; orders are never replayed). A failed protective cut brakes entries on every book and alerts the owner. Adds `/relogin`, `/flatall` and a daily 22:15 UTC session rotation. |
| `fix/dxtrade-login-gate` | All six DXtrade sessions log in through one queue, so a shared expiry does not trigger `429 Too many requests`. |
| PR #92 — alert delivery | **The protection alerts added on 09-20 were never reaching Telegram**: the notification formatter rejected them and the rejection was silent. The same happened to reconciliation-mismatch, runtime-error and full-flatten warnings. All are fixed, and `tests/notificationCoverage.test.mjs` now fails the build if any alert the code sends would be dropped. |
| PR #92 — immediate flatten | At the full-flatten threshold the bot now **flattens immediately**. It previously started a 25-minute warning countdown and skipped the cut tiers until the countdown ended. |
| PR #92 — blocked-action alerts | If DXtrade cannot be read, you get **one** alert per book when entries or exits are blocked, and one when broker reads work again, with the outage duration and how many actions were blocked. |
| PR #93 — account profiles | Every account-size number now lives in one file per account size, chosen by one Railway variable. See [Account profiles](#account-profiles). |

---

## Rollout plan

**Next build, in priority order:**

1. **The exposure gate.** This is the fix that would have prevented 09-19. It will read the $2,200 soft / $2,250 hard numbers already stored in the `10k` profile.
2. **The deadman switch.** An alert if the bot stops working for any reason: process hung, price feed dead, container gone. Because a dead process cannot report its own death, the check runs in a separate Railway service.
3. **The $10K launch checklist, including the database reset.** The database still holds the closed account's peak balance and history, which a new account must not inherit.

**After that, before the $10K fits are trusted:**

- Pass `--daylimit 300` and `--ceiling 2200` through `fit-geometry.mjs`. Today it silently uses the simulator's defaults of $1,500 and $6,600.
- Backport PR #87 into the simulator, which still models the pre-#87 ring logic.
- Add an alert for a stale Binance price feed (currently recorded in Postgres only) and an early warning as the day's loss approaches the limit.

**Fund the $10K account only after these have been *observed*, not assumed:**

1. A DXtrade session expiry survived automatically (`reauths today` above zero in `/health`, with no owner action).
2. A real protective cut filled.
3. The exposure gate refused an entry.
4. The deadman fired in a deliberate drill (stop the container and confirm the alert arrives).

**Scale to $100K only after the $10K account has run cleanly.**

---

## Account profiles

Every number that depends on account size lives in **one file**: `config/profiles/<name>.json`. The Railway variable **`ACCOUNT_PROFILE`** chooses which one the bot runs.

| Profile | Status | Daily limit | Flatten | Cuts (10% / 20% / 50%) | Brake | Harvest | Exposure pool | Per-coin cap |
|---|---|---:|---:|---|---:|---:|---|---:|
| `50k` | **Live now.** Closed account; test baseline | −$1,500 | −$1,250 | −$500 / −$750 / −$1,000 | −$600 | +$600 | none | $150,000 |
| `10k` | Confirmed, next account | −$300 | −$250 | −$100 / −$150 / −$200 | −$120 | +$75 | $2,200 soft / $2,250 hard | $25,000 |
| `100k` | **Draft, refused until confirmed** | −$3,000 | −$2,500 | −$1,000 / −$1,500 / −$2,000 | −$1,200 | +$750 | $22,000 / $22,500 | $250,000 |

**At startup the bot refuses to run if:**

- `ACCOUNT_PROFILE` is missing, or names a file that doesn't exist.
- The profile isn't marked `"confirmed": true`.
- Any number breaks Tradeify's rules for that account size: daily limit 3%, max loss 6%, notional 2×.
- The ladder is out of order: cut tiers shallower than the flatten, flatten shallower than the limit, brake shallower than the deepest cut, soft pool below hard.
- An account-size number has been put back into `config/account.json` or `config/instruments.json`. There must be only one copy.

Each error names the exact field and the value it expected. The first line of the boot log states the profile in use, for example:

```text
Account profile "50k": $50,000 account, daily limit -$1,500, brake -$600/instrument, cuts 10% at -$500, 20% at -$750, 50% at -$1,000, flatten -$1,250, harvest +$600, pool not set, per-coin cap $150,000.
```

**To move to a different account:** new DXtrade login details in Railway → database reset (see the launch checklist) → change `ACCOUNT_PROFILE` → check the boot-log line and `/status`. All three changes must be in place **before** the restart: with automatic execution on, the bot trades as soon as it connects.

The exposure-pool numbers are stored in the profile but **nothing reads them yet**. The exposure gate is item 1 of the rollout plan.

---

## Tradeify Instant Funding rules

Taken from Tradeify's help centre on 2026-09-20. The owner confirmed the measurement basis on 2026-09-21.

| Rule | Value |
|---|---|
| Daily loss limit | **3% of account size**, measured on **intraday equity (realised + unrealised)**. Touching it at any moment closes the account. Resets 22:00 UTC. |
| Max drawdown | 6%. The floor trails up when a trade closes at a new high, and is capped at the starting balance. |
| Leverage | 2:1 on every asset |
| Minimum hold | 20 seconds. The bot enforces **25** (`minimumHoldSeconds`); a forced exit at the moving average is exempt. |
| Hedging | Not allowed, **including across two Tradeify accounts** |
| Consistency | No single day may be more than 20% of total profit (checked at payout) |
| Inactivity | 30 days with no trade breaches the account |
| Bots | Allowed if you own them |

---

## What it does

Each enabled instrument has its own 200-day MA, ring ladder, virtual lots and order-code prefix. Binance supplies the touch price. DXtrade is the broker.

On every live touch the book looks at **exits first, then entries**. Tranche exits and protective cuts/flattens close existing tickets by `positionCode`. Entries still OPEN. A book may not hold long and short in the same instrument at once.

If a book drifts from the broker, the feed dies, or the day is eating equity, the bot brakes that book, cuts losers, or flattens the account. It does not average harder.

---

## Live books

Geometry is in `config/instruments.json`. The cap comes from the active profile, and `baseUsd` is derived from it.

| Instrument | Feed | Rings/side | From 200d MA |
|---|---|---:|---|
| SOL/USD | SOLUSDT | 10 | ±10% … ±55% |
| DOGE/USD | DOGEUSDT | 12 | ±9% … ±42% |
| INJ/USD | INJUSDT | 12 | ±20% … ±75% |
| AAVE/USD | AAVEUSDT | 12 | ±18% … ±67.5% |
| AVAX/USD | AVAXUSDT | 12 | ±16% … ±60% |

Shared: inner levels single-fill and outer levels two-fill (D-067), 0.5-band re-arm, 0.01 lot step, four-tranche exits back toward the MA.

---

## Account risk ladder

The dollar amounts come from the active profile; the table in [Account profiles](#account-profiles) lists them. This is how each layer works:

| Layer | Measured on | Action |
|---|---|---|
| **Brake** | One instrument's day P&L | Stop **that instrument's** new entries. Exits still run. |
| **Cut tiers** (10% / 20% / 50%) | **Total unrealised loss** across all books | Close that fraction of every **losing** book. Winners are never cut. A tier fires at most once every **5 minutes**, and a deeper tier skips the wait. |
| **Full flatten** | Combined day P&L (realised + unrealised) | **Immediately** flatten every book and hold entries until the 22:00 UTC rollover. You're alerted afterwards. |
| **Protection failure** | Any cut that fills nothing | Brake entries on **every** book and alert. This clears only when a cut fills again, and it survives the rollover. |

The cut tiers read unrealised loss, not day P&L. Cutting turns unrealised loss into realised loss at the same value, so a tier that read day P&L could never release. That is the loop that cost 95% of four books on 2026-09-18 (D-063). On unrealised loss, each cut reduces the number the tier is watching, so the tier releases on its own.

An unreadable book is not treated as flat. The supervisor brakes every instrument while broker data is unreadable.

## Session harvest

Once the account-day P&L (realised plus unrealised since 22:00 UTC) first reaches the profile's harvest amount (`50k`: +$600, `10k`: +$75), the worker pauses normal actions, flattens all enabled books and confirms the broker is flat. After confirmation, touch-cross entries may resume, but ordinary tranche exits stay off until the next 22:00 UTC rollover. A harvest that fails or can't read the broker halts the bot rather than guessing. See [D-064](docs/decisions/D-064-session-harvest.md).

---

## Owner alerts

Telegram alerts go to the owner only. They never include credentials or raw broker errors. Unsafe text is withheld, and the rest of the alert is still sent.

| Alert | When |
|---|---|
| PROTECTIVE CUT FAILED / WORKING AGAIN | A cut filled nothing (first failure, then every third) / a cut filled again |
| ENTRY or EXIT BLOCKED / BROKER READ RECOVERED | A book cannot read DXtrade (once per outage) / reads work again |
| DAILY DXTRADE SESSION ROTATION FAILED | The 22:15 UTC re-login failed for any session |
| SAFETY HALT / HALT WARNING | Full flatten, reconciliation mismatch, runtime error, account lockout |
| NET MISMATCH | A book's virtual net differs from DXtrade |
| D-064 harvest | Pending, confirmed, halted, fresh-data grace, rollover reset |
| Trade confirmations | Entry, tranche exit, lot closed, protective flatten |

**Not covered yet:** the bot going silent (the deadman switch, rollout item 2), a stale Binance feed, and an early warning as the day's loss nears the limit.

---

## Railway variables

```text
APP_MODE=live
AUTO_EXECUTE=true
ACCOUNT_PROFILE=50k        # which config/profiles/<name>.json to run
```

Per-instrument `execution.autoExecute` defaults to on. Even in live mode, an order can still be blocked by a pause, a safety halt, a lockout, stale data, a loss floor, the ladder, or reconciliation.

**Fill doctrine:** submitted ≠ filled. State moves only on broker-confirmed fills.

---

## Stack

| Piece | Role |
|---|---|
| Railway trading worker | `index.mjs`: grids, DXtrade, Telegram polling. Runs as a worker; it binds no HTTP port. |
| Railway companion worker | BMTB1 `/code`, GitHub read tools |
| PostgreSQL | Account state, `ring_grid_state`, execution ledger, risk day state, `events` log (the durable record; Railway logs are lost when a deployment is removed) |
| Telegram | Owner cockpit + alerts |
| Binance | Strategy touches |
| DXtrade | Fills and floors. **Six sessions:** one account monitor (what `/status` reads) and five execution clients (what places orders). |

---

## Telegram

```text
/status [INSTRUMENT]     /health [INSTRUMENT]
/levels [INSTRUMENT]     /rings [INSTRUMENT]
/targets                 /rawhistory
/dxpreflight             /solcanary
/kill
/resume INSTRUMENT       /confirmresume CODE INSTRUMENT
/reconcile INSTRUMENT    /confirmreconcile CODE INSTRUMENT
/rematch INSTRUMENT      /confirmrematch CODE INSTRUMENT
/harvestrecover          /confirmharvestrecover CODE
/rerun                   /pausehalt
/relogin                 /flatall CONFIRM
/flat [INSTRUMENT]       /whoami
/b                       /help
```

- `/kill` is global. Resume, reconcile and rematch need the instrument name (`SOL`, `DOGE`, …).
- `/health` exercises an **execution** client, not just the account monitor. On 09-19 the monitor looked healthy while all five execution sessions were dead.
- `/relogin` re-logs every DXtrade session.
- `/flatall CONFIRM` flattens every book.
- **`/flat` does not flatten.** It prints instructions, and its text still says automatic execution is locked off, which is no longer true.
- `/rerun` clears a runtime-error or hybrid-reconciliation halt once every book matches.
- `/pausehalt` defers a pending halt warning.
- Confirm commands have no buttons. Long replies split into `[1/n]` pages.

Operator guide: [Telegram command reference](docs/telegram-command-reference.md)

---

## Heartbeat

After **25 days** with no confirmed bot trade, a 0.01-unit round trip is supposed to keep the Tradeify inactivity clock from closing the account. It is armed on SOL only. **The close leg is still a known defect**: it still goes through the OPEN quantity path. Do not treat heartbeat as a finished design.

---

## Tests

```text
npm install      # the repo has no package-lock.json
npm test
```

**6 tests fail on `main` and are known stale**, not behaviour bugs:

- 4 still assert the old D-067 $200,000 cap.
- 2 in `tests/dxtradeExecutionClient.test.mjs` predate the re-login counters added to the client's status object.

Any other failure is new and should be investigated before merging.

---

## Docs map

- [6th project state](docs/6th_AUTHORITATIVE_PROJECT_STATE_Tradeify_Crypto_Bot.md): what was live before the 09-19 incident
- [Decision log](docs/implementation-decision-log.md)
- [D-064 session harvest](docs/decisions/D-064-session-harvest.md)
- [D-063 tiered cut ladder](docs/decisions/D-063-tiered-cut-ladder.md)
- [D-062 swap ZEC for INJ](docs/decisions/D-062-swap-zec-for-inj.md)
- [D-060 multi-asset grid](docs/decisions/D-060-multi-asset-grid.md)
- [D-059 one-sided + close-by-position](docs/decisions/D-059-one-sided-grid-and-position-linked-exits.md)
- [D-049 historical SOL resize / original ladder](docs/decisions/D-049-sol-risk-ladder-and-resize.md)
- [Railway docs watch policy](docs/railway-docs-watch-policy.md)
- [Chronicle](docs/chronicle/README.md)

The August 22 [5th project state](docs/5th_AUTHORITATIVE_PROJECT_STATE_Tradeify_Crypto_Bot.md) is an archive of the BTC-research window. It is not the live bot.

---

## House rules

1. Confirmed fills only.
2. One side per instrument. Do not invent a hedge to "balance" a book. Never run two Tradeify accounts on opposite sides of the same instrument.
3. Manual tickets on an enabled instrument desync the virtual notebook. Flatten the broker, then `/reconcile INSTRUMENT`, or stop the bot.
4. Unread broker data is unknown, never zero.
5. Docs-only merges must not restart the trading worker.
6. `placePositionPartialClose` carries every tranche exit and protective cut. It was first confirmed filling in production on 2026-09-19 (protective cut FILLED on SOL, INJ and AAVE).
7. **Account-size numbers live only in `config/profiles/`.** Never add them back to `config/account.json` or `config/instruments.json`; the bot refuses to start if you do.
8. **Every alert the code sends must be registered in the notification formatter.** `tests/notificationCoverage.test.mjs` enforces this. An unregistered alert is dropped without any warning.
9. Every code path that can stop the bot from reducing risk must alert on its **first** failure, not its Nth, and not only in the logs.
