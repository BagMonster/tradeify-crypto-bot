# Spec: anchor shift ("recenter") after price runs past the outermost ring

**Repo:** `BagMonster/tradeify-crypto-bot`, branch `main` (read at commit `bee8e20`)
**Date:** 2026-10-05
**Status:** owner-approved design. The owner has decided to validate it **live, with no backtest** (2026-10-05). No kill switch (owner decision, 2026-10-05). Needs a decision-log entry (next free D-number).
**Applies to:** all ring-grid instruments (all 16 today), with each coin's geometry unchanged.

---

## 0. Instructions for the implementing agent

1. Before writing code, restate sections 2 and 3 in five bullets or fewer, and list anything in section 4 that doesn't match the code you see. Wait for the owner's "proceed".
2. No backtest and no kill switch (owner decisions, 2026-10-05). Build the change, the monitoring commands in section 8, and the tests in section 9. All tests must pass.
3. Create branch `feature/ring-recenter` from the latest `main`. Commit this spec to it as `docs/spec-ring-recenter-2026-10-05.md`, build everything on that branch, and open **one pull request** to `main` for the owner to merge. Do not merge or deploy it yourself. Don't change ring geometry, sizing, caps, the risk ladder, harvest or flatten logic.

---

## 1. Why

The rings are fixed percentages around the 200-day MA, and every exit targets that MA. When a coin trends hard and runs past the outermost ring, its side of the grid is fully used (the rings are sized to add up to the coin's cap, and the outer rings are the largest). After that the grid just waits for a reversion that may take months. The 200-day MA catches up only slowly.

The owner's rule: remember how far the coin ran beyond its rings. The next time the **whole account** is flat, move that coin's grid so its first outer ring sits at that extreme price. Then keep following the 200-day MA from the new position.

Doing this only while the account is flat means **no open lot is ever moved, closed or re-targeted by a shift**, and the cap is never breached.

## 2. Definitions

For one instrument, using its existing geometry (`band`, `deadZoneBands`, `activeLevelsPerSide` = N, `innerLevels`):

- `MA_t`: the 200-day MA as `maProvider.getCurrent()` returns it today (unchanged).
- `k`: the coin's **anchor multiplier**, persisted. It starts at `1.0`, which is today's behaviour.
- **Effective anchor** `A_t = MA_t × k`. Everything that uses the MA today uses `A_t` instead.
- Ring distance (unchanged, `ringGrid.js:92`): `d(L, side) = ±band × (deadZoneBands + L)`. SELL is +, BUY is −.
- Ring price (unchanged formula, `ringGrid.js:93`): `A_t × (1 + d)`.
- **Outer boundaries:** `upper_t = A_t × (1 + band × (deadZoneBands + N))` and `lower_t = A_t × (1 − band × (deadZoneBands + N))`.
- **First outer ring** ("first ring on the second row"): level `F = innerLevels + 1`, the innermost ring with capacity 2. Its distance is `dF = band × (deadZoneBands + F)`.

## 3. Behaviour

### 3.1 Excursion tracking (every price update, per coin)

- If `price > upper_t`, the coin is in an **upper excursion**. Record `E_high = max(E_high, price)`.
- If `price < lower_t`, the coin is in a **lower excursion**. Record `E_low = min(E_low, price)`.
- Tracking starts on the first cross and **continues until the next account-flat shift**, even if price comes back inside the rings in between.
- Each update is compared against the boundaries at that moment, so the boundaries move as the MA updates daily.
- `E_high`, `E_low` and the time each was first crossed are **persisted**, so a restart doesn't lose them.

### 3.2 Shift trigger: the whole account goes flat

- Trigger on the **transition** from "not flat" to "flat". Flat means DXtrade reports zero open positions (`openPositionsCount === 0` on a healthy account snapshot) **and** every grid's virtual book has no lots.
- Require two consecutive healthy snapshots showing flat, so a single bad read can't trigger it.
- It doesn't matter how the account got flat: harvest, D-060 flatten, manual close in DXtrade, or ordinary exits.
- Don't shift if account data is unhealthy, if any order is in flight, or if a virtual book still shows lots while DXtrade shows none. That last case is a reconciliation mismatch: alert and skip.

### 3.3 Shift calculation (on trigger, per coin with a recorded excursion)

Using the MA at the moment of the shift, `MA_now`:

- Upper excursion: `A' = E_high / (1 + dF)`
- Lower excursion: `A' = E_low / (1 − dF)`
- New multiplier: `k' = A' / MA_now`. Persist it and clear `E_high`/`E_low`.

Coins with no recorded excursion keep their current `k`.

**Stacking (owner-confirmed):** later excursions are measured against the shifted grid, and the next shift is calculated the same way from the new values. Shifts can go up or down any number of times. A shift stays in place until another one is warranted. There is no decay and no automatic return to `k = 1`.

**Worked example (SOL):** band 5%, deadZoneBands 3, N 10, innerLevels 5. So `F = 6` and `dF = 0.45`; the outer boundary is ±65%.
- SOL peaks at 1.80 × MA (+80%), then the account goes flat.
- `A' = 1.80 MA / 1.45 = 1.2414 MA`, so `k' = 1.2414`.
- SELL ring 6 sits at exactly the peak. SELL ring 1 is at `1.2414 × 1.20 = 1.4897 MA`.
- BUY ring 1 is at `1.2414 × 0.80 = 0.9931 MA`, roughly the old MA.
- Exits target `A_t = 1.2414 × MA_t` from then on.

### 3.4 After a shift

- Entries fire only when price **crosses** a ring between the previous and current price (`entryCandidates`, `ringGrid.js:236`). So rings the price is already beyond at shift time **don't fill straight away**; they wait for a real crossing. Reset the instance's `previousPrice` to the current price at the moment of the shift, so the first update after it can't register a false crossing.
- Ring arming and re-arming use the existing rules against `A_t`.
- MA-touch exits (`nextMovingAverageExitAction`) and tranche exits (`nextExitAction`) target `A_t`. That follows automatically from §4.

## 4. Where it goes in the code (verified this session)

- **Live MA entry point:** `src/runtime/ringGridInstance.js:263–264`:
  `const maState = await maProvider.getCurrent(); const ma = positive(..., maState?.ma);`
  That one `ma` feeds `observeRearm` (266), the exit selection (270), and `entryCandidates` (320). Replacing it with `ma × k` moves rings, arming and exits together, with **no change to `ringGrid.js`**.
  - Also check whether `src/runtime/solanaRuntime.js:385` is still on the live path. If it is, apply the same change there.
- The `ma` value is also written into events and intents (`ringGridInstance.js` ~297, ~339). Write **both** the raw `ma` and the `anchor` there so logs stay unambiguous.
- **Excursion tracking:** in the same per-update function, right after the effective anchor is computed. It's cheap and needs no I/O on the hot path. Persist changes to `E_high`/`E_low` without blocking the update, for the same reason as the 2026-10-04 incident: database writes must not hold up trading.
- **Flat-transition detector:** account level, driven by the DXtrade account monitor's snapshots (`index.mjs` `onSnapshot`, or the supervisor). It applies all shifts for all coins in one step, persists them, then notifies.
- **New pure module** (suggested `src/strategies/anchorShift.js`): `trackExcursion(state, {price, anchor, geometry})` and `computeShift(state, {maNow, geometry})`. No I/O, so it can be unit-tested and reused by the backtest.
- **Persistence:** one row per instrument with `k`, `E_high`, `E_low`, the excursion start times, and the last shift time. Also keep an append-only shift history (time, instrument, side, extreme, `MA_now`, `k_old`, `k_new`).

## 5. Owner-facing changes

- **Telegram, on each shift:** `🔁 SOL/USD grid shifted up: peak $X became ring 6. Anchor now 1.2414 × 200d MA ($Y). Previous ×1.0000.`
- **Telegram, when an excursion starts:** `SOL/USD has run past its outermost ring (+65%). Tracking the extreme; the grid will shift at the next flat account.`
- **`/status`, per instrument:** keep the `200-day MA:` line and add:
  - `Anchor: ×1.2414 → $Y (shifted 2026-10-05 17:12Z)`, or `Anchor: ×1.0000 (no shift)`
  - `Excursion: UPPER, extreme $X since <time>`, or `Excursion: none`
- Monitoring commands are specified in section 8.

## 6. Out of scope / unchanged

Ring geometry, ring sizes, caps, the exposure pool, the risk ladder, harvest, D-060 flatten, tranche-exit fractions, and how the MA itself is computed.

## 7. Decisions (item 1 owner-decided; items 2–3 are defaults the owner can override)

1. **Price source, decided (owner, 2026-10-05):** the extreme is the literal furthest Binance trade price, **with no filtering** for jumps between trades and no candle smoothing. Every trade on the coin's stream counts.
2. **Excursions on both sides before the account goes flat** (a whipsaw). *Default:* use the side whose extreme is furthest beyond its own boundary in % terms, and discard the other.
3. **Literal price versus ratio.** The spec uses the literal extreme price at shift time, as the owner described: ring F lands exactly on the extreme. If the MA moved a lot during a long excursion, the resulting `k` reflects that. No change proposed.

## 8. Live rollout and monitoring commands (no backtest, no kill switch; owner decisions)

The live account is the test. If something misbehaves, it gets fixed in code. So the owner needs to **see** what the logic is doing and **measure** its results from Telegram. Add these read-only commands, list them in `/help` and the Telegram menu (`src/telegramMenu.js`), and add no other controls.

**`/anchors`**: one line per coin.
`SOL/USD  ×1.2414  anchor $106.55 (MA $85.84)  excursion: none  shifts: 1 (last 2026-10-05 17:12Z)`
For a coin in an excursion, show the side, the extreme and how far past the boundary it is: `excursion: UPPER since 2026-10-06 03:10Z, extreme $160.20 (+8.4% past outer ring)`.

**`/anchor <COIN>`**: detail for one coin.
- Raw 200d MA, `k`, effective anchor, and the prices of the outer boundaries and the first outer ring (ring F).
- Excursion state: side, extreme, when it started, current price as % of the boundary.
- **Projected shift if the account went flat now:** the new `k` and anchor, and where ring F and BUY/SELL ring 1 would land. This lets the owner check the maths before a shift happens.

**`/anchorhistory [COIN]`**: the last 10 shifts (all coins, or one): time, coin, side, extreme, MA at shift, `k` old → new.

**`/anchorstats [COIN]`**: results since each coin's last shift, from the existing event/fill records (no new bookkeeping for trades):
- entries and exits since the shift, realised P&L since the shift, open lots and their unrealised P&L now, time since the shift, and the highest and lowest price since the shift relative to the new rings.
- For coins never shifted, show the same figures since the feature was deployed, as the comparison group.

**Notifications** (already in section 5): excursion started, and each shift with old and new `k`.

**First deploy:** every coin starts at `k = 1`. Behaviour is identical to today until a coin crosses its outer ring and the account then goes flat. The existing account risk ladder (brake, cuts, flatten, daily limit) is unchanged.

## 9. Tests

1. `computeShift` for upper and lower excursions reproduces the SOL worked example (`k' = 1.80 / 1.45` within 1e-9), and mirrors it for BUY.
2. Tracking: the extreme survives price returning inside the rings; no excursion means no shift.
3. Stacking: a second excursion against a shifted grid produces `k'' = E / (1 ± dF) / MA_now`, both upward and downward.
4. Trigger: a shift happens only on a not-flat → flat transition confirmed by two healthy snapshots. No shift on unhealthy data, while an order is in flight, or when virtual lots exist with no broker positions.
5. After a shift, a ring the price is already beyond does **not** fill on the next update; it fills only on a fresh crossing.
6. Persistence: `k`, the extremes and history survive a restart.
7. With `k = 1` and no excursions, every existing grid test passes unchanged, so the default reproduces today's behaviour exactly.
8. Commands: `/anchors`, `/anchor <COIN>`, `/anchorhistory` and `/anchorstats` render from fixture state without errors. The projected shift in `/anchor` equals what `computeShift` produces when the flat trigger then fires. An unknown coin returns a clear message.
