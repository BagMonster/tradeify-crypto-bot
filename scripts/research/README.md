# Research scripts — grid strategy

Standalone backtesters. **Research code only.**

- Never imported by `index.mjs`.
- No broker client, no credentials, no network calls, no order-placement path. Only `node:fs` and `node:path`.
- Both execution locks (`AUTO_EXECUTE`, `execution.autoExecute`) are untouched by anything here.

## Files

| File | Purpose |
|---|---|
| `grid-btc.mjs` | Reference backtester. Produces the figures quoted in `docs/proposals/grid-golive-policy-change-2026-08-22.md` D-031. |
| `grid-v4.mjs` | Same engine plus: 6% end-of-trade trailing max-loss floor, an alternative day-baseline model, a position-state census (long/short/flat/both), and peak-to-trough equity-drawdown tracking. Produces the figures in D-032 and D-035. |

## Running them

Run from the **repository root**, not from this folder — both resolve their data path relative to the working directory.

```
node scripts/research/grid-btc.mjs
node scripts/research/grid-btc.mjs --trades        # print every trade
node scripts/research/grid-btc.mjs --csv           # write the trade log to CSV
node scripts/research/grid-btc.mjs --sweep-only    # skip the detailed run
node scripts/research/grid-btc.mjs --scale 1.2     # multiply the whole ladder
node scripts/research/grid-btc.mjs --financing 0   # turn off overnight financing
```

Results are written to `artifacts/grid-results/`.

## ⚠ Required dataset — not in this repository

Both scripts read:

```
artifacts/research-bars-btcusd/5m.json
```

That file is **dukascopy BTCUSD, 156,941 five-minute bars, 2025-02-17 to 2026-08-21, ~36 MB**. It is deliberately **not committed** — `artifacts/` is gitignored, and a 36 MB file in git history is permanent and painful to remove.

**Cloning this branch will not give you the data.** It must be transferred separately. Without it the scripts exit on a missing-file error; they will not silently produce different numbers.

## Configuration

Both files have a clearly marked tweak zone near the top holding the frozen ladder, cost assumptions, and account rules. **Do not change the ladder** — it is frozen by `docs/proposals/grid-strategy-spec-2026-08-19.md` §2 and adopted by draft D-031. Variants that were tested and rejected are listed in spec §3 and in D-031; re-proposing them without new evidence wastes time.

## Known caveat carried from the spec

`overnightPct: 0.00033` (0.033%/night) is an **unverified assumption** originating in D-010/D-015. It is worth roughly one third of total modelled profit. Confirm the real Tradeify swap rate before drawing any conclusion from these numbers. See spec §7.2 and draft D-030.
