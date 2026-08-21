#!/usr/bin/env node
/**
 * scripts/run-boxfade-engines-x9.mjs
 *
 * Research only. No orders.
 *
 * Tests 2 engines per side × 9 filter variants on BTCUSD.
 *
 * Usage:
 *   node scripts/run-boxfade-engines-x9.mjs
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BARS_DIR = path.resolve("artifacts", "research-bars-btcusd");
const OUT_DIR = path.resolve("artifacts", "boxfade-results");

const RESEARCH_RISK_CAP = 100;
const COMMISSION_PCT = 0.0004;
const SLIPPAGE_PCT = 0.0005;
const TIME_STOP_BARS = 48;
const HARD_FLAT_MIN = 21 * 60 + 45;
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;
const ADX_PERIOD = 14;
const REGIME_LOOKBACK = 120;

const ENGINES = {
  LONG: {
    efficiency: { zoneFrac: 0.05, stopAtr: 0.5, tpFrac: 0.50 },
    totalEdge: { zoneFrac: 0.10, stopAtr: 1.0, tpFrac: 0.50 }
  },
  SHORT: {
    efficiency: { zoneFrac: 0.05, stopAtr: 1.5, tpFrac: 0.35 },
    totalEdge: { zoneFrac: 0.10, stopAtr: 1.5, tpFrac: 0.25 }
  }
};

const VARIANTS = [
  { id: 1, name: "confirm+VWAP", entry: "confirm", vwap: true, bias: false, expandRegime: false },
  { id: 2, name: "unsharp", entry: "unsharp", vwap: false, bias: false, expandRegime: false },
  { id: 3, name: "confirm", entry: "confirm", vwap: false, bias: false, expandRegime: false },
  { id: 4, name: "confirm+bias+VWAP", entry: "confirm", vwap: true, bias: true, expandRegime: false },
  { id: 5, name: "confirm+bias", entry: "confirm", vwap: false, bias: true, expandRegime: false },
  { id: 6, name: "confirm+expandedRegime", entry: "confirm", vwap: false, bias: false, expandRegime: true },
  { id: 7, name: "unsharp+VWAP", entry: "unsharp", vwap: true, bias: false, expandRegime: false },
  { id: 8, name: "unsharp+bias+VWAP", entry: "unsharp", vwap: true, bias: true, expandRegime: false },
  { id: 9, name: "unsharp+bias", entry: "unsharp", vwap: false, bias: true, expandRegime: false }
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
function rsiSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    const ch = closes[i] - closes[i - 1];
    avgGain += Math.max(ch, 0);
    avgLoss += Math.max(-ch, 0);
  }
  avgGain /= period; avgLoss /= period;
  out[period] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i += 1) {
    const ch = closes[i] - closes[i - 1];
    avgGain = ((avgGain * (period - 1)) + Math.max(ch, 0)) / period;
    avgLoss = ((avgLoss * (period - 1)) + Math.max(-ch, 0)) / period;
    out[i] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}
function adxAtEnd(dailyBars, endIndex, period) {
  if (endIndex + 1 < period * 2) return null;
  const bars = dailyBars.slice(0, endIndex + 1);
  const vals = [];
  for (let i = 1; i < bars.length; i += 1) {
    const up = bars[i].high - bars[i - 1].high;
    const down = bars[i - 1].low - bars[i].low;
    vals.push({
      tr: trueRange(bars[i], bars[i - 1].close),
      plusDm: up > down && up > 0 ? up : 0,
      minusDm: down > up && down > 0 ? down : 0
    });
  }
  let str = 0, sPlus = 0, sMinus = 0;
  for (let i = 0; i < period; i += 1) {
    str += vals[i].tr; sPlus += vals[i].plusDm; sMinus += vals[i].minusDm;
  }
  const dxs = [];
  const pushDx = () => {
    const pDi = str === 0 ? 0 : 100 * (sPlus / str);
    const mDi = str === 0 ? 0 : 100 * (sMinus / str);
    const tot = pDi + mDi;
    dxs.push(tot === 0 ? 0 : 100 * Math.abs(pDi - mDi) / tot);
  };
  pushDx();
  for (let i = period; i < vals.length; i += 1) {
    str = str - str / period + vals[i].tr;
    sPlus = sPlus - sPlus / period + vals[i].plusDm;
    sMinus = sMinus - sMinus / period + vals[i].minusDm;
    pushDx();
  }
  if (dxs.length < period) return null;
  let adx = dxs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxs.length; i += 1) adx = ((adx * (period - 1)) + dxs[i]) / period;
  return adx;
}
function percentileRank(sortedAsc, value) {
  if (!sortedAsc.length) return null;
  let below = 0;
  for (const v of sortedAsc) if (v < value) below += 1;
  return (below / sortedAsc.length) * 100;
}
function buildDailyMeta(dailyBars) {
  const atr = atrSeries(dailyBars, ATR_PERIOD);
  const metaByDay = new Map();
  for (let i = 0; i < dailyBars.length; i += 1) {
    const bar = dailyBars[i];
    const day = utcDayKey(Date.parse(bar.openTime));
    const atrPct = atr[i] == null ? null : atr[i] / bar.close;
    const adx = adxAtEnd(dailyBars, i, ADX_PERIOD);
    let percentile = null;
    if (atrPct != null && i >= 1) {
      const start = Math.max(0, i - REGIME_LOOKBACK);
      const prior = [];
      for (let j = start; j < i; j += 1) if (atr[j] != null) prior.push(atr[j] / dailyBars[j].close);
      if (prior.length >= 30) {
        prior.sort((a, b) => a - b);
        percentile = percentileRank(prior, atrPct);
      }
    }
    metaByDay.set(day, {
      high: bar.high, low: bar.low, close: bar.close,
      atrPct, adx, percentile, atrAbs: atr[i]
    });
  }
  const days = [...metaByDay.keys()].sort();
  for (let i = 1; i < days.length; i += 1) {
    const prev = metaByDay.get(days[i - 1]);
    const cur = metaByDay.get(days[i]);
    cur.boxHigh = prev.high;
    cur.boxLow = prev.low;
    cur.range = prev.high - prev.low;
  }
  for (let i = 0; i < days.length; i += 1) {
    if (i < 49) { metaByDay.get(days[i]).sma50 = null; continue; }
    let sum = 0;
    for (let j = i - 49; j <= i; j += 1) sum += metaByDay.get(days[j]).close;
    metaByDay.get(days[i]).sma50 = sum / 50;
  }
  return metaByDay;
}
function regimeOk(meta, expand) {
  if (!meta || meta.percentile == null || meta.adx == null) return false;
  if (meta.percentile < 40 || meta.percentile > 60) return false;
  if (expand) return true;
  return meta.adx <= 25;
}
function applySlip(price, side, isEntry) {
  if (side === "LONG") return price * (isEntry ? 1 + SLIPPAGE_PCT : 1 - SLIPPAGE_PCT);
  return price * (isEntry ? 1 - SLIPPAGE_PCT : 1 + SLIPPAGE_PCT);
}
function commission(notional) { return Math.abs(notional) * COMMISSION_PCT; }

function entryTrigger(bars, i, side, entryStyle, boxHigh, boxLow, zoneFrac) {
  const range = boxHigh - boxLow;
  if (!(range > 0) || i < 2) return false;
  const nearLow = boxLow + range * zoneFrac;
  const nearHigh = boxHigh - range * zoneFrac;

  if (entryStyle === "confirm") {
    const poke = bars[i - 1];
    const conf = bars[i];
    if (side === "LONG") {
      return poke.low <= nearLow && conf.close > poke.low && conf.close >= boxLow;
    }
    return poke.high >= nearHigh && conf.close < poke.high && conf.close <= boxHigh;
  }

  // unsharp
  const lead = bars[i - 2];
  const mid = bars[i - 1];
  const exec = bars[i];
  if (side === "LONG") {
    return lead.low <= nearLow &&
      mid.low >= lead.low &&
      exec.close > lead.low &&
      exec.close >= boxLow;
  }
  return lead.high >= nearHigh &&
    mid.high <= lead.high &&
    exec.close < lead.high &&
    exec.close <= boxHigh;
}

function vwapOk(side, close, vwap, dailyAtrAbs) {
  if (vwap == null || dailyAtrAbs == null || !(dailyAtrAbs > 0)) return false;
  const minDist = 0.2 * dailyAtrAbs;
  return side === "LONG" ? close <= vwap - minDist : close >= vwap + minDist;
}
function biasOk(side, dayClose, sma50) {
  if (sma50 == null) return false;
  return dayClose >= sma50 ? side === "LONG" : side === "SHORT";
}

function runOne({ side, engineName, engine, variant, bars5m, dailyMeta, rsi, atr5, vwapAt }) {
  const trades = [];
  let open = null;
  let dayTouched = new Map(); // day -> whether side already triggered

  for (let i = 60; i < bars5m.length; i += 1) {
    const bar = bars5m[i];
    const t = Date.parse(bar.closeTime);
    const day = utcDayKey(Date.parse(bar.openTime));
    const meta = dailyMeta.get(day);

    if (open) {
      const stopHit = open.side === "LONG" ? bar.low <= open.stop : bar.high >= open.stop;
      const tpHit = open.side === "LONG" ? bar.high >= open.tp : bar.low <= open.tp;
      const timeHit = i - open.entryIndex >= TIME_STOP_BARS;
      const flatHit = minutesUtc(t) >= HARD_FLAT_MIN;
      let reason = null, exitPx = null;
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
          side: open.side, net, rMultiple: net / open.riskDollars, reason,
          entryTime: open.entryTime, exitTime: bar.closeTime
        });
        open = null;
      }
      continue;
    }

    if (minutesUtc(t) >= HARD_FLAT_MIN) continue;
    if (!meta || meta.boxHigh == null || meta.range == null || !(meta.range > 0)) continue;
    if (!regimeOk(meta, variant.expandRegime)) continue;
    if (rsi[i] == null || atr5[i] == null) continue;
    if (dayTouched.get(`${day}:${side}`)) continue;

    if (!entryTrigger(bars5m, i, side, variant.entry, meta.boxHigh, meta.boxLow, engine.zoneFrac)) {
      continue;
    }

    if (side === "LONG" && !(rsi[i] <= 32)) continue;
    if (side === "SHORT" && !(rsi[i] >= 68)) continue;

    const dailyAtrAbs = meta.atrPct == null ? null : meta.atrPct * bar.close;
    if (variant.vwap && !vwapOk(side, bar.close, vwapAt[i], dailyAtrAbs)) continue;
    if (variant.bias && !biasOk(side, meta.close, meta.sma50)) continue;

    const stop = side === "LONG"
      ? meta.boxLow - engine.stopAtr * atr5[i]
      : meta.boxHigh + engine.stopAtr * atr5[i];
    const tp = side === "LONG"
      ? Math.min(meta.boxHigh, bar.close + engine.tpFrac * meta.range)
      : Math.max(meta.boxLow, bar.close - engine.tpFrac * meta.range);

    const entryFill = applySlip(bar.close, side, true);
    const risk = Math.abs(entryFill - stop);
    if (!(risk > 0)) continue;
    const qty = RESEARCH_RISK_CAP / risk;
    if (!(qty > 0)) continue;

    dayTouched.set(`${day}:${side}`, true);
    open = {
      side,
      entryIndex: i,
      entryTime: bar.closeTime,
      entryFill,
      stop,
      tp,
      qty,
      riskDollars: RESEARCH_RISK_CAP
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
      side: open.side, net, rMultiple: net / open.riskDollars, reason: "end-of-data",
      entryTime: open.entryTime, exitTime: last.closeTime
    });
  }

  const wins = trades.filter((t) => t.net > 0).length;
  const netPnl = trades.reduce((s, t) => s + t.net, 0);
  const avgR = trades.length ? trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length : 0;
  const totalR = trades.reduce((s, t) => s + t.rMultiple, 0);
  return {
    side,
    engine: engineName,
    variant: variant.name,
    trades: trades.length,
    netPnl,
    winRate: trades.length ? wins / trades.length : 0,
    avgR,
    totalR
  };
}

async function main() {
  console.log("Loading bars...");
  const bars5m = JSON.parse(await readFile(path.join(BARS_DIR, "5m.json"), "utf8"));
  const bars1d = JSON.parse(await readFile(path.join(BARS_DIR, "1d.json"), "utf8"));
  console.log(`5m=${bars5m.length} daily=${bars1d.length}`);

  const dailyMeta = buildDailyMeta(bars1d);
  const closes = bars5m.map((b) => b.close);
  const rsi = rsiSeries(closes, RSI_PERIOD);
  const atr5 = atrSeries(bars5m, ATR_PERIOD);

  // daily VWAP from 5m
  let dayKey = null, pv = 0, vol = 0;
  const vwapAt = new Array(bars5m.length).fill(null);
  for (let i = 0; i < bars5m.length; i += 1) {
    const b = bars5m[i];
    const k = utcDayKey(Date.parse(b.openTime));
    if (k !== dayKey) { dayKey = k; pv = 0; vol = 0; }
    const typical = (b.high + b.low + b.close) / 3;
    const v = Number(b.volume) || 0;
    pv += typical * v; vol += v;
    vwapAt[i] = vol > 0 ? pv / vol : null;
  }

  const results = [];
  for (const side of ["LONG", "SHORT"]) {
    for (const [engineName, engine] of Object.entries(ENGINES[side])) {
      console.log(`\n${side} / ${engineName}`);
      for (const variant of VARIANTS) {
        const r = runOne({ side, engineName, engine, variant, bars5m, dailyMeta, rsi, atr5, vwapAt });
        results.push(r);
        console.log(
          `  ${variant.name}: n=${r.trades} net=$${r.netPnl.toFixed(2)} ` +
          `win=${(r.winRate * 100).toFixed(1)}% avgR=${r.avgR.toFixed(2)} totalR=${r.totalR.toFixed(2)}`
        );
      }
    }
  }

  console.log("\n=== Ranked by totalR (all side/engine/variant) ===");
  const ranked = [...results].sort((a, b) => b.totalR - a.totalR);
  for (const r of ranked.slice(0, 20)) {
    console.log(
      `${r.side}/${r.engine}/${r.variant}: totalR=${r.totalR.toFixed(2)} ` +
      `net=$${r.netPnl.toFixed(2)} n=${r.trades} avgR=${r.avgR.toFixed(2)} win=${(r.winRate * 100).toFixed(1)}%`
    );
  }

  console.log("\n=== Ranked by avgR (min 10 trades) ===");
  const byAvg = [...results].filter((r) => r.trades >= 10).sort((a, b) => b.avgR - a.avgR);
  for (const r of byAvg.slice(0, 15)) {
    console.log(
      `${r.side}/${r.engine}/${r.variant}: avgR=${r.avgR.toFixed(2)} ` +
      `totalR=${r.totalR.toFixed(2)} net=$${r.netPnl.toFixed(2)} n=${r.trades} win=${(r.winRate * 100).toFixed(1)}%`
    );
  }

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, "engines-x9-summary.json");
  await writeFile(outPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${outPath}`);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

