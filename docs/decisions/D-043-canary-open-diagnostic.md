# D-043 — SOL canary open diagnostic follow-up

**Status:** owner-directed operational follow-up on 2026-08-23.

The first owner-triggered `/solcanary` attempt returned that the opening order was not confirmed and correctly sent no second order.

The canary response must now distinguish broker state without submitting another order:

- preserve the existing idempotent canary order code;
- do not place a replacement order while the first open outcome is uncertain;
- after an unconfirmed open, read DXtrade positions and report whether the broker is flat or reports a `SOL/USD` position;
- include the persisted/reconciled open status in the owner-visible response;
- if a `SOL/USD` position exists, require exact-position review/close handling rather than guessing another entry;
- if the account is flat, keep the failed/pending canary state visible so the execution-path cause can be corrected before any newly versioned canary attempt.

This diagnostic change does not enable automatic grid execution and does not alter ring state, strategy parameters, or account risk limits.