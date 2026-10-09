# $100K proportional configuration

The $10K profile remains the baseline. The $100K profile remains an unconfirmed
activation draft. This change authorizes neither activation nor a deployment,
account switch, database reset, order or Railway variable change.

| Setting | $10K | $100K |
| --- | ---: | ---: |
| Account size | $10,000 | $100,000 |
| Daily loss limit | $300 | $3,000 |
| Max loss | $600 | $6,000 |
| Broker notional cap | $20,000 | $200,000 |
| Per-book entry brake | $33 | $330 |
| 10% protective cut | $100 | $1,000 |
| 20% protective cut | $150 | $1,500 |
| 50% protective cut | $200 | $2,000 |
| Full protective flatten | $250 | $2,500 |
| Standard account harvest | $33 | $330 |
| Exposure pool soft / hard | $3,000 / $3,500 | $30,000 / $35,000 |
| Per-coin sizing cap | $5,000 | $50,000 |
| Full-pool harvest target after 24h | $16.50 | $165 |
| Full-pool harvest floor after 36h | $8.25 | $82.50 |

Times and fractions are identical: 24/36 hours, 50%/25% pool-harvest targets,
5-minute rollover delay, 3-minute initiation window, 15-minute protective cut
cooldown, 22:00 UTC account reset, geometry, tranche weights, mark freshness and
anchor confirmation rules. Broker lot steps remain unchanged; rounded order
quantities and realized profit need not be exactly tenfold.

## Confirmed runtime path and timing defect

`loadConfiguration` in `src/config.js` loads and applies the selected profile.
`index.mjs` uses `configuration.instrumentsRaw.accountRisk` for the risk
supervisor and exposure gate, and the profiled per-book caps for grid sizing.
`getExposurePoolSnapshot` supplies the actual pool closure age to the supervisor.
The 24/36-hour policy already exists in `src/risk/riskSupervisor.js`; the $100K
profile previously omitted it and used a non-proportional $22,000/$22,500 pool.

`rolloverHarvestWindowMinutes` existed in all three profile JSON files but was
not validated, retained or applied by `src/config/accountProfile.js`. No live
supervisor cutoff existed. This repair wires it through profile validation,
application, instrument parsing and the real risk supervisor. The configured
profiles now enforce eligibility at 22:05:00 UTC inclusive through 22:08:00 UTC
exclusive. The deadline is anchored to the account day, not deployment time.
Candidate reads are checked again after awaiting them so late readiness cannot
start a new plan. Full-pool reduced targets use the same initiation window.

A durable PENDING proportional plan may finish outside the initiation window;
expiry must not abandon work whose closes may already have been confirmed.
CONFIRMED and HALTED harvest state handling is unchanged. The standard daily
full harvest remains available after the window. Protective cuts and flattening
run before rollover eligibility and remain independent of it. No existing
harvest rows or plans are rewritten by this patch.

Maintenance/test callers omitting the optional window keep their previous
unbounded behavior; all committed account profiles explicitly specify 3 minutes.
The historical 50K profile also has that value wired, but is not selected or
activated by this change. The $10K JSON is unchanged: deploying the patch restores
its configured cutoff, rather than altering its requested timing.

Tests compare every profile key and the complete applied configs, ensure timing,
fractions and geometry remain equal, verify all 17 grids' sizing caps/base values,
and exercise the live raw-profile risk path for both full-pool target phases.
Boundary, delayed-read, startup-expiry, pending-plan completion, ordinary full
harvest and protective-flatten checks cover the window repair. The $100K draft
must still refuse startup until separately reviewed and confirmed.
