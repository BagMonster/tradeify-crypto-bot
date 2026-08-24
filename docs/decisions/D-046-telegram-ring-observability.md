# D-046 — Telegram SOL ring observability

**Status:** APPROVED by owner on 2026-08-23.

Add two owner-only, read-only Telegram utilities for the frozen `sol-outer-heavy-v1` production strategy.

## `/rings`

Shows where the current Binance `SOLUSDT` live price sits relative to the current completed-day 200-day SOL moving average and the frozen 8 BUY / 8 SHORT ring geometry. It reports dead-zone versus ring-zone status, any currently crossed/touched ring, the next BUY level below price, the next SHORT level above price, dollar/percentage distance, the closer side, and the frozen USD size for a crossed ring.

The command must derive geometry from the same frozen production strategy definition: 4.5% bands, four skipped bands, active distances ±22.5% through ±54.0%, and `$6 × 1.8^(level-1)` sizing. It must use the same MA provider and the same live Binance feed used by the strategy runtime. If either input is unavailable or stale, it must report an error rather than guess.

`/rings` never reads or changes armed/occupied ring state and never submits an order.

## `/levels`

Shows all 8 BUY and all 8 SHORT trigger prices from the current MA, frozen USD size, estimated SOL quantity at the trigger price rounded down to the 0.01 SOL increment, and current persistent ring state (`ARMED`, `DISARMED`, or `FULL`, including open-lot count when applicable).

This is also read-only. Trigger prices are Binance `SOLUSDT` strategy levels; actual DXtrade `SOL/USD` fill prices can differ slightly.

## Telegram UI

Add both commands to `/help` and Telegram's registered command menu. Add `Grid Levels` and `Ring Position` inline buttons that call the same read-only service functions as `/levels` and `/rings`.

These utilities do not alter strategy parameters, risk gates, execution controls, persistent ring state, broker state, or automatic trading behavior.
