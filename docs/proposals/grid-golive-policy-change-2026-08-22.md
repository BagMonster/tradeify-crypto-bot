# Grid Strategy — Policy Change Package and Implementation Handoff

**Prepared:** 2026-08-22 · **Revision 3** — audit corrections applied, decision numbering verified against the repo. See §12.
**For:** the developer or agent taking the grid strategy from research to implementation
**Status:** DRAFT decision-log entries. **Owner approval required before any are committed.**
**Target file for entries:** `docs/implementation-decision-log.md`

---

## 0. Read this first

### 0.1 ⛔ The project is already in violation of the D-004 trigger

Before anything else in this document: **`src/dxtradeClient.js` (491 lines) already contains DXtrade credential, authentication, session, and client code.** It has `login()` posting a username and password to `/login`, a private `#sessionToken`, an `authorization: DXAPI <token>` header, a keep-alive `ping()` loop, `logout()`, a Push-API WebSocket session, and a `GET /orders` read path.

The governing rule reads:

> "Before Chapter 19—or before any earlier DXtrade **credential, authentication, client, session, API, or order-routing** work—stop and enforce the D-004 Codex Security checkpoint. High-severity findings must be corrected and rechecked before continuing."

All four of the first-named categories exist in the repository today. **D-004 is overdue, not upcoming.** It must run as a remediation audit **over the existing file**, covering at minimum: credential handling and storage, the redaction path (`safeApiDescription()`), session-token lifetime and binding, the WebSocket session-binding logic, and error paths that could log a token.

The client is read-only — there is no order-placement method — which limits the blast radius. It does not remove the obligation. Everything in §9 of this document is blocked behind D-004, and D-004 must be scoped to audit what already exists, not just what comes next.

### 0.2 The two-minute version

Chapter 26 research was built around a **box-fade** strategy that has since been retired (D-028, draft). A **progressive reference-resetting grid on BTC** has been specified, backtested, and frozen. The grid is structurally incompatible with three project rules written for box-fade. Those rules must be formally changed before implementation begins.

Six draft entries follow: **D-029 to D-035**. None weakens an account protection; three make protections stricter.

### 0.3 What is NOT changing, and is not negotiable

- `AUTO_EXECUTE=false` (Railway) and `execution.autoExecute=false` (strategy config) stay **false through every stage in this document**, including Stage B and Stage C. Nothing here flips them.
- No **new** DXtrade credential, authentication, session, client, API, or order-routing work before D-004 passes — and D-004 must audit the existing client (§0.1).
- No secrets in chat, code, logs, screenshots, or documentation.
- Durable pause, restricted resume, account lockout, risk floors, daily controls, and audit logging all remain.
- **A permissive or defensive condition may never suppress a blocking safety gate.** D-033 makes this explicit for the new controls.

### 0.4 Numbering — verified

**Verified 2026-08-22** against `docs/implementation-decision-log.md` on branch `grid-implementation-handoff` (97,011 bytes): the committed log runs **D-001 through D-027**. D-028 is the next free ID.

So the numbering in this package is correct as written, with one prerequisite:

1. **D-028** (box-fade retirement, `claude/decision-D028-box-fade-retirement-DRAFT.md`) must be committed first.
2. **D-029 to D-035** then follow as numbered here.

**D-028 is a substantive dependency, not just a numbering one.** D-031 adopts the grid on the basis that D-028 retired box-fade. If D-028 is not approved, D-020 still makes box-fade the sole active strategy and D-031 becomes a *conflicting* entry rather than a successor. **Approve D-028 before or together with this package.**

**Separately — `main` is four decisions behind.** Its decision log stops at **D-016** and it has no `scripts/` folder. D-017 to D-027 exist only on the research branches. The deployed branch does not reflect the approved decision record; this should be reconciled, but it is out of scope for this package.

---

## 1. What changed since the last Project State

| Area | Before | Now |
|---|---|---|
| Active strategy | Box-fade (D-020) | **Retired** (D-028 draft). Grid is the candidate. |
| Position model | One open position, sequential only | One **net** position, built and reduced by multiple fills, **one instrument at a time** |
| Overnight | Hard flat 21:45 UTC | Inventory carried across the 22:00 UTC roll by design |
| Max-loss rule | Static $47,000 floor (assumed) | **6% end-of-trade trailing** floor, ratchets up, caps at $50,000 |
| Payout | Not modelled | **A payout is an account-risk event.** Floor snaps to $50,000. New D-035. |
| Daily limit | $1,500 on equity | **$1,500 (3% of the $50,000 account size)** subtracted from the **previous day's closing balance**, checked continuously against live equity including unrealised |
| Hedging | Not considered | Netting mode is now a hard pre-flight requirement |
| Instruments | BTC + SOL under consideration | **BTC only, one at a time.** SOL/XRP gated. |
| D-004 | Believed upcoming | **Overdue** (§0.1) |

---

## 2. DRAFT D-029 — Position model: one net position, one instrument, multiple fills

| Field | Content |
|---|---|
| **ID** | D-029 |
| **Trigger** | Grid strategy adoption, 2026-08-22 |
| **Baseline** | Project instructions §3: "One open trading position maximum" and "Sequential trades allowed after the previous position is closed." Written for a single-entry, single-exit strategy. |
| **Decision** | Restated as: **one net position, in one instrument, at any time.** Multiple fills may build, reduce, or reverse that net position. Concurrent positions — in the same instrument or in different instruments — remain prohibited. Multi-instrument concurrency is **not** authorised by this entry and requires its own decision. |
| **Rationale** | A grid is a laddered single net position, not multiple positions. Across the 89-start-date backtest (~13 million bar-observations) the simulated account held a long on 71.6% of bars, a short on 27.2%, was flat on 1.2%, and held **both simultaneously on zero bars**. The original rule's intent — bounded concurrency, no stacking — is preserved exactly. |
| **Safety effect** | **Neutral to stronger.** What was previously an assumption is now enforced by a broker-side netting requirement and a runtime assertion (D-033). The single-instrument constraint is retained deliberately so this entry cannot later be read as pre-authorising a second coin. |
| **Affected work** | Position accounting in the production strategy module; runtime guard; tests. |
| **Verification** | Position-state census reproducible from `grid-v3.mjs`; runtime assertion test against a simulated dual-position broker response. |
| **Status** | **PROPOSED 2026-08-22 — owner approval required** |

---

## 3. DRAFT D-030 — Overnight inventory permitted; hard-flat retired for the grid

| Field | Content |
|---|---|
| **ID** | D-030 |
| **Trigger** | Grid strategy adoption, 2026-08-22 |
| **Baseline** | Multi-asset direction plan §4: hard flat all positions at 21:45 UTC, before the 22:00 UTC account roll. |
| **Decision** | The grid carries inventory across the account-day boundary. The 21:45 UTC hard flat is **retired for the grid strategy**. The forced flatten on a daily-limit breach is **retained, unchanged, and takes precedence over every other control** (see D-033). |
| **Rationale** | A grid holds inventory near-continuously by design; flattening nightly destroys the mechanism and realises losses the strategy exists to avoid. Backtested with overnight carry over 542 nights: 0 breaches across 89 start dates. |
| **Consequence** | **Reinstates D-015** — overnight cost modelling becomes mandatory, not optional. |
| **⛔ Blocking condition** | **Cannot be implemented until the actual Tradeify overnight/swap rate is confirmed** against a statement or contract specification. At the *assumed* 0.033%/night the cost is $344.97 over 542 nights — roughly one third of total profit. Above roughly 0.06%/night the strategy has no edge left. The rate has **never** been verified; it originates in D-010/D-015 as an assumption. |
| **Daily-limit interaction** | Because the day baseline is the previous day's **closing balance**, inventory carried overnight means day N+1 opens with existing unrealised P&L already counting against that day's $1,500. The backtest models this conservatively; see D-032. |
| **Status** | **PROPOSED — owner approval required. BLOCKED on financing-rate verification.** |

---

## 4. DRAFT D-031 — Grid adopted as the active strategy candidate

| Field | Content |
|---|---|
| **ID** | D-031 |
| **Trigger** | Closes the successor question opened by D-028 |
| **Baseline** | D-020 made box-fade the sole active strategy. D-028 retired it, leaving no candidate. **This entry is void unless D-028 is approved** (§0.4). |
| **Decision** | The **progressive reference-resetting grid on BTC** is adopted as the active strategy candidate, governed by the frozen specification `claude/grid-strategy-spec-2026-08-19.md`. |
| **Frozen parameters** | Buy ladder: **−4.00% / $250**, then a further **−9.00% / $550**, then a further **−10.00% / $1,250**. Sell ladder: **+3.75% / $250**, **+7.50% / $550**, **+10.00% / $1,250**. Reference resets to the **actual fill price** after every trade. Max **3 consecutive** per side; an opposite-side trade resets the other side's counter and pointer. Two-sided. |
| **⚠ Deployment is NOT capped at $2,050** | $2,050 is the maximum for one **unbroken run of three same-side fills**. Because every opposite-side fill resets the counter to zero, a stair-step decline can re-arm the buy ladder indefinitely. **Total deployment is unbounded by design.** Measured peak notional was **$3,928** — 1.9× the $2,050 figure. Deployment caps were tested and *hurt* returns ($5,000 cap: mean $666 → $508; $3,000 cap: $666 → $280), so none is imposed. This is an **accepted, documented risk** carried forward from frozen spec §7.3, not an oversight. **A developer must not hard-cap deployment at $2,050.** |
| **Evidence** | 545 trading days of dukascopy BTCUSD 5-minute bars spanning 2025-02-17 to 2026-08-21 (550 calendar days; the 5-day difference is data gaps and should be reconciled). 89 start dates: **89/89 profitable, 0/89 breached.** Mean $555/run (~325 days), median $446, worst run +$87, best $1,408. Deepest single day −$1,198 (margin $302). Worst peak-to-trough **equity** drawdown across all runs: **$1,346**. Peak notional $3,928 against a $100,000 ceiling. |
| **Net of costs** | Commission and slippage (0.04% + 0.05% per fill) are **inside** the $555. Assumed overnight financing is **not** — it removes roughly $207–$217 per 325-day run, leaving **~$340**. The 95% profit split then leaves the owner roughly **$325 per ~325 days**, or about **0.65%/year on $50,000**. This is the honest size of the edge. |
| **⚠ Known limitation** | The 89 runs overlap almost entirely on the same instrument and price path. The genuinely independent sample is **three or four** periods, not 89. This establishes that the strategy is profitable *on this BTC path regardless of start date*. It does **not** establish profitability on BTC paths generally. BTC fell 23.6% across the window with a 53% peak-to-trough drawdown; the two-sided short leg contributed materially, and a rising market would not offer that. |
| **⚠ Rejection list is partially stale** | The rejected variants in frozen spec §3 (cost-basis floor, $5,000 and $3,000 deployment caps, soft guard, trend filter, notional caps) were measured against a **$666 mean baseline — the $300/$660/$1,500 ladder**, not the frozen $250/$550/$1,250 ladder. Their *direction* is informative; their magnitudes do not transfer. They should not be re-proposed casually, but "already settled at the shipping size" would be an overstatement. |
| **Rejections that WERE measured at the frozen ladder** | Spacing changes (x0.4 to x1.5 — all worse or breaching); size increases combined with tighter spacing (10–52% breach rates); long-only operation (mean $555 → $405, **identical** −$1,198 worst day, identical zero breaches). |
| **Status** | **PROPOSED — owner approval required** |

---

## 5. DRAFT D-032 — Account rule model corrected against Tradeify documentation

| Field | Content |
|---|---|
| **ID** | D-032 |
| **Trigger** | Review of Tradeify Crypto published rules, 2026-08-22 |
| **Baseline** | D-010 recorded a $1,500 daily loss limit and a **static** $3,000 max-loss offset ($47,000 floor). The static floor was an assumption and was never verified. |
| **Decision** | Replace the account-rule model with the version below. **Source for items 1–3 is Tradeify's published help centre, not a statement from the owner's own account.** Confirm against the live dashboard before relying on any of it. |

**1. Daily loss limit** — *source: published rules, unconfirmed against this account*

- The **limit amount** is **3% of the account size** — a fixed **$1,500** on a $50,000 account. It does **not** scale with the previous day's balance.
  Tradeify's own worked example: a $100,000 account with a $101,500 snapshot balance has a **$3,000** limit (3% of 100,000, not of 101,500) and a floor of $98,500.
- The **baseline** it is subtracted from is the **previous trading day's closing balance**.
- The check runs **continuously against live equity including unrealised P&L**. Published wording: *"the breach check uses live equity, so an open losing trade can breach the account before you close it."*
- The account day rolls at **22:00 UTC**.

**2. Max loss** — *source: published rules, unconfirmed against this account*

- **6% End-of-Trade Trailing Balance.** Floor = highest **closed-trade** balance − $3,000, ratcheting up only, **capped at the $50,000 starting balance**. Once the highest closed-trade balance reaches $53,000 the floor is permanently $50,000.
- Replaces the static $47,000 assumption in D-010.

**3. Payout lock** — *source: published rules.* Any payout, of any size, permanently fixes the floor at the $50,000 starting balance. See **D-035** — this interacts with the strategy in a way that can end the account.

**4. Leverage and notional** — **UNVERIFIED.** 2:1 on all crypto pairs and a $100,000 max notional are recorded in the project instructions as *"subject to later verification"* and remain so. No source in this package verifies them. They do not currently bind (peak notional $3,928), so the risk is low, but they must not be described as confirmed.

| Field | Content |
|---|---|
| **Measured impact of the trailing floor** | Implemented in `grid-v3.mjs` and re-run across all 89 start dates. **Profit change: $0.00. Breaches: 0. Closest approach to the trailing floor across all runs: $1,736.** The static $47,000 assumption was harmless *at this position size and before any payout* — the daily limit binds first, by a wide margin. |
| **⚠ Unresolved: the day baseline** | Tradeify's Instant Funding page says the floor derives from the previous day's closing **balance**; the rules overview describes the intraday check against **equity**. If the baseline is balance (realised only), the current conservative model is correct: worst day −$1,198, margin $302. If it is an equity snapshot including unrealised, the worst day is −$498 and the margin is $1,002. **The conservative model ships regardless of what a dashboard reading suggests.** A dashboard observation is not verification of a contractual rule; only a Tradeify statement, contract specification, or written support confirmation may relax it, and that relaxation needs its own decision-log entry. |
| **Affected work** | Risk module; `grid-btc.mjs` config; frozen spec §4; any code referencing a static $47,000. |
| **Status** | **PROPOSED — owner approval required** |

---

## 6. DRAFT D-033 — No-hedging compliance, netting mode, and control precedence

| Field | Content |
|---|---|
| **ID** | D-033 |
| **Trigger** | Owner question on hedging exposure, 2026-08-22 |
| **Tradeify rules (verbatim)** | *"Hedging is not allowed. You cannot hold simultaneous long and short positions in the same instrument to offset risk."* Also prohibited: cross-account hedging between multiple Tradeify accounts; group trading between accounts owned by different users. *"Violations may result in immediate account termination."* Separately: *"All trades must be held for at least 20 seconds."* |
| **Assessment** | The grid is **compliant**. It maintains one signed net position. A sell reduces an existing long and, only once that long is fully closed, opens a short — it nets *through* zero rather than opening an opposing position alongside. Sequential direction change is not hedging. Verified empirically: **zero bars with simultaneous long and short across ~13 million bar-observations.** |
| **The actual risk** | Compliance depends on **platform configuration**, not on strategy logic. DXtrade supports both netting and hedging account modes. In hedging mode an opposing order may open a separate position rather than netting — producing the prohibited state by accident. |

### Three mandatory controls

**Control 1 — Netting mode confirmed.** The DXtrade account must be confirmed in netting mode, with the evidence recorded, **before the first real session is opened in Stage B** — not deferred to Stage C, which sends no orders at all.

**Control 2 — Dual-position runtime assertion.** On every reconciliation cycle, if the broker reports more than one open position in a symbol, the bot raises a hedging alert to the owner via Telegram and enters a restricted state. **It does not stop running its risk checks** (see precedence below).

**Control 3 — Minimum-hold guard, on entries only.** No **entry or grid-level** fill within **25 seconds** of the previous fill (a 5-second buffer over Tradeify's 20-second rule). A deferred level is queued, not cancelled, and the deferral is logged. **This guard never applies to a protective exit.**

### ⛔ Control precedence — this clause is load-bearing

Ordered from highest authority. A lower-numbered control always overrides a higher-numbered one.

1. **Daily-limit force-flatten and max-loss protection.** Executes immediately and unconditionally. It is **not** delayed by the 25-second guard, is **not** suppressed by the hedging halt, and is **not** blocked by a pause state. If a breach occurs within 20 seconds of a fill, the flatten still fires: Tradeify's own liquidation would fire regardless, and a min-hold infraction is a recoverable dispute while a blown daily limit is not. The conflict is logged as an incident.
2. **Hedging alert / restricted state.** Blocks all *new* entries. Does not block protective exits. Because an un-netted hedged position is itself a termination risk, the restricted state must **also** flatten to a single net position if the owner does not respond within a defined window — the window and the default action require owner sign-off before implementation.
3. **Durable pause / restricted resume.** Blocks new entries. Never blocks protective exits.
4. **25-second minimum-hold guard.** Defers entries only.

**No control below line 1 may ever delay or suppress line 1.** Any implementation in which the min-hold guard, the halt state, or a pause can postpone a protective close is a defect, not a configuration choice.

| Field | Content |
|---|---|
| **Rejected: split legs across coins** | Long BTC / short SOL was proposed and rejected. Correlated majors make it closer to genuine risk-offsetting than the current design; it doubles commission and financing against a partly self-cancelling net exposure; the $1,500 limit is account-level, so it forces half-size grids with no diversification credit; and a one-sided grid has **no exit mechanism** — it accumulates into a losing position with no brake, because what closes a grid position is the *same* instrument's reversal. |
| **Rejected: long-only** | Measured at the frozen ladder: mean $555 → $405 (−27%), with an **identical** −$1,198 worst day and identical zero breaches. One-sided operation costs profit and buys no risk reduction. |
| **Status** | **PROPOSED — owner approval required** |

---

## 7. DRAFT D-035 — Payout policy: a payout is an account-risk event

*(Numbered after D-034 in the log; presented here because it belongs with the risk model.)*

| Field | Content |
|---|---|
| **ID** | D-035 |
| **Trigger** | Payout-lock interaction discovered 2026-08-22 |
| **The problem** | Any payout permanently fixes the max-loss floor at the **$50,000 starting balance**. Before a payout the floor sits $3,000 below the highest closed-trade balance; after one it sits at $50,000 with no buffer beneath it. **The backtest does not model this** — `grid-v3.mjs` implements only the pre-payout trailing floor, so the reassuring "$1,736 closest approach" figure in D-032 does **not** apply to a post-payout account. |
| **The measured danger** | Worst peak-to-trough **equity** drawdown across the 89 runs: **$1,346**. Deepest single day: **$1,198**. An account that takes a payout at, say, $50,300 has $300 of room beneath it and would have been closed by the ordinary behaviour of this strategy — not by a tail event, but by a drawdown it produced in the median-to-bad case. |
| **Decision** | **No payout may be requested until account equity has been at or above $57,000 for at least 30 consecutive days**, and no payout may reduce equity below **$55,000**. |
| **Why $57,000** | It leaves a **$7,000** buffer above the post-payout $50,000 floor — **5.2× the worst observed equity drawdown ($1,346)**, and 5.8× the deepest single day. Worst-observed is not worst-possible; on a one-account, non-replaceable balance a 5× factor is the appropriate margin. This formalises the owner's own stated intent and now has a number behind it. |
| **Also required** | The trailing floor caps at $50,000 once the highest closed-trade balance reaches $53,000. At $57,000 the floor is therefore $50,000 whether or not a payout has occurred — so waiting costs nothing in floor terms. The reason to wait is entirely the **buffer**, not the lock. |
| **Implementation** | The risk module must model both floors: pre-payout `min($50,000, peakClosedBalance − $3,000)` and post-payout a hard `$50,000`. A payout flag must be persisted, and Telegram must refuse a payout request that violates this entry. |
| **Reality check** | At ~$325/year net to the owner, reaching $57,000 on strategy profit alone would take many years. **This entry means, in practice, that no payout is taken from grid profits in the foreseeable future.** If the owner wants earlier payouts, that is a legitimate choice — but it requires a decision-log entry that explicitly accepts running the strategy on a $50,000 hard floor with roughly $300–1,000 of room, and the strategy would need to be resized substantially downward to survive it. |
| **Status** | **PROPOSED — owner approval required** |

---

## 8. DRAFT D-034 — Staged go-live gate

**This is a gate, not a relaxation. It defines what must be true before the execution locks may be discussed at all.**

**Provenance note:** the 90-day shadow requirement below is **new in this entry**. Frozen spec §9's 90-day condition scopes to *increasing size beyond the frozen ladder*, not to going live. The spec does not require a shadow period before live. Do not cite §9 as its source.

**Stage A — Simulation (current).**
Locks: `AUTO_EXECUTE=false`, `execution.autoExecute=false`. Research code only, never imported by `index.mjs`.
**Exit requires:** D-028 approved; D-029 to D-035 approved and committed; overnight financing rate confirmed; netting mode confirmed; day-baseline question resolved or the conservative model formally locked in; **D-004 Codex Security checkpoint passed as a remediation audit over the existing `src/dxtradeClient.js` (§0.1)**, with all high-severity findings corrected and rechecked.

**Stage B — Read-only DXtrade integration.**
Locks: **`AUTO_EXECUTE=false`, `execution.autoExecute=false` — unchanged.** Authentication, market data, account state, reconciliation. **No order-placement code exists in the repository at this stage.**
**Exit requires:** netting mode confirmed with recorded evidence (D-033 Control 1); live DXtrade prices reconciled against dukascopy within a documented tolerance; account state (balance, equity, both floors) read correctly and matching the dashboard; lot rules, tick size, minimum order size, and the commission schedule read from the live instrument definition rather than assumed; the 2:1 leverage and $100,000 notional figures in D-032 item 4 finally verified.

**Stage C — Shadow mode.**
Locks: **both remain false.** Full strategy running against live DXtrade data, generating and logging the orders it *would* place, placing none.
**Minimum 90 days.**
**Exit requires:** zero daily-limit breaches; zero hedging assertions; the receipt-verification path exercised against real rejections and timeouts; state survives a forced worker restart mid-grid with the reference price intact; **D-007** complete (`docs/telegram-command-reference.md`, `/help` synchronised, linked from the README, every command and inline button tested for authorised and unauthorised behaviour).
**Performance is compared, not gated.** Over 90 days the model expects roughly **12 trades and ~$154 gross** — far too small a sample to pass or fail on. Shadow performance is recorded and compared to the model; a divergence prompts investigation, not an automatic stop.

**Stage D — Live, minimum size.** Requires a separate, explicit owner decision-log entry. **Not authorised by this package.**

### Falsification conditions — declared in advance, with horizons

Vague falsifiers are unfalsifiable. Each now has a measurement window.

| Condition | Horizon | Action |
|---|---|---|
| **Any daily-limit breach** | Immediate | Stop. The backtest says zero across 89 starts; one real breach means the model is wrong about the tail. |
| **Any hedging assertion firing** | Immediate | Stop. Indicates a netting misconfiguration. |
| **Cumulative P&L negative** | At **180 days**, not 90 | Stop and re-examine. A single 90-day window can be negative through ordinary variance; 180 days is the shortest honest test. |
| **Trade count below 20** | At **180 days** (model expects ~25) | Investigate — suggests the poll behaves differently from the bar-based model. |
| **Overnight financing above 0.06%/night** | On verification | Stop. Consumes the entire edge. |

Any of these means stopping and re-examining — **not** adjusting parameters until the number recovers.

**Status: PROPOSED — owner approval required.**

---

## 9. Implementation plan — ordered, with gates

### Step 0 — Owner actions, no code. Blocks everything.

Three of these cost nothing and two can invalidate the strategy.

| # | Action | Why it blocks |
|---|---|---|
| 0.1 | Confirm the **overnight/swap rate** from a statement or contract spec | Worth ~⅓ of profit. Above ~0.06%/night there is no strategy. Blocks D-030. |
| 0.2 | Confirm the account is in **netting mode** | Hedging mode makes this a termination risk regardless of code quality. Blocks D-033. |
| 0.3 | Confirm the **day baseline** (previous-day balance vs equity snapshot) | ~$700 of headroom. Note: the conservative model ships either way (D-032); this only tells us how much margin we actually have. |
| 0.4 | Confirm **leverage and max notional** from the live account | Recorded as unverified since the project began. |

### Step 1 — Approve and commit the policy changes

Owner approves D-028 (prerequisite) and D-029 to D-035. Renumber if the earlier drafts are not committed. Append to `docs/implementation-decision-log.md`.

**Do not edit the frozen spec in place.** It is dated *"Written 2026-08-19, BEFORE any live or paper-forward run"* — that pre-registration is its evidentiary value, and editing it destroys it. Issue `claude/grid-strategy-spec-v2-<date>.md` marked as superseding, and add a one-line supersession note to the original.

### Step 2 — D-004 Codex Security checkpoint ⛔

**Mandatory, overdue, and scoped as remediation over the existing `src/dxtradeClient.js`** (§0.1). High-severity findings corrected and rechecked before anything in Step 3 begins.

### Step 3 — Port the strategy to production code

The research backtester is **not** production code. It has no broker, no persistence, and no failure handling.

| Module | Responsibility |
|---|---|
| `src/strategies/grid.js` | Pure decision function `(state, price) → intent`. No I/O. Deterministic. Ladder and reference-reset logic ports directly from `grid-btc.mjs`. |
| `src/risk/accountRules.js` | Daily floor, **both** max-loss floors (pre- and post-payout, per D-035), notional cap — all on live equity including unrealised. Checked **before** every intent is acted on, never after. |
| `src/execution/orderGuard.js` | Receipt verification, 25s entry guard, netting assertion, idempotency keys, **and the control-precedence ordering in D-033**. |
| `src/state/gridState.js` | Persist reference price, level pointers, side counters, position, payout flag to PostgreSQL. |
| Telegram | `/grid` status, `/pause`, `/resume`, payout guard, alerts on halt / assertion / breach. Feeds D-007. |

**Three requirements that are easy to get wrong and dangerous when wrong:**

**(a) Receipt verification.** The prior bot advanced the grid before confirming the fill.

```
threshold reached → attempt order → VERIFY FILL →
    SUCCESS: advance level pointer, increment side counter, reset reference to the ACTUAL FILL price
    FAILURE: leave pointer, counter, and reference completely unchanged
```

A failed order that advances state leaves the bot believing it holds inventory it never bought, anchored to a price it never traded. Every subsequent decision is then wrong. Note the reference must be the **fill** price, not the trigger price — the backtest models 0.05% slippage, and live that difference compounds through every subsequent level.

**(b) Post-breach state reset — omitted from the first revision of this document, and the most dangerous remaining silent-corruption path.** After a daily-limit force-flatten, `grid-btc.mjs` sets `buyCount = 0; buyPtr = 0; sellCount = 0; sellPtr = 0` and re-anchors the reference to the flatten fill price. **A developer who faithfully persists and restores pre-breach state will resume the next day anchored to a stale reference and immediately redeploy the full ladder into the same move — a repeat-breach loop that can end the account in days.** The reset is a hard requirement. The same applies after a D-033 hedging halt and after any restricted resume.

**(c) Restart safety.** State must survive a worker restart mid-grid. A lost or stale reference price is a silent corruption with no error message.

### Step 4 — Stage B, then Stage C shadow (90 days minimum). Step 5 — Stage D, separate decision.

---

## 10. Code status — what exists, what does not

| Artifact | Status | Hand over as-is? |
|---|---|---|
| `grid-btc.mjs` | Research backtester; produces the D-031 figures | **Yes** — reference implementation of ladder logic and account-rule checks |
| `grid-v3.mjs` / `grid-v4.mjs` | Adds trailing-floor model, corrected day baseline, position-state census, equity-drawdown tracking | **Yes** — reference for D-032 and D-035 |
| `claude/grid-strategy-spec-2026-08-19.md` | Frozen specification | **Yes** — this is the contract. Supersede, do not edit. |
| `src/dxtradeClient.js` | Read-only DXtrade client with credentials, auth, session, WebSocket | **Exists already. Must be audited under D-004 before any further use** (§0.1). |
| `src/research/strategies/boxFade.js` + 37 tests | Retired, retained as reference | Leave in place, unused |
| **Production grid module** | **Does not exist** | Build in Step 3 |
| **Order-placement code** | **Does not exist and must not be written before Step 2 passes** | — |

The backtesters read `artifacts/research-bars-btcusd/5m.json` (dukascopy BTCUSD, 156,941 five-minute bars) relative to the working directory. Neither imports from `src/`. Neither has a broker client — neither can place an order.

---

## 11. Open blockers

| # | Blocker | Owner | Severity |
|---|---|---|---|
| 1 | **D-004 overdue** — credentials, auth, session, client already in the repo | Dev | **Governance violation. Hard gate.** |
| 2 | Overnight financing rate unverified | Owner | **Can invalidate the strategy** |
| 3 | Netting vs hedging mode unconfirmed | Owner | **Termination risk** |
| 4 | Payout lock unmodelled in the backtester | Dev | **Account-ending if a payout is taken early** (D-035) |
| 5 | Post-breach state reset unspecified in any prior document | Dev | **Repeat-breach loop** (§9 Step 3b) |
| 6 | Control precedence unspecified | Dev | A defensive guard could delay a protective close (D-033) |
| 7 | Day-limit baseline unconfirmed | Owner | Material — ~$700 headroom |
| 8 | Leverage / max notional unverified since project start | Owner | Low (does not currently bind) |
| 9 | Validated on one instrument, one price path | Dev | Structural — see D-031 |
| 10 | Frozen spec §9 volatility sizing rule understates grid risk by ~2.2× | Dev | Blocks any second instrument — see below |
| 11 | Production module, state persistence, order guard not built | Dev | Step 3 |
| 12 | D-026, D-027, **D-028** awaiting owner approval | Owner | D-028 blocks D-031 substantively |

**On blocker 10:** frozen spec §9 sizes a new coin as `$1,500 ÷ worst observed daily move`. For BTC that gives $10,726 against an actual peak position of $3,928 — apparently a wide margin. But the measured worst *day* at that $3,928 peak was **−$1,198**, which is 30.5% of the position, not the 13.98% the rule assumes. A grid whipsaws and books realised losses in both directions within a single day, so its daily loss is not simply mark-to-market on peak notional. **The rule understates grid risk by roughly 2.2× and must be corrected — with a safety factor — before it is used to size SOL, XRP, or anything else.**

---

## 12. Revision history

**Revision 3 (2026-08-22)** — numbering verified against `docs/implementation-decision-log.md` on `grid-implementation-handoff`: the committed log runs to D-027, so D-028 is next free and this package's numbering stands. Recorded that `main`'s log stops at D-016.

**Revision 2 (2026-08-22)** — rewritten after an independent audit. Changes: D-004 reclassified as overdue with existing-code scope (§0.1); D-029 constrained to one instrument rather than one-per-instrument; D-031 corrected on unbounded deployment, stale rejection baselines, net-of-cost figures and day count; D-032 relabelled from "verified" to sourced-but-unconfirmed, daily-limit formula stated precisely, leverage/notional marked unverified; D-033 gained an explicit control-precedence clause and moved the netting check to Stage B; **D-035 added** for the payout lock; D-034 owns the 90-day shadow as new rather than citing spec §9, adds horizons to the falsifiers, restates the locks in Stage B, and stops gating on a statistically meaningless 90-day P&L; §9 Step 3 gained post-breach state reset; Step 1 now supersedes the frozen spec rather than editing it; blocker 10 added on the volatility sizing rule.

**Revision 1 (2026-08-22)** — initial package, D-029 to D-034.
