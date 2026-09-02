# D-060 — Multi-asset grid: five instruments, per-instrument geometry, account-level risk

**Status:** DRAFT — awaiting owner approval.
**Extends:** D-044, D-049, D-054, D-057, D-059.
**Changes strategy behaviour:** yes, materially.

## Decision

Replace the hardcoded SOL grid geometry with one independently configured ring-grid instance per instrument: SOL/USD, DOGE/USD, ZEC/USD, AAVE/USD, and AVAX/USD. The sole configuration surface is `config/instruments.json`; it carries geometry, cap, verified lot step, order-code prefix, enabled state, and account-risk limits.

`baseUsd` is derived rather than configured:

```
unitGross = sum(level = 1..levels) 2 × growth^(level - 1)
baseUsd = capUsd / unitGross
```

The owner has explicitly authorized all five configured instruments as enabled with a verified 0.01-unit minimum lot. This authorization does not enable either execution lock, deploy the branch, run reconciliation, or waive the separate pre-deployment flat-account and canary requirements.

## Geometry

| Instrument | Band | Dead zone | Levels | Cap |
|---|---:|---:|---:|---:|
| SOL/USD | 5.0% | 1 | 10 | $6,300 |
| DOGE/USD | 3.0% | 2 | 12 | $6,300 |
| ZEC/USD | 3.0% | 3 | 8 | $6,300 |
| AAVE/USD | 4.5% | 3 | 12 | $6,300 |
| AVAX/USD | 4.0% | 3 | 12 | $6,300 |

The former SOL compatibility configuration (4.5% / dead-zone 2 / ten levels / $6,600) is intentionally re-sized from its derived $6,600 cap. Its first ring is $29.11848341 rather than the historical hardcoded $28.68. Byte-identical sizing compatibility is therefore explicitly waived by the owner; tags and distances remain deterministic.

## Account-level risk supervisor

The account supervisor evaluates all enabled instances in this order:

1. At combined account-day P&L of −$1,250 or worse, flatten every instrument and hold entries until the 22:00 UTC rollover.
2. At −$1,000 or worse, cut only losing instruments. For each instrument: `fraction = clamp(0.50 × lossShare × enabledInstrumentCount, 0, 1)`.
3. At −$300 or worse, brake entries only for that instrument; exits continue and other instruments may continue.

Winners receive no partial cut. The cut allocation, combined figure, and each instrument fraction are logged for reconstruction.

## Safety invariants

- D-059 remains unchanged in substance: exits and protective reductions are linked `CLOSE` orders by `positionCode`; unread books return `ACCOUNT_DATA_UNAVAILABLE`; full flatten verifies the broker is actually flat.
- One-sided enforcement is per instrument. Long SOL and short AAVE are not cross-instrument hedging.
- State is keyed by `(strategyId, instrument)`. The D-049 SOL row is copied additively into the new table, retaining the original row so rollback remains possible.
- Unknown or malformed configuration fails closed. Enabled instruments require a supported profile, a matching verified lot step, a unique order prefix, and all account-risk fields.

## Deployment constraints

No deployment is authorized by this decision. The SOL book must be flat before a geometry migration. The live partial-close canary and a full owner review remain required before enabling automatic execution or deploying this branch.
