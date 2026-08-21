#!/usr/bin/env node
/**
 * scripts/run-boxfade-variants.mjs
 *
 * Offline 9-variant box-fade comparison on Dukascopy BTCUSD.
 * No network. No orders.
 *
 * Usage:
 *   node scripts/run-boxfade-variants.mjs
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BARS_DIR = path.resolve("artifacts", "research-bars-btcusd");
const OUT_DIR = path.resolve("artifacts", "boxfade-results");
const RESEARCH_RISK_CAP = 100;
const COMMISSION_PCT = 0.0004;
const SLIPPAGE_PCT = 0.0005;
const TIME_STOP_BARS = 48; // 4 hours on 5m
const HARD_FLAT_UTC_MINUTES = 21 * 60 + 45;
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;
const ADX_PERIOD = 14;
const REGIME_LOOKBACK = 120;
const PCT_LO = 40;
const PCT_HI = 60;

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

function trueRange(bar, prevClose) {
  return Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
}

function wilderAtrSeries(bars, period) {
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
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    const ch = closes[i] - closes[i - 1];
    avgGain += Math.max(ch, 0);
    avgLoss += Math.max(-ch, 0);
  }
  avgGain /= period;
  avgLoss /= period;
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
  // endIndex inclusive; need period*2 bars
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

function nearestRankPercentile(sortedAsc, value) {
  // percentile rank of value within sortedAsc using position of value
  if (sortedAsc.length === 0) return null;
  let below = 0;
  for (const v of sortedAsc) if (v < value) below += 1;
  // percent of prior days strictly below current value
  return (below / sortedAsc.length) * 100;
}

function buildDailyMeta(dailyBars) {
  const atr = wilderAtrSeries(dailyBars, ATR_PERIOD);
  const metaByDay = new Map();
  for (let i = 0; i < dailyBars.length; i += 1) {
    const bar = dailyBars[i];
    const day = utcDayKey(Date.parse(bar.openTime));
    const atrVal = atr[i];
    const atrPct = atrVal == null ? null : atrVal / bar.close;
    const adx = adxAtEnd(dailyBars, i, ADX_PERIOD);
    // percentile from prior 120 days only
    let percentile = null;
    if (atrPct != null && i >= 1) {
      const start = Math.max(0, i - REGIME_LOOKBACK);
      const prior = [];
      for (let j = start; j < i; j += 1) {
        if (atr[j] != null) prior.push(atr[j] / dailyBars[j].close);
      }
      if (prior.length >= 30) {
        prior.sort((a, b) => a - b);
        percentile = nearestRankPercentile(prior, atrPct);
      }
    }
    metaByDay.set(day, {
      day,
      atr,
      atrPct,
      adx,
      percentile,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close
    });
  }
  // prior-day box for each day
  const days = [...metaByDay.keys()].sort();
  for (let i = 1; i < days.length; i += 1) {
    const prev = metaByDay.get(days[i - 1]);
    const cur = metaByDay.get(days[i]);
    cur.boxHigh = prev.high;
    cur.boxLow = prev.low;
  }
  // 50-day SMA on daily closes
  for (let i = 0; i < days.length; i += 1) {
    if (i < 49) {
      metaByDay.get(days[i]).sma50 = null;
      continue;
    }
    let sum = 0;
    for (let j = i - 49; j <= i; j += 1) sum += metaByDay.get(days[j]).close;
    metaByDay.get(days[i]).sma50 = sum / 50;
  }
  return metaByDay;
}

function regimeAllowed(meta, expandRegime) {
  if (!meta || meta.percentile == null || meta.adx == null) return false;
  if (meta.percentile < PCT_LO || meta.percentile > PCT_HI) return false;
  if (expandRegime) return true;
  return meta.adx <= 25;
}

function minutesUtc(ms) {
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function applyCosts(price, side, isEntry) {
  // slippage against us + commission
  const slip = side === "LONG"
    ? (isEntry ? 1 + SLIPPAGE_PCT : 1 - SLIPPAGE_PCT)
    : (isEntry ? 1 - SLIPPAGE_PCT : 1 + SLIPPAGE_PCT);
  const px = price * slip;
  return px;
}

function commission(notional) {
  return Math.abs(notional) * COMMISSION_PCT;
}

function detectEntry(bars, i, entryStyle, boxHigh, boxLow) {
  // returns LONG/SHORT or null at bar i (execution bar)
  if (i < 2) return null;
  if (entryStyle === "confirm") {
    const poke = bars[i - 1];
    const conf = bars[i];
    // short setup: poke high above box, confirm close back inside
    if (poke.high > boxHigh && conf.close < boxHigh && conf.close > boxLow) {
      return "SHORT";
    }
    // long setup: poke low below box, confirm close back inside
    if (poke.low < boxLow && conf.close > boxLow && conf.close < boxHigh) {
      return "LONG";
    }
    return null;
  }
  // unsharp: lead, no new extreme, execution close inside
  if (i < 2) return null;
  const lead = bars[i - 2];
  const mid = bars[i - 1];
  const exec = bars[i];
  // short
  if (lead.high > boxHigh && mid.high <= lead.high && exec.close < boxHigh && exec.close > boxLow) {
    return "SHORT";
  }
  // long
  if (lead.low < boxLow && mid.low >= lead.low && exec.close > boxLow && exec.close < boxHigh) {
    return "LONG";
  }
  return null;
}

function vwapOk(side, close, vwap, dailyAtrAbs) {
  if (vwap == null || dailyAtrAbs == null || dailyAtrAbs <= 0) return false;
  const minDist = 0.2 * dailyAtrAbs;
  if (side === "LONG") return close <= vwap - minDist;
  return close >= vwap + minDist;
}

function biasOk(side, close, sma50) {
  if (sma50 == null) return false;
  if (close >= sma50) return side === "LONG";
  return side === "SHORT";
}

function runVariant(variant, bars5m, dailyMeta) {
  const closes = bars5m.map((b) => b.close);
  const rsi = rsiSeries(closes, RSI_PERIOD);
  const atr5 = wilderAtrSeries(bars5m, ATR_PERIOD);

  // daily VWAP from 5m typical price
  let dayKey = null;
  let pv = 0;
  let vol = 0;
  const vwapAt = new Array(bars5m.length).fill(null);
  for (let i = 0; i < bars5m.length; i += 1) {
    const b = bars5m[i];
    const k = utcDayKey(Date.parse(b.openTime));
    if (k !== dayKey) {
      dayKey = k;
      pv = 0;
      vol = 0;
    }
    const typical = (b.high + b.low + b.close) / 3;
    const v = Number(b.volume) || 0;
    pv += typical * v;
    vol += v;
    vwapAt[i] = vol > 0 ? pv / vol : null;
  }

  const trades = [];
  let open = null;

  for (let i = 60; i < bars5m.length; i += 1) {
    const bar = bars5m[i];
    const t = Date.parse(bar.closeTime);
    const day = utcDayKey(Date.parse(bar.openTime));
    const meta = dailyMeta.get(day);

    // manage open trade
    if (open) {
      const stopHit = open.side === "LONG" ? bar.low <= open.stop : bar.high >= open.stop;
      const targetHit = open.side === "LONG" ? bar.high >= open.target : bar.low <= open.target;
      const timeHit = i - open.entryIndex >= TIME_STOP_BARS;
      const flatHit = minutesUtc(t) >= HARD_FLAT_UTC_MINUTES;

      let exitReason = null;
      let exitPx = null;
      if (stopHit && targetHit) {
        exitReason = "stop"; // conservative precedence
        exitPx = open.stop;
      } else if (stopHit) {
        exitReason = "stop";
        exitPx = open.stop;
      } else if (targetHit) {
        exitReason = "target";
        exitPx = open.target;
      } else if (timeHit) {
        exitReason = "time";
        exitPx = bar.close;
      } else if (flatHit) {
        exitReason = "hard-flat";
        exitPx = bar.close;
      }

      if (exitReason) {
        const fill = applyCosts(exitPx, open.side, false);
        const gross = open.side === "LONG"
          ? (fill - open.entryFill) * open.qty
          : (open.entryFill - fill) * open.qty;
        const costs = commission(open.entryFill * open.qty) + commission(fill * open.qty);
        const net = gross - costs;
        const rMultiple = open.riskDollars > 0 ? net / open.riskDollars : null;
        trades.push({
          side: open.side,
          entryTime: open.entryTime,
          exitTime: bar.closeTime,
          entry: open.entryFill,
          exit: fill,
          qty: open.qty,
          net,
          rMultiple,
          exitReason
        });
        open = null;
      }
      continue; // one position only; no new entries while open
    }

    // no new entries at/after hard flat
    if (minutesUtc(t) >= HARD_FLAT_UTC_MINUTES) continue;
    if (!meta || meta.boxHigh == null || meta.boxLow == null) continue;
    if (!regimeAllowed(meta, variant.expandRegime)) continue;
    if (rsi[i] == null || atr5[i] == null) continue;

    const side = detectEntry(bars5m, i, variant.entry, meta.boxHigh, meta.boxLow);
    if (!side) continue;

    // RSI confluence
    if (side === "LONG" && !(rsi[i] <= 32)) continue;
    if (side === "SHORT" && !(rsi[i] >= 68)) continue;

    // optional filters
    const dailyAtrAbs = meta.atrPct == null ? null : meta.atrPct * bar.close;
    if (variant.vwap && !vwapOk(side, bar.close, vwapAt[i], dailyAtrAbs)) continue;
    if (variant.bias && !biasOk(side, meta.close, meta.sma50)) continue;

    // stop from box edge, target opposite edge
    const stop = side === "LONG"
      ? meta.boxLow - 3 * atr5[i]
      : meta.boxHigh + 3 * atr5[i];
    const target = side === "LONG" ? meta.boxHigh : meta.boxLow;
    const entryRaw = bar.close;
    const entryFill = applyCosts(entryRaw, side, true);
    const stopDist = Math.abs(entryFill - stop);
    if (!(stopDist > 0) || !(target !== entryFill)) continue;

    const qty = RESEARCH_RISK_CAP / stopDist;
    if (!(qty > 0)) continue;

    open = {
      side,
      entryIndex: i,
      entryTime: bar.closeTime,
      entryFill,
      stop,
      target,
      qty,
      riskDollars: RESEARCH_RISK_CAP
    };
  }

  // force close if still open at end
  if (open) {
    const last = bars5m[bars5m.length - 1];
    const fill = applyCosts(last.close, open.side, false);
    const gross = open.side === "LONG"
      ? (fill - open.entryFill) * open.qty
      : (open.entryFill - fill) * open.qty;
    const costs = commission(open.entryFill * open.qty) + commission(fill * open.qty);
    const net = gross - costs;
    trades.push({
      side: open.side,
      entryTime: open.entryTime,
      exitTime: last.closeTime,
      entry: open.entryFill,
      exit: fill,
      qty: open.qty,
      net,
      rMultiple: open.riskDollars > 0 ? net / open.riskDollars : null,
      exitReason: "end-of-data"
    });
  }

  const wins = trades.filter((t) => t.net > 0);
  const netPnl = trades.reduce((s, t) => s + t.net, 0);
  const avgR = trades.length
    ? trades.reduce((s, t) => s + (t.rMultiple ?? 0), 0) / trades.length
    : 0;
  return {
    variant: variant.name,
    trades: trades.length,
    netPnl,
    winRate: trades.length ? wins.length / trades.length : 0,
    avgR,
    longs: trades.filter((t) => t.side === "LONG").length,
    shorts: trades.filter((t) => t.side === "SHORT").length,
    tradeList: trades
  };
}

async function main() {
  console.log("Loading BTCUSD bars...");
  const bars5m = JSON.parse(await readFile(path.join(BARS_DIR, "5m.json"), "utf8"));
  const bars1d = JSON.parse(await readFile(path.join(BARS_DIR, "1d.json"), "utf8"));
  console.log(`5m=${bars5m.length} 1d=${bars1d.length}`);

  console.log("Building daily regime/box metadata...");
  const dailyMeta = buildDailyMeta(bars1d);

  console.log("Running 9 variants...\n");
  const results = [];
  for (const v of VARIANTS) {
    const r = runVariant(v, bars5m, dailyMeta);
    results.push(r);
    console.log(
      `#${v.id} ${v.name}: trades=${r.trades} net=$${r.netPnl.toFixed(2)} ` +
      `win=${(r.winRate * 100).toFixed(1)}% avgR=${r.avgR.toFixed(2)} ` +
      `L/S=${r.longs}/${r.shorts}`
    );
  }

  results.sort((a, b) => b.netPnl - a.netPnl);
  console.log("\nRanked by net P&L:");
  results.forEach((r, idx) => {
    console.log(
      `${idx + 1}. ${r.variant}: $${r.netPnl.toFixed(2)} | ${r.trades} trades | ` +
      `${(r.winRate * 100).toFixed(1)}% win | ${r.avgR.toFixed(2)}R`
    );
  });

  await mkdir(OUT_DIR, { recursive: true });
  const summary = results.map(({ tradeList, ...rest }) => rest);
  await writeFile(
    path.join(OUT_DIR, "variant-summary.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), summary }, null, 2)}\n`,
    "utf8"
  );
  console.log(`\nWrote ${path.join(OUT_DIR, "variant-summary.json")}`);
  console.log("Done. No live orders were placed.");
}

main().catch((err) => {
  console.error(`run-boxfade-variants failed: ${err.message}`);
  console.error(err.stack);
  process.exitCode = 1;
});

