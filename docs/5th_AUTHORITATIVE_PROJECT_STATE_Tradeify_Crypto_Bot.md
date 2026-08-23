# 5th_AUTHORITATIVE_PROJECT_STATE_Tradeify_Crypto_Bot.md

**Status:** Current authoritative handoff
**Purpose:** Continuity between working chats
**Supersedes:** `4th_AUTHORITATIVE_PROJECT_STATE_Tradeify_Crypto_Bot.md` and every earlier Project State and session-handoff note, as the single continuity source.
**Last updated:** August 22, 2026 (rev. b — Tradeify documentation review)

---

## 1. Executive Summary

- Private, owner-operated, Telegram-controlled Node.js trading bot for an active **$50,000 Tradeify Crypto Instant Funding** account with the **Profit Split 95%** add-on. Not the Tradeify futures Lightning product.
- **The single biggest change since the 4th Project State: box-fade is retired and a completely different strategy — a progressive reference-resetting grid on BTC — is the candidate.** The 4th Project State's framing (box-fade as "the only genuinely positive result found anywhere in this project") is **superseded and must not be acted on.**
- **Box-fade failed out-of-sample validation** on ~550 days of new data. An event study of raw forward returns found the short side anti-predictive at every horizon and the long side's single positive cell worth **+13.37 bps against an 18 bps round-trip cost**. Roughly 300 configurations were tested; win rate stayed 36–42% throughout, against 39% for random entries over identical geometry. Draft **D-028** retires it. **Not yet approved.**
- **`src/research/strategies/boxFade.js` and its 37 tests were written and delivered in chat but NEVER COMMITTED.** Verified 2026-08-22 against the working tree: absent from `src/research/strategies/` and `tests/` on every branch. Box-fade has no code in this repository. The 4th Project State said the same thing and it is still true.
- **The grid strategy is specified, frozen, and backtested.** 545 trading days of dukascopy BTCUSD 5-minute data, 89 start dates: **89/89 profitable, 0/89 breached the daily limit.** Mean $555 per ~325-day run before financing, roughly **$340 after**, roughly **$325 to the owner after the 95% split** — about **0.65%/year on $50,000**. Draft **D-029 through D-035** carry the policy changes it needs. **None approved.**
- **⛔ D-004 is overdue, not upcoming.** `src/dxtradeClient.js` (13,519 bytes) already contains `login()` posting a username and password, a private `#sessionToken`, an `authorization: DXAPI` header, a keep-alive `ping()` loop, `logout()`, and a Push-API WebSocket session. The governing rule triggers the D-004 Codex Security checkpoint before *any* DXtrade "credential, authentication, client, session, API, or order-routing" work. All four of the first-named categories exist in the repository today. **D-004 must run as a remediation audit over existing code.** The client is read-only (no order-placement method), which limits the blast radius but does not remove the obligation.
- **Branch divergence is now material.** `docs/implementation-decision-log.md` runs to **D-027** on the research branches but stops at **D-016** on `main`. Eleven approved decisions have never reached the deployed branch. `main` also has no `scripts/` folder. Conversely, `docs/dxtrade-api-endpoint-reference.md` exists on `main` but not on the research branches.
- **Account-rule model corrected against Tradeify's published rules.** The static $47,000 max-loss floor assumed since D-010 is wrong: it is a **6% End-of-Trade Trailing Balance** floor that ratchets up with the highest closed-trade balance and caps at $50,000. Any payout permanently snaps it to $50,000 — which makes taking a payout an **account-risk event** the backtester does not model. Draft D-032 and D-035 cover this.
- **Hedging assessed and cleared, with a configuration caveat.** The grid holds one signed net position and nets *through* zero rather than opening opposing positions; verified empirically at **zero bars with simultaneous long and short across ~13 million bar-observations.** But DXtrade supports both netting and hedging account modes, and in hedging mode an opposing order may open a separate position — producing the prohibited state by accident. **Netting mode must be confirmed before the first real session.**
- Both automatic-execution locks remain **false**: Railway `AUTO_EXECUTE=false` and `config/strategy.json` → `execution.autoExecute=false`. No research code has ever been imported by `index.mjs`. No order has been placed by any route.
- **⛔ The 30-day inactivity rule breaches the frozen grid roughly twice a year.** *"If you go 30 consecutive days without placing a trade, your account is closed and marked as breached due to inactivity."* Measured on the 545-day path, three gaps between fills exceed 30 days — **49.0, 45.9 and 35.8 days** — and six exceed 25. In every one the account was **holding an open position**. Mean gap is 6.7 days; the average is reassuring and the distribution is not. Fixed by draft **D-036** (a heartbeat trade costing about $1/year), which must not be routed through the grid's fill path or it will corrupt the reference price.
- **Documentation review outcome, otherwise clear.** Tradeify explicitly permits owner-operated trading bots: *"Trading bots are allowed if you own or have exclusive rights to the bot."* No rule prohibits grid, martingale, DCA, averaging down, arbitrage, or news trading. The 40% single-day consistency trading rule applies to **APE-X only**. A separate **20% consistency score** gates Instant Funding *payouts*; the grid's best single day was 34% of total realised profit, which blocks a withdrawal but does not threaten the account.
- **The overnight financing rate is not published anywhere in Tradeify's documentation** — the trading rules, Instant Funding guide, and payouts pages were all checked. It cannot be resolved by reading; it needs a support ticket or an account statement.
- **Immediate resume point:** four owner verifications (Section 18, Step 0), then owner approval of D-028 and D-029–D-035, then the D-004 remediation audit. Two of the four verifications can invalidate the strategy outright.

### Authority and conflict order

1. A newer explicitly approved entry in `docs/implementation-decision-log.md` — read the **live file** on the owner's machine or GitHub, never this Project's synced/RAG copy, and note **which branch** you are reading (main and the research branches disagree by eleven entries).
2. The live branches for exact code, test, and tracked-file truth.
3. **This fifth Project State.**
4. `docs/proposals/grid-golive-policy-change-2026-08-22.md` (Revision 4) — the grid policy package and implementation handoff, containing draft D-029 to D-035.
5. `docs/proposals/grid-strategy-spec-2026-08-19.md` — the frozen grid specification. Pre-registered before any forward run; **supersede it with a new version rather than editing it**, or its evidentiary value is destroyed.
6. `claude/chapter-26-step-26-1-freeze-contract.md` and `claude/chapter-26-step-26-6-real-data-findings.md` — still authoritative for Chapter 26 mechanics and the box-fade research record, now historical in effect.
7. `Tradeify_Familiar_Format_Build_Manual.md`, the 4th and earlier Project States, chats, handoffs, ZIP archives, Word exports, screenshots — historical context only.

Never use an older source to reverse a later approved decision. Never restart Chapters 1–25 or Steps 26.1–26.6.

---

## 2. Project Objective and Definition of Success

**Unchanged from the 4th Project State, Section 2, in every particular.** Not restated. The primary objective, secondary objectives, success criteria before automatic execution, canary criteria, and non-goals all remain binding as written there.

One clarification the grid work makes concrete: the non-goal *"no strategy proceeds to live/paper-forward trading without out-of-sample validation, formal qualification, and an explicit owner decision"* now has a specific staged gate attached — draft D-034's Stage A → B → C → D sequence, with a 90-day shadow minimum. That gate is **new in D-034**; the frozen spec's §9 90-day condition scopes to *increasing size beyond the frozen ladder*, not to going live. Do not cite spec §9 as the source of the shadow requirement.

---

## 3. Background and Context

Everything in the 4th Project State's Section 3 remains valid background. **New context from this window:**

- Chapter 26's official four-slot track (Slots 1–4) is **still blocked exactly where the 4th Project State left it** — all four slots negative on real data, `docs/chapter-26-slot4-freeze-record.json` still absent, Steps 26.7–26.9 not started. No work was done on it in this window. It has effectively been overtaken by events rather than resolved.
- The owner directed a validation push on box-fade using a **new, larger dataset** obtained specifically to test it out-of-sample: dukascopy BTCUSD, **156,941 five-minute bars, 2025-02-17 to 2026-08-21**. It contains the original 2025-12-13 to 2026-04-14 research window in its interior, giving roughly 426 days the box-fade parameters were never shaped on. This is what allowed a genuine out-of-sample test for the first time.
- When box-fade failed, the owner introduced a **grid strategy from a prior spot bot** (PancakeSwap / Pump.fun era) and asked whether it could be adapted to Tradeify's rules. It was specified, adapted, backtested, and frozen. **The adaptation is not cosmetic** — on spot a drawdown is endured indefinitely, and that patience is the grid's engine; this account cannot wait, because the $1,500 daily limit is measured on paper losses.
- The owner explicitly instructed: *"We have to follow the account rules so that we don't lose the account on a live run."* Every sizing and spacing decision in the frozen spec follows from that instruction rather than from profit maximisation.
- **Nine accounting defects** were found and fixed in the research scripts during the box-fade work, measured individually by ablation. All nine had made results *worse* than reality; corrected, the reference configuration moved from −93.17R to −33.23R. Separately, an **impossible-fill defect** — a break-even stop filling at a price the market never offered — briefly produced a fake **+$19,533 and a 94.6% win rate** before being caught and corrected with an arming check. The standing lesson recorded from it: *any exit that fills better than the market at that moment is a bug and will always look like an edge.*
- The 0.033%/night overnight financing rate, carried since D-010/D-015 as an assumption, was challenged by the owner and traced to its origin. It is still unverified and is worth roughly one third of the grid's modelled profit.

---

## 4. Current Project State

### Exact current phase and resume point

- **Completed and user-confirmed:** Chapters 1–25 (unchanged).
- **Completed, committed, pushed:** Chapter 26 Steps 26.1–26.6; decisions D-001 through **D-027** on the research branches.
- **Blocked and now effectively abandoned:** Chapter 26's official four-slot track. All four slots negative; freeze record absent; Steps 26.7–26.9 not started. Superseded in practice by the strategy change, but **never formally closed** — this is an open governance loose end.
- **Retired, pending approval:** box-fade. Draft D-028 written, **not approved, not committed.**
- **Specified and backtested, pending approval:** the grid. Draft D-029 to D-035 written, **none approved, none committed.**
- **Overdue:** the D-004 remediation audit over `src/dxtradeClient.js`.
- **Current resume point:** Section 18, Step 0 — four owner verifications, two of which can invalidate the strategy.

### Git facts — read directly from `.git/refs/heads/*` on 2026-08-22, not reported

| Branch | Head | Notes |
|---|---|---|
| `main` | `a397813b8b14a7be8d744ac7908971836a0b84f8` | Decision log stops at **D-016**. No `scripts/` folder. Has `docs/dxtrade-api-endpoint-reference.md`. |
| `chapter-26-research` | `5df16aaa459fe26ebbb5b07ffc8ed0057910f53d` | Decision log through **D-027**. Has `scripts/`. |
| `grid-implementation-handoff` | `fdc7b73816eecfc388e09a8a471c4a448a7b1da7` | Created from `chapter-26-research` on 2026-08-22. Carries the grid handoff. Current checkout. |
| `dxtrade-readonly-discovery` | `51e73c6c211e5020450a36328f8d75bbba3a16a2` | The working tree has reverted to this branch unexpectedly more than once. Check `.git/HEAD` before concluding a file is missing. |

**These SHAs differ from every SHA recorded in the 4th Project State** (`main` `39aff0df`, `chapter-26-research` `ccc415bf`). Treat the 4th Project State's git facts as stale.

Remote/push state was not read this session. **Treat push status as unconfirmed** and ask the owner.

### Repository contents — verified 2026-08-22 on `grid-implementation-handoff`

```text
docs/
  implementation-decision-log.md         97,011 bytes, D-001 – D-027
  post-automation-development-agent-addendum.md
  proposals/
    grid-golive-policy-change-2026-08-22.md    Rev 4 — draft D-029 to D-035
    grid-strategy-spec-2026-08-19.md           frozen grid specification
scripts/
  export-bars-for-research.mjs
  run-backtest.mjs                       argument surface is only --step, only "26.6"
  research/
    grid-btc.mjs        reference grid backtester
    grid-v4.mjs         + trailing floor, alt day baseline, position census, equity drawdown
    README.md           data dependency and safety notes
src/
  dxtradeClient.js      ⛔ credentials, auth, session, WebSocket — D-004 overdue
  indicators.js         normalizeBars REJECTS 5-minute bars (15m/4h/1d only)
  research/             manifest, regime, accountModel, backtestEngine, router,
                        metrics, monteCarlo, walkForward
  research/strategies/  donchian, tsMomentum, meanReversion, compressionBreakout
                        (boxFade.js ABSENT — never committed)
tests/                  20 files; no research.boxFade.test.mjs
artifacts/              ~52 MB, 26 files — now gitignored
.gitignore              node_modules/, .env, .env.*, !.env.example, npm-debug.log*,
                        *.log, .DS_Store, artifacts/
```

`index.mjs`, `config/strategy.json`, `config/account.json`, `src/config.js`, `src/database.js`, `src/telegramBot.js`, `src/tradeifyService.js`, `src/signalEngine.js`, `src/signalAlerts.js`, `src/binanceBackfill.js`, `src/riskEngine.js` remain untouched by all Chapter 26 and grid work.

### Verified safety state

Both execution locks false. No research file imported by `index.mjs`. No network call, DB write, or Telegram call from any research code. Neither grid backtester contains a broker client, credential read, environment-variable read, or network call — verified by inspection: they import only `node:fs/promises` and `node:path`.

---

## 5. Decisions Already Made

**D-001 through D-027 are committed on the research branches.** D-001–D-019 are described in the 4th Project State, Section 5, and are not restated. Their governing status is unchanged except where noted below.

### Amendments to previously recorded decisions

- **D-004** — no longer "initial checkpoint complete, fresh review required before D-008." It is **overdue now**, because DXtrade credential/auth/session/client code exists in `src/dxtradeClient.js`. See Section 1 and draft D-034's Stage A exit.
- **D-010** — the static $3,000 max-loss offset ($47,000 floor) is **wrong**. It is a 6% End-of-Trade Trailing floor capped at $50,000, plus a payout lock. Corrected by draft D-032. The 0.033%/night overnight rate remains unverified and is now materially load-bearing.
- **D-015** (overnight cost not modelled, justified by hard-flat) — **the justification no longer holds** if the grid is adopted, since the grid carries inventory overnight by design. Draft D-030 reinstates overnight cost modelling.
- **D-019** (box-fade regime band) — **moot** if D-028 is approved. It governs a retired strategy.
- **D-020** (box-fade as sole active strategy, conditioned on out-of-sample validation) — the condition is **resolved negatively**. Draft D-028 closes it.

### D-021 through D-027

Committed on `chapter-26-research` and its descendants. Not present on `main`. Full text in the live decision log; not restated here.

### Draft decisions — written, NOT approved, NOT committed

| ID | Subject | Where |
|---|---|---|
| **D-028** | Box-fade retirement | `claude/decision-D028-box-fade-retirement-DRAFT.md` |
| **D-029** | Position model: one net position, one instrument, multiple fills | `docs/proposals/grid-golive-policy-change-2026-08-22.md` §2 |
| **D-030** | Overnight inventory permitted; hard-flat retired. **Blocked on the financing rate.** | §3 |
| **D-031** | Grid adopted as the active strategy candidate | §4 |
| **D-032** | Account rule model corrected | §5 |
| **D-033** | No-hedging compliance, netting mode, and control precedence | §6 |
| **D-034** | Staged go-live gate (Stage A → B → C → D) | §8 |
| **D-035** | Payout policy — a payout is an account-risk event | §7 |
| **D-036** | **Inactivity heartbeat — account-ending without it** | §7A |

**Numbering verified 2026-08-22** against the live decision log on `grid-implementation-handoff`: the committed log runs D-001 to D-027, so D-028 is genuinely the next free ID and this sequence is correct as written.

**D-028 is a substantive prerequisite for D-031**, not merely a numbering one. If D-028 is not approved, D-020 still makes box-fade the sole active strategy and D-031 becomes a conflicting entry rather than a successor.

---

## 6. Requirements and Constraints

All requirements from the 4th Project State's Section 6 remain in force. **Additions from this window:**

- **Never trust a decision-log reading without naming the branch.** `main` and the research branches disagree by eleven entries. "The decision log says D-016" is true and useless without the branch name.
- **Never hard-cap grid deployment at $2,050.** That figure is the maximum for one unbroken run of three same-side fills. Because every opposite-side fill resets the side counter, a stair-step decline re-arms the ladder indefinitely; **total deployment is unbounded by design**, and measured peak notional was **$3,928**. Deployment caps were tested and hurt returns. This is an accepted, documented risk (frozen spec §7.3), not an oversight.
- **No control may delay or suppress a protective close.** Draft D-033 fixes the precedence: daily-limit force-flatten and max-loss protection outrank the hedging halt, the durable pause, and the 25-second minimum-hold guard, unconditionally. Any implementation where a defensive guard can postpone a protective close is a defect.
- **The 20-second minimum hold is a termination-risk rule.** *"All trades must be held for at least 20 seconds... Violations of the microscalping rule may result in account termination."* The guard applies to **entries only**, never to protective exits.
- **Reference price must be set from the actual fill price, not the trigger price.** The backtest models 0.05% slippage; live, that difference compounds through every subsequent grid level.
- **After a daily-limit force-flatten, grid state must reset** — side counters to zero, level pointers to zero, reference re-anchored to the flatten fill. A bot that faithfully restores pre-breach state resumes anchored to a stale reference and redeploys the full ladder into the same move: a repeat-breach loop.
- **`src/indicators.js` `normalizeBars` rejects 5-minute bars** (`throw new Error("timeframe must be 15m, 4h, or 1d")`). It also requires `isClosed: true`, matching `timeframe`/`source`/`symbol`, ISO-string timestamps, and contiguous bars. Any 5-minute research must bypass it, as both grid backtesters do.
- **`scripts/run-backtest.mjs` accepts only `--step 26.6`.** It is not a general-purpose runner.
- **`trimToExpectedWindow` keeps the EARLIEST N bars** (`bars.slice(0, expected)`) and discards the tail. Stated because it was described backwards once in this project's history and the owner caught it.

---

## 7. Established Terminology

Terms from the 4th Project State's Section 7 remain valid. **New:**

| Term | Meaning |
|---|---|
| **Grid / progressive reference-resetting grid** | The current strategy candidate. Buys into successive declines, sells into successive rallies, re-anchors the reference price to the fill price after every trade. Two-sided. |
| **Ladder** | The frozen trigger/size table. Buys: −4.00%/$250, −9.00%/$550, −10.00%/$1,250. Sells: +3.75%/$250, +7.50%/$550, +10.00%/$1,250. Max 3 consecutive per side. |
| **Leftover coin** | Where grid profit comes from. The same dollars buy more units low and require fewer units to sell high; the difference is never sold back. |
| **Netting vs hedging mode** | A DXtrade account configuration. Netting nets an opposing order through zero; hedging opens a separate opposing position — the state Tradeify prohibits. |
| **End-of-Trade Trailing Balance** | Tradeify's real max-loss mechanism. Floor = highest closed-trade balance − $3,000, ratcheting up only, capped at the $50,000 starting balance. |
| **Payout lock** | Any payout permanently fixes the max-loss floor at the $50,000 starting balance. |
| **PRE / TUNE / POST** | The out-of-sample split protocol adopted as standard: PRE 298 days, TUNE 123 days (where all box-fade parameters were fitted), POST 128 days. |
| **Event study** | Measuring raw forward returns after a signal, with no stops, targets, or costs, **before** building a strategy around it. Adopted as the standard first test for any future candidate. |
| **Random-entry control** | Applying the same trade geometry at random times. Box-fade's 40–42% win rate against random entry's 39% is what established it had no edge. |
| **Friction in R** | `round_trip_cost_pct / stop_pct`. Makes cost comparable across stop widths. |
| **Impossible fill** | An exit filling at a price the market never offered at that moment. Always a bug; always looks like an edge. |

---

## 8. Important Facts, Data, Numbers, and Assumptions

### Account rules — corrected, sourced from Tradeify's published help centre, `[UNCONFIRMED against this account]`

- **Daily loss limit.** Amount is **3% of account size — a fixed $1,500**, not 3% of the running balance. Tradeify's own example: a $100,000 account with a $101,500 snapshot balance has a $3,000 limit and a $98,500 floor. Baseline is the **previous trading day's closing balance**. Checked **continuously against live equity including unrealised**. Day rolls **22:00 UTC**.
- **Max loss.** 6% End-of-Trade Trailing Balance, ratcheting, capped at $50,000.
- **Payout lock.** Any payout permanently fixes the floor at $50,000.
- **Leverage 2:1 and max notional $100,000** — still recorded as *"subject to later verification"* and still unverified.
- **Unresolved: the day baseline.** The Instant Funding page says previous day's closing **balance**; the rules overview describes the intraday check against **equity**. If balance, worst day is −$1,198 with $302 margin. If equity snapshot, worst day is −$498 with $1,002 margin. **The conservative model ships regardless.** A dashboard reading is not verification of a contractual rule.
- **No Tradeify Crypto account without a daily loss limit is purchasable.** APE-X is the only product without one and is discontinued. Its 4% single trailing limit never resets, which for an inventory-holding grid is worse, not better. The Daily Soft Breach add-on exists but is evaluation-phase only, explicitly not available on Instant Funding, and does not survive into the funded account.

### Grid backtest results — `[CONFIRMED from the run, on one instrument and one price path]`

Dataset: dukascopy BTCUSD, 156,941 five-minute bars, **545 trading days spanning 550 calendar days**, 2025-02-17 to 2026-08-21. The 5-day difference is data gaps and should be reconciled.

```
Full window
  trades                     82
  realised               +$1,039.67
  unrealised               +$368.72
  TOTAL                  +$1,408.39
  commission                 $12.52
  overnight financing       $344.97 over 542 nights   [RATE UNVERIFIED]
  after financing        +$1,063.42
  peak notional            $3,928
  worst single day          -$465.10
  breaches                        0

89 start dates, one every ~5 days, average run 325 days
  profitable                 89 / 89
  breached                    0 / 89
  mean                        $555      median $446
  worst run                    $87      best  $1,408
  deepest single day       -$1,198      (margin $302)
  worst peak-to-trough equity drawdown  $1,346
  closest approach to the trailing floor $1,736
  avg trades per run             45

Position-state census, all runs, ~13 million bar-observations
  LONG 71.6%   SHORT 27.2%   FLAT 1.2%   BOTH 0
```

**Net of everything:** ~$555 gross → ~$340 after assumed financing → ~**$325 to the owner** after the 95% split, per ~325 days. About **0.65%/year on $50,000.**

### What these numbers are NOT

The 89 runs overlap almost entirely on the same instrument and price path. The genuinely independent sample is **three or four** periods, not 89. This establishes profitability *on this BTC path regardless of start date*. It does not establish profitability on BTC paths generally. BTC fell **23.6%** across the window with a **53% peak-to-trough drawdown**; the two-sided short leg contributed materially, and a rising market would not offer that.

### Rejected variants

**Measured at the frozen $250 ladder:** all spacing changes x0.4–x1.5 (worse or breaching); size increases combined with tighter spacing (10–52% breach rates); long-only (mean $555 → $405, **identical** −$1,198 worst day, identical zero breaches).

**Measured at the older $300/$660/$1,500 ladder — direction informative, magnitudes do not transfer:** cost-basis floor ($666 → $409, introduced 6% breaches); $5,000 deployment cap ($666 → $508); $3,000 cap ($666 → $280); soft guard at −$1,000 daily ($666 → $618); 7-day trend filter; notional caps.

### Box-fade event study — the decisive measurement, `[CONFIRMED]`

Raw forward returns after the unsharp box-poke signal, signed in the strategy's direction, no stops, no targets, no costs:

| horizon | SHORT (bps) | LONG (bps) |
|---|---:|---:|
| 1h | −1.00 | −2.06 |
| 2h | −3.23 | −1.14 |
| 4h | −1.12 | +1.22 |
| 8h | −2.22 | **+13.37** (t = 3.93) |
| 24h | −10.41 | +4.44 |

Short is anti-predictive at every horizon. Long has one notable cell at 8h, unsupported by its neighbours, worth +13.37 bps against an **18 bps round-trip cost**. Selection test: best take-profit chosen on PRE alone scored **+5.25R in PRE and −14.67R in POST**.

### Volatility sizing rule — known to be wrong by ~2.2×

Frozen spec §9 sizes a new instrument as `$1,500 ÷ worst observed daily move`. For BTC that gives $10,726 against a $3,928 peak position — apparently a wide margin. But the measured worst day at that peak was **−$1,198**, which is 30.5% of the position, not the 13.98% the rule assumes, because a grid whipsaws and books realised losses in both directions within a day. **The rule understates grid risk by roughly 2.2× and must be corrected with a safety factor before it is used to size SOL, XRP, or anything else.**

### Do not silently convert any of the above into a confirmed fact

Particularly: the 0.033%/night financing rate, the 2:1 leverage, the $100,000 notional, the day baseline, and every figure derived from a single instrument on a single price path.

---

## 9. Files, Documents, Artifacts

### Current authoritative continuity artifact

**`5th_AUTHORITATIVE_PROJECT_STATE_Tradeify_Crypto_Bot.md`** (this document).

### Superseded

`4th_AUTHORITATIVE_PROJECT_STATE_Tradeify_Crypto_Bot.md` and all earlier Project States and session-handoff notes. The 4th remains factually accurate for Chapters 1–25, D-001–D-019's content, and the Chapter 26 four-slot record — but its git facts, its strategy framing, and its "box-fade is the promising candidate" conclusion are all superseded.

### Live and authoritative

- `docs/proposals/grid-golive-policy-change-2026-08-22.md` (Rev 4) — draft D-029 to D-035, the implementation plan, and the open-blocker list.
- `docs/proposals/grid-strategy-spec-2026-08-19.md` — the frozen grid specification. **Supersede, never edit.**
- `docs/implementation-decision-log.md` — governing D-001 to D-027 **on the research branches only**.
- `scripts/research/README.md` — data dependency and safety notes for the backtesters.
- `claude/chapter-26-step-26-1-freeze-contract.md`, `claude/chapter-26-step-26-6-real-data-findings.md` — authoritative for Chapter 26 mechanics and the box-fade research record; historical in effect.
- `claude/decision-D028-box-fade-retirement-DRAFT.md` — draft, unapproved.

### Datasets — on the owner's machine, gitignored, ~52 MB total

- `artifacts/research-bars-btcusd/5m.json` — **36 MB**, dukascopy BTCUSD, 156,941 bars. **Required by both grid backtesters.** Not in git; must be transferred separately to any developer.
- `artifacts/research-bars-btcusd/1d.json` — 549 daily bars, 0.39% zero-volume.
- `artifacts/research-bars/{5m,15m,4h,1d}.json` — ~14.9 MB, the older Binance dataset from the box-fade work. Nothing current reads it; deletable.
- `artifacts/boxfade-results/`, `artifacts/box-edge-study/`, `artifacts/grid-results/`, `artifacts/dxtrade-probe-findings.json`.

**`artifacts/dxtrade-probe-findings.json` (99 KB) may contain account codes or instrument identifiers.** It is covered by the new gitignore rule going forward. **Confirm it was never committed** — if it was, it is still in history.

---

## 10. Work Completed This Window

| Work | Result |
|---|---|
| Box-fade out-of-sample validation | **Failed.** ~300 configurations, PRE/TUNE/POST split, event study, random-entry control, pre-registered fragility conditions triggered. Draft D-028. |
| Nine accounting defects found and fixed | Measured by ablation. All nine had made results worse than reality; corrected, −93.17R → −33.23R. |
| Impossible-fill defect found and fixed | Fake +$19,533 / 94.6% win rate, caught and corrected with an arming check. |
| Grid strategy specified, backtested, frozen | `grid-strategy-spec-2026-08-19.md`. 89/89 profitable, 0/89 breached. |
| Ladder sizing decided | $250/$550/$1,250 over $300/$660/$1,500: $111 less mean profit for **5× the safety margin** ($302 vs $62). |
| Grid spacing sweep | x1 is the only setting that is 100% profitable, 0% breaching, with healthy margin. |
| Long-only tested | −27% profit, identical worst day, identical zero breaches. Rejected. |
| Tradeify account rules researched and corrected | 6% EOT trailing floor, payout lock, 3%-of-account-size daily limit, netting requirement, 20s hold rule. |
| Trailing floor and equity drawdown modelled | `grid-v4.mjs`. Profit change $0.00; closest approach $1,736; worst equity drawdown $1,346. |
| Hedging assessed | Compliant. Zero bars with both sides across ~13M observations. Configuration caveat identified. |
| Policy package written and independently audited | 16 defects found and corrected across four revisions. |
| `.gitignore` fixed | `artifacts/` added on `main` and `grid-implementation-handoff`. ~52 MB of clutter removed from git's view. |
| Handoff committed | `grid-implementation-handoff` at `fdc7b738`. |

**Nothing was done on Chapter 26's official four-slot track in this window.**

---

## 11. Work in Progress

### Grid → implementation

Blocked on owner verifications and approvals. See Section 18.

### Chapter 26 official track

**Unchanged and unaddressed.** All four slots negative; freeze record absent; Steps 26.7–26.9 not started. Needs a formal closure decision — either invoke the contract's "Slot 4 stays empty and shadow-only" fallback and complete the record, or formally close Chapter 26 as superseded. **Leaving it silently abandoned is the worst of the options.**

### D-002, D-007, D-008

Unchanged from the 4th Project State. Not started.

---

## 12. Open Questions and Unresolved Decisions

### Blocking

1. **What is the actual overnight/swap rate?** Worth ~⅓ of profit. Above ~0.06%/night there is no strategy.
2. **Is the DXtrade account in netting or hedging mode?** Hedging mode makes the grid a termination risk regardless of code quality.
3. **Is the daily-limit baseline previous-day balance or equity?** ~$700 of headroom.
4. **What are the real leverage and max notional?** Unverified since the project began.
5. **Does the owner approve D-028 and D-029 to D-035?**
6. **How does Chapter 26's official track get formally closed?**

### Non-blocking but open

- Should `boxFade.js` and its 37 tests be committed as reference code, or is box-fade to leave no code behind at all?
- How should `main` and the research branches be reconciled? Eleven decisions and a `scripts/` folder are missing from `main`; `docs/dxtrade-api-endpoint-reference.md` is missing from the research branches.
- Was `artifacts/dxtrade-probe-findings.json` ever committed?
- Is a PR open for any branch? Not checked this session.
- Everything in the 4th Project State's non-blocking list that has not been overtaken.

---

## 13. Risks and Known Failure Modes

Risks from the 4th Project State's Section 13 remain valid. **New or newly material:**

- **The edge is small and the downside is total.** ~$325/year to the owner against a $50,000 non-replaceable account. Three months of shadow operation costs about $85 of expected profit; a netting misconfiguration costs $50,000. Any argument for moving faster should be weighed against that ratio.
- **The grid has been validated on one instrument and one price path.** The 89 runs are three or four independent periods dressed as 89.
- **Prior live success does not transfer.** The owner has run this grid profitably on multiple coins — **on spot**, where a drawdown is endured indefinitely. That patience is the engine, and this account does not have it.
- **Unbounded deployment via the reset loop.** Did not bind in 545 days (peak $3,928 against a $100,000 ceiling), but *"it did not happen"* is not a risk control. Accepted and documented, not solved.
- **The payout lock can end the account.** Worst measured equity drawdown $1,346 against a post-payout floor with no buffer beneath it. Draft D-035 sets $57,000 / 30 days as the gate — 5.2× the worst observed drawdown.
- **The inactivity rule is the failure mode nobody was looking for.** It is not a risk rule, not a strategy rule, and appears nowhere in the frozen spec or in the first five revisions of the policy package. It closes the account for doing nothing wrong. Any future strategy with a low trade frequency must be checked against it explicitly.
- **A defensive control suppressing a protective one.** Identified and fixed in draft D-033 before implementation. This is the failure mode the project's own rules name explicitly.
- **Post-breach state restoration causing a repeat-breach loop.** Identified before implementation. Not yet coded either way.
- **Governance drift through branch divergence.** Eleven decisions on one branch and not the other is exactly how a future session reads the wrong record and acts on it.
- **A proposal read as a decision.** Mitigated by putting the package under `docs/proposals/`, but the seven draft entries look exactly like real entries. Any reader — human or model — must check the Status line.

---

## 14. Rejected, Deprecated, or Superseded

Entries in the 4th Project State's Section 14 remain valid. **New:**

| Old approach/claim | Why it is not current | Replacement |
|---|---|---|
| Box-fade as the project's promising candidate | Failed out-of-sample. The signal does not cover its own trading cost. | The grid (draft D-031). |
| D-019's box-fade regime band | Governs a retired strategy. | Moot on D-028's approval. |
| Static $47,000 max-loss floor | Tradeify uses a 6% End-of-Trade Trailing floor capped at $50,000, plus a payout lock. | Draft D-032. |
| Hard flat at 21:45 UTC | A grid carries inventory overnight by design. | Draft D-030 — blocked on the financing rate. |
| "One open position maximum" read as one entry at a time | A grid is a laddered single net position. | Draft D-029 — one net position, one instrument, multiple fills. |
| "Deployment is capped at $2,050" | The reset loop makes total deployment unbounded; measured peak notional $3,928. | Accepted documented risk (spec §7.3). |
| Splitting long and short legs across different coins | Correlated majors make it closer to risk-offsetting than the current design; doubles costs; forces half-size grids under one account-level limit; a one-sided grid has no exit mechanism. | Two-sided, one instrument. |
| Long-only operation | −27% profit, identical worst day, identical breaches. | Two-sided. |
| Larger position sizes | 37% of start dates breached at full size, with *lower* mean profit. A breach ejects the grid from the dip it was about to profit from. | $250/$550/$1,250. |
| "Never sell below average cost" | Mean $666 → $409, profitable runs 100% → 74%, and it *introduced* breaches. | Sell 1's small realised loss is buying risk reduction. |
| Citing frozen spec §9 for the 90-day shadow requirement | §9's 90 days scopes to *increasing size*, not to going live. | The shadow gate is new in draft D-034 and owned as such. |
| "boxFade.js is retained in the repository as reference code" | Verified absent from every branch. Never committed. | Box-fade has no code in this repository. |

---

## 15. User Preferences and Working Style

Unchanged from the 4th Project State's Section 15. **Reinforced this window:**

- **The owner repeatedly asks for simple language and worked examples.** They are not a developer. Explanations that lead with mechanism and a concrete number land; explanations that lead with terminology do not. This was requested explicitly more than once and should be treated as a standing instruction.
- **The owner catches contradictions and challenges unsourced numbers.** They flagged a self-contradictory description of a trim function, and they challenged the 0.033% overnight rate — which turned out to be an unverified assumption presented as settled. Assume claims will be checked.
- **The owner wants errors named plainly.** Several of this window's most useful moments were corrections to my own prior work: a fake +$19,533 result from an impossible fill, a "never sell below cost" suggestion that testing showed made things worse, a deployment cap suggestion that also made things worse, and overlapping-window t-statistics that inflated significance. Reporting these directly was received well. Do not soften them.
- **The owner will use the device bridge for file writes but commits and pushes themselves.** Do not attempt a commit or push.
- **The owner moves fast and says "asap."** The right response is to give the fastest *responsible* path with the trade-off stated in numbers, not to slow-walk and not to skip gates.

---

## 16. Communication and Output Conventions

Unchanged from the 4th Project State's Section 16. **Additions:**

- When citing the decision log, **name the branch.** `main` and the research branches differ by eleven entries.
- When stating a git fact, say how it was obtained. This document's SHAs were read directly from `.git/refs/heads/*` via the device bridge.
- Label every draft entry's status in the same breath as its ID. "D-032" alone reads as governing; "draft D-032, unapproved" does not.

---

## 17. Current Strategy / Plan

Phases A, B1 complete (Chapters 1–25). **Phase B2 (Chapter 26 controlled research) is complete in substance and unresolved in governance** — the four-slot track produced an all-negative result and was never formally closed; box-fade was pursued, validated, and failed; the grid emerged and was frozen.

**Current phase: pre-implementation for the grid.** Blocked on four owner verifications and eight approvals.

Phases B3, C, D, E, F unchanged and not started.

---

## 18. Immediate Next Steps

### Step 0 — Owner actions, no code. Blocks everything.

| # | Action | Why it blocks |
|---|---|---|
| 0.1 | Confirm the **overnight/swap rate**. **Not published in Tradeify's docs** — needs a support ticket or a statement. | Worth ~⅓ of profit. Above ~0.06%/night there is no strategy. |
| 0.2 | Confirm the DXtrade account is in **netting mode** | Hedging mode is a termination risk regardless of code quality. |
| 0.3 | Confirm the **day baseline** — previous-day balance or equity snapshot | ~$700 of headroom. Conservative model ships either way. |
| 0.4 | Confirm **leverage and max notional** from the live account | Unverified since the project began. |

### Step 1 — Approvals

D-028 first (prerequisite), then D-029 to D-036. Commit to `docs/implementation-decision-log.md` **on the research branch**. Do not edit the frozen spec in place — supersede it with a versioned successor.

### Step 2 — D-004 Codex Security checkpoint ⛔

**Overdue.** Scope it as a remediation audit over the existing `src/dxtradeClient.js`: credential handling and storage, the `safeApiDescription()` redaction path, session-token lifetime and binding, WebSocket session binding, and any error path that could log a token. High-severity findings corrected and rechecked before Step 3.

### Step 3 — Port the grid to production code

Per `docs/proposals/grid-golive-policy-change-2026-08-22.md` §9. Five modules: `src/strategies/grid.js`, `src/risk/accountRules.js`, `src/execution/orderGuard.js`, `src/state/gridState.js`, and Telegram commands. Three requirements that are easy to get wrong and dangerous when wrong: receipt verification before advancing state; post-breach state reset; restart safety with the reference price intact.

### Step 4 — Stage B (read-only DXtrade), then Stage C (90-day shadow). Step 5 — Stage D, separate decision.

### Step 6 — Housekeeping, any time

- Formally close Chapter 26's four-slot track.
- Reconcile `main` with the research branches.
- Decide whether `boxFade.js` gets committed as reference code or box-fade leaves no code behind.
- Confirm `artifacts/dxtrade-probe-findings.json` was never committed.
- Delete `artifacts/research-bars/` (~14.9 MB, nothing current reads it).

---

## 19. Suggested Opening Instruction for the New Chat

> Open and read `5th_AUTHORITATIVE_PROJECT_STATE_Tradeify_Crypto_Bot.md` in full before taking any action. It supersedes the 4th Project State, whose git facts are stale and whose strategy framing is wrong — **box-fade is retired, not promising.** Then read `docs/proposals/grid-golive-policy-change-2026-08-22.md` (Revision 4) and `docs/proposals/grid-strategy-spec-2026-08-19.md` on branch `grid-implementation-handoff`. The current strategy candidate is a progressive reference-resetting grid on BTC, specified and frozen, backtested at 89/89 profitable and 0/89 breaching across 89 start dates on one instrument and one price path — which is three or four genuinely independent periods, not 89. Seven draft decision entries (D-029 to D-035) and one prerequisite (D-028) are written and **not approved**; do not treat any of them as governing. Verify decision-log numbering against the live file and **name the branch you read it on** — `main` stops at D-016 while the research branches run to D-027. **The D-004 Codex Security checkpoint is overdue**: `src/dxtradeClient.js` already contains DXtrade credentials, authentication, a session token, and a WebSocket session, and the governing rule requires D-004 before any such work; it must run as a remediation audit over that existing file before any further DXtrade work. Keep Stage A simulation-only: Railway `AUTO_EXECUTE=false` and `config/strategy.json` → `execution.autoExecute=false` stay false through every stage currently planned. Four owner verifications block everything — the overnight financing rate, netting versus hedging account mode, the daily-limit baseline, and leverage/max notional; two of them can invalidate the strategy outright, so obtain them before writing code. This session has no GitHub commit/push access and no shell on the owner's machine; it can read and write files in the local working copy via the desktop device bridge, but the owner commits, pushes, and reports GitHub Actions/Railway/Telegram results — label those owner-reported. Never ask the owner to paste a token, owner ID, database credential, DXtrade credential, API key, or session token. Explain each step in simple language with worked examples — the owner is not a developer and has asked for this repeatedly. Give exact complete code with no placeholders, verify what can be verified, never claim something is verified when it is assumed, stop after each step, and ask only genuinely blocking questions.

---

## 20. Critical Context That Is Easy to Miss

- **The 4th Project State's headline is now wrong.** It presents box-fade as "the only genuinely positive result found anywhere in this project." It failed. A session that skims the 4th and acts on that sentence will pursue a dead strategy.
- **D-004 is overdue, and it is easy to read the project instructions as saying it is upcoming.** The trigger fires on credential, authentication, client, **or session** work — not only on order routing. That code exists.
- **`main` and the research branches disagree by eleven decisions.** Any statement about "what the decision log says" is meaningless without the branch name.
- **`boxFade.js` and its 37 tests do not exist in the repository and never did.** Both the 4th Project State and the D-028 draft can be read as implying otherwise. Verified absent 2026-08-22.
- **The grid's 89 profitable runs are not 89 independent results.** They start 5 days apart on the same 545 days of the same instrument. Cite three or four independent periods.
- **The measured edge is ~0.65%/year to the owner after financing and the split.** Anyone reasoning about scaling should start from that number, not from $1,408.
- **The $1,500 daily limit does not grow with the account.** It is 3% of account *size*, fixed. Position size therefore cannot compound with profits, which is why scaling paths are additional instruments or a second account, not larger size.
- **Taking a payout is an account-risk event.** The floor snaps to $50,000 permanently. At the strategy's pace, reaching draft D-035's $57,000 gate would take years — meaning in practice no payout from grid profits for the foreseeable future. If the owner wants earlier payouts, that is legitimate but requires its own decision entry and a substantially smaller ladder.
- **A strategy can be killed by a rule that has nothing to do with risk or performance.** The grid passed every risk check — 89/89 profitable, 0/89 breaching, hedging-compliant, bot-permitted — and would still have been closed three times in 545 days for not trading often enough. Read the whole rulebook, not just the risk section.
- **Any exit that fills better than the market at that moment is a bug.** It produced a fake +$19,533 and a 94.6% win rate in this window before being caught. This is the single most repeatable failure mode found in this project.
- **Non-overlapping sampling matters for t-statistics.** An early event study in this window used overlapping forward windows and badly inflated significance. Rebuilt with non-overlapping samples, box-fade reached |t| ≥ 2 nowhere.
- **The working tree has reverted to `dxtrade-readonly-discovery` unexpectedly more than once.** Read `.git/HEAD` before concluding a file is missing.
- **The device bridge provides file read/write only** — no shell, no git commands. Git facts in this document were obtained by reading `.git/HEAD` and `.git/refs/heads/*` as files. Reuse that technique.

---

## 21. Confidence and Gaps

### High confidence

- Branch heads, decision-log contents per branch, and repository file inventory — read directly via the device bridge on 2026-08-22.
- The absence of `boxFade.js` and `research.boxFade.test.mjs` — directory listings of `src/research/strategies/` and `tests/`.
- The presence of credential/auth/session code in `src/dxtradeClient.js` — read directly.
- Every grid backtest figure in Section 8 — produced by scripts run in this session against the stated dataset.
- Tradeify's published rules as quoted — fetched from the official help centre this session.

### Uncertain or unverified

- **Push state of every branch.** Not read. Ask the owner.
- **GitHub Actions and Railway status.** No access. Owner-reported only.
- **Whether Tradeify's published rules match this specific account.** Everything in Section 8's account-rules block is from the public help centre, not from the owner's dashboard or contract.
- **The overnight financing rate, leverage, max notional, and day baseline.** All unverified; the first can invalidate the strategy.
- **Whether `artifacts/dxtrade-probe-findings.json` was ever committed.** Not checked.
- **The 545-vs-550 day discrepancy** in the dukascopy dataset. Assumed to be data gaps; not confirmed.
- **Whether the grid works on any instrument or price path other than BTC over these 545 days.** It has not been tested. SOL/XRP validation was attempted and blocked by a device disconnection.

### Contradictions resolved in this document

- **Strategy identity:** the 4th Project State says box-fade is the promising candidate; the validation work says it has no edge. Resolved in favour of the validation.
- **Max-loss floor:** D-010 says static $47,000; Tradeify's published rules say 6% end-of-trade trailing capped at $50,000. Resolved in favour of the published rules, flagged as unconfirmed against this account.
- **Decision-log state:** `main` says D-016; the research branches say D-027. Resolved — both are true of their own branch; the research branches are current.
- **boxFade.js status:** described in places as retained reference code; verified absent. Resolved — never committed.

This Project State is sufficient for a new chat to resume without consulting the original conversation.
