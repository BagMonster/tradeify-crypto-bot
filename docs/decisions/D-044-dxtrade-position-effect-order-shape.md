# D-044 — DXtrade SOL position-effect order-shape correction

**Status:** IMPLEMENTED operational correction on 2026-08-23 under the owner's standing approval to complete the SOL live lifecycle canary and start the bot.

The first SOL canary V1 attempt remained unconfirmed while repeated DXtrade position reads showed the broker account flat. `/dxpreflight` then confirmed `SOL/USD` minimum order size `0.01` and increment `0.01`, so minimum size was not the blocker.

Review of the DXtrade/SCA single-order schema showed that `positionEffect` is required for position-based trading. Opening quantity orders therefore require `positionEffect: "OPEN"`. Exact linked-position closes use `positionEffect: "CLOSE"` plus `positionCode`; the close request omits explicit quantity from the broker JSON body while the bot still retains the expected quantity internally for reconciliation.

The original V1 canary order identifiers remain abandoned as historical PENDING evidence and are never resubmitted. The corrected lifecycle uses unique V2 canary identifiers after verifying the broker account is flat.

This correction does not change the SOL strategy, ring geometry, risk limits, execution locks, or live-touch semantics. Automatic production-grid execution remains OFF during the canary.