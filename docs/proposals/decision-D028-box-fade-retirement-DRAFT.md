# Draft decision-log entry D-028 — Box-fade retirement

**Status:** DRAFT for owner review. Not committed.
**Prepared:** 2026-08-19. **Target file:** `docs/implementation-decision-log.md`
**Numbering: VERIFIED 2026-08-22.** The committed log on `grid-implementation-handoff` runs D-001 to D-027 (97,011 bytes). **D-028 is the correct next free ID** — no renumbering needed.

**Prerequisite status:** this entry is a hard prerequisite for draft D-031 (grid adoption). Until D-028 is approved, D-020 still makes box-fade the sole active strategy and D-031 would be a conflicting entry rather than a successor.

---

## Table row to append

| ID | Chapter / trigger | Baseline | Decision | Effect / rationale | Affected work | Verification | Status |
|---|---|---|---|---|---|---|---|
| D-028 | Box-fade validation, 2026-08-18/19 — closes the condition set by D-020 pt 2 | D-020 made box-fade the sole strategy under active consideration, conditioned on out-of-sample validation before it could be treated as more than a promising in-sample finding. Its supporting result was +$477.01 over 16 trades on Binance BTCUSDT, folds 1–4, produced by sandbox code that no longer exists. | **Box-fade is retired from active consideration.** It failed out-of-sample validation on ~550 days of dukascopy BTCUSD data containing the original 123-day tuning window plus ~426 days never used for tuning. The condition in D-020 pt 2 is now resolved, negatively. No box-fade variant may be proposed for live, paper-forward, or shadow use without new evidence of a kind not yet obtained — specifically, a positive result on data selected before the parameters were. | The strategy has no measurable directional edge. An event study of forward returns after the unsharp box-poke signal — no stops, no targets, no costs — found the SHORT setup negative at four of five horizons (−1.00 to −10.41 bps) and the LONG setup's single positive cell at +13.37 bps against an 18 bps round-trip cost. The strongest signal in the strategy does not cover the cost of trading it. Approximately 300 configurations were tested across six risk:reward ratios, six stop widths, nine take-profit levels, four position sizes, six regime gates, two hard-flat regimes and nine accounting corrections. Win rate stayed between 36% and 42% throughout; random entry times over the same geometry produced 39%. | Chapter 26 successor scope; the new-chapter contract proposed in D-025 must be re-scoped, since box-fade was its named governed candidate. `src/research/strategies/boxFade.js` and its 37 tests were **never committed** — verified 2026-08-22 as absent from `src/research/strategies/` and `tests/` on every branch. Box-fade leaves no code in this repository. If the owner wants the module preserved as reference, it must be committed deliberately as a separate decision. | Out-of-sample split reported for every configuration (PRE 298d / TUNE 123d / POST 128d); pre-registered fragility conditions declared before results and triggered; event study reproducible from `artifacts/research-bars-btcusd/`. | **PROPOSED 2026-08-19 — owner approval required** |

---

## Narrative section to add

### 2026-08-18/19 — Box-fade fails out-of-sample validation and is retired

D-020 made box-fade the project's sole active strategy, explicitly conditioned on out-of-sample validation. This entry records that the validation was performed and the result was negative.

**What was tested.** A ~550-day dukascopy BTCUSD dataset (156,941 five-minute bars, 2025-02-17 to 2026-08-21) was obtained. It contains the original 2025-12-13 to 2026-04-14 research window in its interior, giving roughly 426 days the strategy's parameters were never shaped on. Every configuration was reported across three periods: **PRE** (298 days), **TUNE** (123 days, where all prior results came from), and **POST** (128 days).

**The decisive measurement.** Before any strategy logic, an event study measured raw forward returns after the unsharp box-poke signal, signed in the direction the strategy bets, with no stops, targets or costs applied:

| horizon | SHORT setups (bps) | LONG setups (bps) |
|---|---:|---:|
| 1h | −1.00 | −2.06 |
| 2h | −3.23 | −1.14 |
| 4h | −1.12 | +1.22 |
| 8h | −2.22 | **+13.37** (t = 3.93) |
| 24h | −10.41 | +4.44 |

The short side is anti-predictive at every horizon. The long side has one statistically notable cell at 8 hours, unsupported by its 4h and 24h neighbours, and **+13.37 bps against an 18 bps round-trip cost** — the strongest signal in the strategy does not pay for the trade that captures it.

This is the root cause of every negative result. It is not an exit-rule problem, a stop-placement problem, or a regime-filter problem.

**Configurations tested.** Roughly 300, including: six risk:reward ratios (1:0.5 to 1:5); six stop widths (0.5% to 8%); nine take-profit levels (0.5% to 5.25%); four position sizes ($100–$500); six regime gates (none, absolute 1.5–3.7%, D-019 middle-third, and rolling 40–60 / 35–65 / 30–70 percentile); hard-flat as originally coded, as corrected, and as a selective rule; and nine accounting corrections applied individually and in combination.

**Controls that make the negative credible.**

- **Random-entry control.** The same geometry applied at random times produced a 39% win rate against the strategy's 40–42%. The signal's advantage over arbitrary entry is under two percentage points, far below the ~46% needed to clear costs at 1:1.5.
- **Risk:reward is not an edge.** Across six ratios the realised win rate tracked the theoretical break-even rate almost exactly (1:2 needs 33.3%, delivered 34.8%; 1:3 needs 25.0%, delivered 28.2%), for both the signal and random entries — the expected result for a series without exploitable drift.
- **Selection test.** Choosing the best take-profit on PRE alone and scoring it on POST — the honest version of "use the best parameter" — gave **+5.25R in PRE and −14.67R in POST.** The best performer in the first 298 days was the worst in the last 128.
- **Pre-registered fragility conditions triggered.** The frozen record's F2 condition (>2× spread in average R across neighbouring percentile windows) fired on the regime-gate run. The 35–65 window was net positive at +$180.65; it did not qualify, by a rule written before the result was seen.

**Accounting corrections found along the way.** Nine defects were identified and fixed in the research scripts, measured individually by ablation. All nine had made results *worse* than the strategy actually was; corrected, the reference configuration moved from −93.17R to −33.23R. The largest was a "break-even" exit implemented as a 0.18% take-profit rather than a protective stop, worth 34R. A separate impossible-fill defect — a break-even stop filling at a price the market never offered — briefly produced a fake +$19,533 and a 94.6% win rate before being caught and corrected with an arming check. These are recorded because they are the failure modes most likely to recur.

**Account-limit finding, independent of P&L.** Configurations permitting multiple concurrent positions under a $100,000 notional ceiling reached 15 simultaneous positions and $3,000 of open risk. Tracking realised plus unrealised equity against Tradeify's $1,500 daily limit identified **10–14 account days that would have breached it.** A realised-P&L floor cannot prevent this because it cannot see open drawdown. Any future multi-position design must gate entries on equity including unrealised P&L, not realised alone.

**What is retained.** The *method*, not the code. `boxFade.js` and its 37 tests were written and delivered but never committed, and are absent from every branch (verified 2026-08-22). The event-study method, the PRE/TUNE/POST split protocol, and the random-entry control are adopted as the standard first test for any future strategy candidate — applied *before* any strategy is built around a signal, not after.

**What this does not conclude.** It does not conclude that prior-day levels are meaningless in all markets, timeframes or instruments. It concludes that this specific signal, on BTC at 5-minute granularity, under this cost structure, has no edge large enough to trade. The result is specific to what was tested.
