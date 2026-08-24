# D-042 — Owner-approved SOL live lifecycle canary

**Status:** APPROVED by owner on 2026-08-23.

## Approval

The owner explicitly approved proceeding with the real SOL live-touch execution checkpoint and instructed the project to stop asking for repeated approval and get the bot started.

This approval authorizes the one controlled real DXtrade lifecycle canary required by D-038 for the SOL production path.

## Canary scope

The authorized canary is exactly:

1. Start only while the production grid remains locked with Railway `AUTO_EXECUTE=false` and `config/strategy.json` → `execution.autoExecute=false`.
2. Require the Tradeify/DXtrade account to be flat and free of an operator pause or safety halt.
3. Submit one `0.01 SOL` market BUY on DXtrade `SOL/USD` using a durable, idempotent canary order identity.
4. Advance only after DXtrade reports a confirmed broker fill.
5. Hold at least the project minimum of 25 seconds from the confirmed open fill.
6. Read the exact broker `SOL/USD` position and submit a position-effect close for the exact confirmed quantity using the broker position code.
7. Advance only after the close fill is confirmed.
8. Verify the broker account is flat after the close.
9. Persist the canary open and close independently from all SOL ring, lot, tranche, MA, and re-arm state.
10. If any broker outcome is partial, rejected, ambiguous, mismatched, or otherwise uncertain, stop rather than guessing or sending a replacement order.

The owner-only Telegram command `/solcanary` is the explicit execution trigger for this checkpoint. It is deliberately not exposed as an inline button.

## What D-042 does not authorize

D-042 does not by itself enable automatic production-grid trading. Both automatic-execution settings remain false during the canary.

After a clean canary, production automatic execution may be activated only at the separately governed final activation step. The owner has made clear that repeated requests for the same canary approval are not required; this document is the durable record of that approval.
