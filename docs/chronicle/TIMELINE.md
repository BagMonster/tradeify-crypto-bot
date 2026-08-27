# Timeline

Evidence-backed milestones only. Narrative lives in [`entries/`](entries/). If a date is missing from a source, it is not invented here. Times are UTC.

| When | What | Kind | Source |
|---|---|---|---|
| 2026-08-23 | V2 lifecycle canary: 0.01 SOL BUY @ $93.83, close @ $93.88, account flat afterward. | Fact | Root `README.md` canary receipts; D-045 |
| 2026-08-23 | Final SOL live activation approved. Production strategy `sol-outer-heavy-v1`. | Fact | `docs/decisions/D-045-final-sol-live-activation.md` |
| 2026-08-25 | D-049 merged via PR #37 (squash `9372332`): 10×10 rings, base $28.68 × 1.5, ceiling $6600, daily ladder −$300 / −$1000 / −$1250. | Fact | `docs/decisions/D-049-sol-risk-ladder-and-resize.md`; PR #37 |
| 2026-08-26 | Virtual book showed a 0.06 SOL short while DXtrade showed no open SOL position. Reconciliation safety halt blocked grid actions. Worker, Postgres, Binance feed, and MA provider remained healthy. Root cause was **not** proven from Telegram telemetry alone. | Fact + uncertainty | Founding note; owner/Telegram `/status` of that incident |
| 2026-08-26 | After reconcile: broker SOL flat, virtual net zero, open lots zero, rings 20/20 armed, state version 2, ladder ready, bot running. | Fact | Founding note; D-050 path |
| 2026-08-26 | D-050 `/reconcile` + `/confirmreconcile` merged via PR #46. | Fact | `docs/decisions/D-050-audited-virtual-reconcile.md`; PR #46 |
| 2026-08-26 | D-052 read-only GitHub tools merged via PR #48 (`40ffcb45`). Companion-only. | Fact | `docs/decisions/D-052-repo-inspection-tools.md`; PR #48 |
| 2026-08-26T15:59:10.937Z | SHORT2 filled: 0.44 SOL SELL @ $95.91. Virtual net −0.44. | Fact | `/status` last fill; `docs/decisions/D-053-matched-book-rematch.md` |
| 2026-08-26 | D-053 rematch + signed SELL/SHORT net merged via PR #49 (`af455f6`). | Fact | `docs/decisions/D-053-matched-book-rematch.md`; PR #49 |
| 2026-08-26 | D-054 unread broker net is not a flat book, merged via PR #50 (`9438cf73`). | Fact | `docs/decisions/D-054-unread-broker-fail-closed.md`; `main` tip |
| 2026-08-27T02:00Z approx | After D-054 trading-worker deploy, `/status` showed virtual −0.44 = broker −0.44, fresh 35ms, halt off, bot running, SHORT2 still open. | Fact | Owner `/status` paste recorded in the 2026-08-26 BMTB1 handoff (written ~19:00 PDT / 02:00 UTC) |
| 2026-08-27T03:02Z | Chronicle shelf created on branch `docs/bmtb1-chronicle`. | Fact | This directory; commit `829fe417` |

D-051 (live body snapshot) is approved and **not** on `main` as of `9438cf73`. It is not listed as shipped.
