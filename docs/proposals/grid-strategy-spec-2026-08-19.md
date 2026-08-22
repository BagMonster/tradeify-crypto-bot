# BTC Grid Strategy — Frozen Specification

**Written:** 2026-08-19, BEFORE any live or paper-forward run.
**Instrument:** BTC only. SOL/XRP explicitly out of scope until §8 conditions are met.
**Status:** Specification frozen. Backtested. **Not yet validated out-of-sample on a second instrument or a second price path.**

---

## 1. What this is

A progressive, reference-resetting grid. Buy into successive declines, sell into successive rallies, re-anchor the reference price after every fill.

Derived from the owner's prior spot bot (PancakeSwap / Pump.fun), adapted for a leveraged prop account with a daily loss limit. **The adaptation is not cosmetic** — see §7.1.

---

## 2. The ladder — FROZEN

Position sizes are **half** the originally proposed scale. That choice is deliberate and is the single most important parameter in this document. See §5.

| | Trigger (from the CURRENT reference) | Size |
|---|---|---|
| **Buy 1** | price falls **4.00%** | **$250** |
| **Buy 2** | falls a further **9.00%** | **$550** |
| **Buy 3** | falls a further **10.00%** | **$1,250** |
| **Sell 1** | price rises **3.75%** | **$250** |
| **Sell 2** | rises a further **7.50%** | **$550** |
| **Sell 3** | rises a further **10.00%** | **$1,250** |

- **The reference price resets to the fill price after every trade.** Levels are cumulative, not absolute.
- Maximum **3 consecutive** trades per side. A trade on the opposite side resets the other side's counter and level pointer to zero.
- **Two-sided:** a sell with no long position opens a short; a buy with no short position opens a long. This differs from the spot original, which could only sell what it owned.
- Maximum deployment in one direction before reversal: **$2,050**.

### 2.1 Worked example (BTC at $70,000)

```
reference $70,000
  -4.0%  -> $67,200   BUY  $250     reference := $67,200
  -9.0%  -> $61,152   BUY  $550     reference := $61,152
 -10.0%  -> $55,037   BUY  $1,250   reference := $55,037     [3 buys — stop]
                                     spent $2,050, hold 0.035427 BTC, avg $57,867

  +3.75% -> $57,101   SELL $250     reference := $57,101
  +7.50% -> $61,383   SELL $550     reference := $61,383
 +10.00% -> $67,522   SELL $1,250   reference := $67,522     [3 sells — reset]
                                     received $2,050, sold 0.031851 BTC

  LEFTOVER: 0.003576 BTC, worth ~$241 — this is the profit.
```

Money is made because the same dollars buy more coin low and require less coin to sell high. **The profit is the coin you never had to sell back.**

---

## 3. Things deliberately NOT included

Each was tested across 89 start dates and made results **worse**. Recorded so they are not re-proposed.

| Rejected | Effect vs baseline |
|---|---|
| "Never sell below average cost" | mean $666 → $409, profitable runs 100% → 74%, **introduced 6% breaches** |
| $5,000 total deployment cap | mean $666 → $508 |
| $3,000 total deployment cap | mean $666 → $280 |
| Soft guard halting entries at −$1,000 daily | mean $666 → $618, worst day barely improved (−$1,438 → −$1,410) |
| 7-day trend filter | mean $561 → $501 at full size |
| Notional caps ($10k–$30k) | no effect — peak notional never reaches them |

**Simple beat clever on every axis.** The only parameter that mattered was size.

*Note on the first row:* the cost-basis rule was proposed to fix a real accounting flaw — Sell 1 does book a small realised loss. Blocking it makes the strategy hold inventory longer, which is exactly the exposure that breaches the limit. The small loss is buying risk reduction.

---

## 4. Account rules — enforced, not assumed

| Rule | Value | Handling |
|---|---|---|
| Daily loss limit | **$1,500** on live equity **including unrealised** | Checked every bar against the 22:00 UTC account day. On breach: force-flat, halt for the day, log it. |
| Max-loss floor | **$47,000** ($50,000 − $3,000) | Terminal. Logged. |
| Max notional | **$100,000** (2× leverage) | Never binds at this size; peak reached is $3,928. |

**The daily limit is the binding constraint, not leverage.** Every design decision in this document follows from that.

---

## 5. Why $250 and not $300 — the central decision

Both ladders were profitable on all 89 start dates with zero breaches. The difference is margin:

| Ladder | Mean profit | Deepest single day | Margin to the $1,500 limit |
|---|---|---|---|
| $300 / $660 / $1,500 | **$666** | −$1,438 | **$62** |
| **$250 / $550 / $1,250** | **$555** | **−$1,198** | **$302** |

The larger ladder came within **$62** of ending the account. One marginally worse day in 18 months and there is no account to run the strategy on.

**$111 of mean profit is a reasonable price for 5× the safety margin on an irreplaceable account.**

### 5.1 Why bigger is not better

At the original full size ($500/$1,100/$2,500), **37% of start dates breached** — and the mean profit was *lower* ($561) than at 0.6× ($666). A breach force-flattens the book mid-drawdown, ejecting the grid from the very dip it was about to profit from. Extra size buys ejection risk and nothing else.

---

## 6. Measured results

### 6.1 Full window (545 days, dukascopy BTCUSD, 2025-02-17 → 2026-08-21)

```
trades                  82
realised            +$1,039.67
unrealised            +$368.72
TOTAL               +$1,408.39
commission paid         $12.52
overnight financing    $344.97   over 542 nights  [UNVERIFIED RATE]
total after financing +$1,063.42
peak notional         $3,928
worst single day       -$465.10   (margin to limit: $1,035)
breaches                     0
```

### 6.2 Robustness — 89 start dates, one every ~5 days, average run 325 days

```
profitable          89 / 89
breaches             0 / 89
mean                  $555
median                $446
worst run              $87
best run            $1,408
deepest single day -$1,198   (margin $302)
avg trades per run       45
```

**Every start date profitable. No start date breached.** The worst outcome across all 89 was +$87.

### 6.3 What these numbers are NOT

The 89 runs start 5 days apart on the **same 545 days of the same instrument**. They overlap almost entirely. The genuinely independent sample is **three or four** non-overlapping periods, not 89.

This result says: *on this BTC path, the strategy is profitable regardless of when you started.* It does **not** say the strategy is profitable on BTC paths generally.

Context: BTC **fell 23.6%** across this window with a **53% peak-to-trough drawdown**. That is a hostile environment for a dip-buying grid, which strengthens the result — but the two-sided short leg contributed materially ($666 vs $486 long-only at the 0.6× ladder), and a rising market would not offer that.

---

## 7. Known risks and unresolved items

### 7.1 ⚠ The spot-versus-prop difference

The owner has run this profitably on multiple coins — **on spot**. On spot, a drawdown is endured indefinitely; that patience is the grid's engine.

**This account cannot wait.** The $1,500 daily limit is measured on paper losses. A position that would have recovered next week ends the account today.

Prior live success is real evidence about the grid mechanic, obtained in an environment where the primary failure mode does not exist. It does not transfer directly.

### 7.2 Overnight financing is unverified and material

At the assumed 0.033%/night (D-010), financing costs **$345 over 542 nights** — roughly a third of the total profit. The rate has never been confirmed against a Tradeify statement. A grid holds inventory near-continuously, so this matters more here than for any strategy previously tested.

**Action:** confirm the actual overnight/swap rate before going live. If it is materially above 0.033%, the strategy may not clear it.

### 7.3 Unlimited deployment via the reset loop

Every sell resets `buy_counts` to zero, so a stair-step decline can deploy capital without bound. It did not bind in 545 days (peak notional $3,928 against a $100,000 ceiling), but *"it did not happen"* is not a risk control. Deployment caps were tested and hurt returns, so none is imposed — this is an **accepted, documented risk**, not an oversight.

### 7.4 The receipt-verification bug (owner-identified)

The prior bot advanced `buy_counts`, the reference price, and the level pointer **before** confirming the swap succeeded. A failed transaction leaves the bot believing it holds inventory it never bought, anchored to a price it never traded.

**Must be fixed before any live run:**

```
threshold reached → attempt order → VERIFY FILL →
    SUCCESS: advance grid, reset reference
    FAILURE: leave grid and reference unchanged
```

### 7.5 Backtest granularity

Tested on 5-minute bars, evaluating bar highs and lows. The live bot polls every ~20 seconds and will catch intrabar moves the backtest misses. Close-only evaluation produced 64 trades and +$2,479 at the 0.6× ladder; high/low evaluation produced 82 trades and +$2,817 — so finer granularity **helped**. Live results should be no worse on this axis.

---

## 8. Project rules requiring relaxation

Neither is a Tradeify requirement; both are project architecture rules. Each needs its own decision-log entry before a live run.

| Rule | Source | Why it must change |
|---|---|---|
| **One open position maximum** | Project instructions §3 | A grid is inherently multi-level. |
| **Hard flat 21:45 UTC** | Direction plan §4 | A grid carries inventory overnight by design. |

Relaxing hard-flat triggers **D-015**, which requires overnight cost modelling to be reinstated — see §7.2.

**Unchanged and not up for negotiation:** `AUTO_EXECUTE=false`, `execution.autoExecute=false`, no order-placement code before lot rules / commissions / stop behaviour / idempotency / rejection handling / reconciliation are verified, and no credentials or secrets exposed anywhere.

---

## 9. Conditions for scaling up or adding instruments

Declared now, so they cannot be relaxed after a good month.

**Before increasing size beyond $250/$550/$1,250:**
1. At least **90 days** of live or shadow operation at this size with zero daily-limit breaches.
2. Confirmed overnight financing rate, with results still positive after it.
3. Live results within a reasonable band of the backtest's ~$555 mean per ~325 days.

**Before adding SOL, XRP or any second instrument:**
1. BTC meets all three conditions above.
2. The new instrument is sized by the volatility rule: **max position = $1,500 ÷ that coin's worst observed daily move.** For BTC (13.98% worst day) that is $10,726; the current ladder peaks at $3,928, well inside it.
3. Combined exposure across all instruments respects the **single** $1,500 daily limit — it is an account-level limit, not per-instrument. Two coins falling together is one breach.

**Sizing guide by volatility** (worst-day move → max position → ladder):

| Worst day | Max position | Ladder |
|---|---|---|
| ~14% (BTC) | $10,700 | $250 / $550 / $1,250 |
| ~20% | $7,500 | $175 / $385 / $875 |
| ~28% | $5,300 | $125 / $275 / $625 |
| ~40% | $3,750 | $90 / $195 / $440 |

**More volatile means smaller, not larger.** Fast coins cycle more often, which is attractive — but the daily limit does not care how fast you cycle, only how far the position moves in one day.

---

## 10. What would falsify this

Recorded in advance so a bad result is read honestly rather than explained away.

- **Any daily-limit breach** in live or shadow operation. The backtest says zero across 89 starts; one real breach means the model is wrong about the tail.
- **A losing 90-day stretch.** All 89 backtested runs were profitable; a losing quarter is outside everything observed.
- **Live trade count materially below ~45 per 325 days.** Would suggest the 20-second poll behaves differently from the bar-based model.
- **Overnight financing above roughly 0.06%/night**, which would consume the entire edge.

Any of these means stopping and re-examining, not adjusting parameters until the number recovers.
