#!/usr/bin/env node
/**
 * scripts/run-zone-engines.mjs
 *
 * Strategy A: near-edge zone fades only.
 * Research backtest with account-style risk/costs.
 * No RSI/VWAP/bias/regime filters.
 *
 * Usage:
 *   node scripts/run-zone-engines.mjs
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BARS_DIR = path.resolve("artifacts", "research-bars-btcusd");
const OUT_DIR = path.resolve("artifacts", "boxfade-results");

const RISK_CAP = 100;
const COMMISSION_PCT = 0.0004;
const SLIPPAGE_PCT = 0.0005;
const TIME_STOP_BARS = 48; // 4h
const HARD_FLAT_MIN = 21 * 60 + 45;
const ATR_PERIOD = 14;

const ENGINES = [
  { side: "LONG", name: "efficiency", zoneFrac: 0.05, stopAtr: 0.5, tpFrac: 0.50 },
  { side: "LONG", name: "middle", zoneFrac: 0.075, stopAtr: 0.75, tpFrac: 0.50 },
  { side: "LONG", name: "totalEdge", zoneFrac: 0.10, stopAtr: 1.0, tpFrac: 0.50 },
  { side: "SHORT", name: "efficiency", zoneFrac: 0.05, stopAtr: 1.5, tpFrac: 0.35 },
  { side: "SHORT", name: "middle", zoneFrac: 0.075, stopAtr: 1.5, tpFrac: 0.30 },
  { side: "SHORT", name: "totalEdge", zoneFrac: 0.10, stopAtr: 1.5, tpFrac: 0.25 }
];

function utcDayKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function minutesUtc(ms) {
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function trueRange(bar, prevClose) {
  return Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
}
function atrSeries(bars, period) {
  const out = new Array(bars.length).fill(null);
  if (bars.length < period + 1) return out;
  let atr = 0;
  for (let i = 1; i <= period; i += 1) atr += trueRange(bars[i], bars[i - 1].close);
  atr /= period;
  out[period] = atr;
  for (let i = period + 1; i < bars.length; i += 1) {
    atr = ((atr * (period - 1)) + trueRange(bars[i], bars[i - 1].close)) / period;
    out[i] = atr;
  }
  return out;
}
function buildBoxes(dailyBars) {
  const byDay = new Map();
  for (const b of dailyBars) {
    byDay.set(utcDayKey(Date.parse(b.openTime)), { high: b.high, low: b.low });
  }
  const days = [...byDay.keys()].sort();
  const boxByDay = new Map();
  for (let i = 1; i < days.length; i += 1) {
    const prev = byDay.get(days[i - 1]);
    const range = prev.high - prev.low;
    if (!(range > 0)) continue;
    boxByDay.set(days[i], { boxHigh: prev.high, boxLow: prev.low, range });
  }
  return boxByDay;
}
function applySlip(price, side, isEntry) {
  if (side === "LONG") return price * (isEntry ? 1 + SLIPPAGE_PCT : 1 - SLIPPAGE_PCT);
  return price * (isEntry ? 1 - SLIPPAGE_PCT : 1 + SLIPPAGE_PCT);
}
function commission(notional) {
  return Math.abs(notional) * COMMISSION_PCT;
}

function runEngine(engine, bars5m, boxByDay, atr5) {
  const trades = [];
  let open = null;
  let currentDay = null;
  let usedToday = false;

  for (let i = ATR_PERIOD + 2; i < bars5m.length; i += 1) {
    const bar = bars5m[i];
    const day = utcDayKey(Date.parse(bar.openTime));
    const t = Date.parse(bar.closeTime);

    if (day !== currentDay) {
      currentDay = day;
      usedToday = false;
    }

    // manage open trade
    if (open) {
      const stopHit = open.side === "LONG" ? bar.low <= open.stop : bar.high >= open.stop;
      const tpHit = open.side === "LONG" ? bar.high >= open.tp : bar.low <= open.tp;
      const timeHit = i - open.entryIndex >= TIME_STOP_BARS;
      const flatHit = minutesUtc(t) >= HARD_FLAT_MIN;

      let reason = null;
      let exitPx = null;
      if (stopHit && tpHit) { reason = "stop"; exitPx = open.stop; }
      else if (stopHit) { reason = "stop"; exitPx = open.stop; }
      else if (tpHit) { reason = "tp"; exitPx = open.tp; }
      else if (timeHit) { reason = "time"; exitPx = bar.close; }
      else if (flatHit) { reason = "hard-flat"; exitPx = bar.close; }

      if (reason) {
        const fill = applySlip(exitPx, open.side, false);
        const gross = open.side === "LONG"
          ? (fill - open.entryFill) * open.qty
          : (open.entryFill - fill) * open.qty;
        const costs = commission(open.entryFill * open.qty) + commission(fill * open.qty);
        const net = gross - costs;
        trades.push({
          side: open.side,
          entryTime: open.entryTime,
          exitTime: bar.closeTime,
          net,
          rMultiple: net / open.riskDollars,
          reason
        });
        open = null;
      }
      continue;
    }

    if (usedToday) continue;
    if (minutesUtc(t) >= HARD_FLAT_MIN) continue;

    const box = boxByDay.get(day);
    if (!box || atr5[i] == null || !(atr5[i] > 0)) continue;

    const nearLow = box.boxLow + box.range * engine.zoneFrac;
    const nearHigh = box.boxHigh - box.range * engine.zoneFrac;

    let signal = false;
    if (engine.side === "LONG" && bar.low <= nearLow) signal = true;
    if (engine.side === "SHORT" && bar.high >= nearHigh) signal = true;
    if (!signal) continue;

    const stop = engine.side === "LONG"
      ? box.boxLow - engine.stopAtr * atr5[i]
      : box.boxHigh + engine.stopAtr * atr5[i];
    const tp = engine.side === "LONG"
      ? Math.min(box.boxHigh, bar.close + engine.tpFrac * box.range)
      : Math.max(box.boxLow, bar.close - engine.tpFrac * box.range);

    const entryFill = applySlip(bar.close, engine.side, true);
    const risk = Math.abs(entryFill - stop);
    if (!(risk > 0)) continue;
    const qty = RISK_CAP / risk;
    if (!(qty > 0)) continue;

    usedToday = true;
    open = {
      side: engine.side,
      entryIndex: i,
      entryTime: bar.closeTime,
      entryFill,
      stop,
      tp,
      qty,
      riskDollars: RISK_CAP
    };
  }

  if (open) {
    const last = bars5m[bars5m.length - 1];
    const fill = applySlip(last.close, open.side, false);
    const gross = open.side === "LONG"
      ? (fill - open.entryFill) * open.qty
      : (open.entryFill - fill) * open.qty;
    const costs = commission(open.entryFill * open.qty) + commission(fill * open.qty);
    const net = gross - costs;
    trades.push({
      side: open.side,
      entryTime: open.entryTime,
      exitTime: last.closeTime,
      net,
      rMultiple: net / open.riskDollars,
      reason: "end-of-data"
    });
  }

  const wins = trades.filter((t) => t.net > 0);
  const netPnl = trades.reduce((s, t) => s + t.net, 0);
  const avgR = trades.length ? trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length : 0;
  const totalR = trades.reduce((s, t) => s + t.rMultiple, 0);
  const stopRate = trades.length ? trades.filter((t) => t.reason === "stop").length / trades.length : 0;
  const tpRate = trades.length ? trades.filter((t) => t.reason === "tp").length / trades.length : 0;

  return {
    side: engine.side,
    name: engine.name,
    zonePct: Math.round(engine.zoneFrac * 1000) / 10,
    stopAtr: engine.stopAtr,
    tpPct: Math.round(engine.tpFrac * 100),
    trades: trades.length,
    netPnl,
    winRate: trades.length ? wins.length / trades.length : 0,
    avgR,
    totalR,
    stopRate,
    tpRate
  };
}

async function main() {
  console.log("Loading BTCUSD bars...");
  const bars5m = JSON.parse(await readFile(path.join(BARS_DIR, "5m.json"), "utf8"));
  const bars1d = JSON.parse(await readFile(path.join(BARS_DIR, "1d.json"), "utf8"));
  console.log(`5m=${bars5m.length} daily=${bars1d.length}`);

  const boxByDay = buildBoxes(bars1d);
  const atr5 = atrSeries(bars5m, ATR_PERIOD);

  const results = [];
  for (const engine of ENGINES) {
    const r = runEngine(engine, bars5m, boxByDay, atr5);
    results.push(r);
    console.log(
      `${r.side}/${r.name}: n=${r.trades} net=$${r.netPnl.toFixed(2)} ` +
      `win=${(r.winRate * 100).toFixed(1)}% avgR=${r.avgR.toFixed(2)} totalR=${r.totalR.toFixed(2)} ` +
      `stopRate=${(r.stopRate * 100).toFixed(1)}% tpRate=${(r.tpRate * 100).toFixed(1)}%`
    );
  }

  console.log("\n=== Ranked by totalR ===");
  for (const r of [...results].sort((a, b) => b.totalR - a.totalR)) {
    console.log(
      `${r.side}/${r.name}: totalR=${r.totalR.toFixed(2)} net=$${r.netPnl.toFixed(2)} ` +
      `n=${r.trades} avgR=${r.avgR.toFixed(2)} win=${(r.winRate * 100).toFixed(1)}%`
    );
  }

  console.log("\n=== Ranked by avgR ===");
  for (const r of [...results].sort((a, b) => b.avgR - a.avgR)) {
    console.log(
      `${r.side}/${r.name}: avgR=${r.avgR.toFixed(2)} totalR=${r.totalR.toFixed(2)} ` +
      `net=$${r.netPnl.toFixed(2)} n=${r.trades} win=${(r.winRate * 100).toFixed(1)}%`
    );
  }

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, "zone-engines-summary.json");
  await writeFile(outPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${outPath}`);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

