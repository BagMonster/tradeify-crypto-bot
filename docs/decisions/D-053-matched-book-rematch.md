# D-053 — Matched book rematch

**Status:** APPROVED by the owner 2026-08-26.
**Does not change:** D-049 geometry, risk ladder, live-touch semantics, or D-050 flat-broker `/reconcile`.

## Why

On 2026-08-26 the grid confirmed SHORT2: **0.44 SOL SELL @ $95.91**. DXtrade showed `Sell 0.44`. The virtual book stored net **−0.44**. The account monitor then reported the broker **flat** because it trusted metrics `include-positions` only. Runtime compared −0.44 vs 0.00 and raised the reconciliation halt.

`/reconcile` is the wrong repair: it empties virtual lots and is legal only when DXtrade is actually flat.

## What this adds

1. Account monitor also reads `/positions`. If metrics claim flat (or disagree) and the positions endpoint shows the SOL net, the snapshot uses the signed positions net.
2. Signed quantity: `side=SELL|SHORT` is negative even when the API returns `+0.44`.
3. Owner commands `/rematch` + `/confirmrematch CODE`:
   - fresh DXtrade positions read;
   - require virtual net and broker net to agree within 0.005 SOL;
   - keep every virtual lot;
   - clear only the reconciliation safety halt;
   - lift the operator pause;
   - place no order and flatten nothing.

## Operator path for this incident

```text
/rematch
/confirmrematch CODE
/status
```

`/status` should then show broker position open YES, virtual net −0.44, halt off, bot running. The grid keeps managing SHORT2.

## Do not use

- `/reconcile` while DXtrade still holds the 0.44 short
- a command that invents a virtual lot from an unexplained broker position

## Related code

- `src/execution/dxtradeExecutionClient.js` — `getOpenPositions()` `GET /accounts/{code}/positions`
- `src/account/dxtradeSignedNet.js` — signed SELL/SHORT quantity and positions overlay
- `src/account/dxtradeAccountMonitor.js` — required overlay; `positionsReadFailed` is unhealthy
- `src/state/solanaRematch.js` — `/rematch` + `/confirmrematch` handlers
- `src/solanaTradeifyService.js` — exposes `requestRematch` / `confirmRematch` and `/status` broker snapshot lines
- `src/solanaOwnerService.js` — production wrapper used by `index.mjs`
- `src/telegramBot.js` — slash handlers and command menu
- `index.mjs` — `onBooksRematched` clears the in-process reconciliation latch
- `tests/dxtradeSignedNet.test.mjs`
- `tests/dxtradeAccountMonitor.test.mjs`
- `tests/solanaRematchCommand.test.mjs`
- `tests/devCompanionTelegram.test.mjs`
