# D-047 Notification Message Examples

These are documentation examples only. Production messages are built from broker-confirmed and durable state fields.

## Confirmed entry

🟢 SOL ENTRY CONFIRMED
Ring: BUY1
Side: BUY
Fill: $93.83
Quantity: 0.06 SOL
Virtual lot: BUY1-V1
Current 200-day MA: $120.00
Confirmed: 2026-08-24 15:00:00Z

## Confirmed tranche exit

💰 SOL TRANCHE EXIT CONFIRMED
Ring: BUY1
Lot: BUY1-V1
Position side: BUY
Tranche: 1/4
Target touched: $100.18
Broker fill: $100.25
Closed: 0.01 SOL
Remaining: 0.05 SOL
Current 200-day MA: $120.00
Confirmed: 2026-08-24 16:00:00Z

## Safety halt

🚨 SOL SAFETY HALT — RECONCILIATION MISMATCH
Virtual net: 0.42 SOL LONG
DXtrade net: 0.38 SOL LONG
State version: 8
New strategy actions are blocked. Owner review is required.
