#!/usr/bin/env node
/**
 * scripts/zone-pct-regime.mjs
 *
 * Zone + rejection + percent stops + multi-trade daily budget
 * + rolling percentile regime (40-60) and ADX <= 25.
 *
 * Usage:
 *   node scripts/zone-pct-regime.mjs
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BARS_DIR = path.resolve("artifacts", "research-bars-btcusd");
const OUT_DIR = path.resolve("artifacts", "boxfade-results");

const RISK_PER_TRADE = 150;
const DAILY_RISK_BUDGET = 500;
const STOP_PCTS = [0.03, 0.04, 0.05];
const TP_FRAC_OF_RANGE = 0.50;
const ZONE_FRACS = [0.05, 0.075, 0.10];
const SIDES = ["LONG", "SHORT"];

const COMMISSION_PCT = 0.0004;
const SLIPPAGE_PCT = 0.0005;
const TIME_STOP_BARS = 48;
const HARD_FLAT_MIN = 21 * 60 + 45;

const ATR_PERIOD = 14;
const ADX_PERIOD = 14;
const REGIME_LOOKBACK = 120;
const PCT_LO = 40;
const PCT_HI = 60;

function utcDayKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function minutesUtc(ms) {
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function applySlip(price, side, isEntry) {
  if (side === "LONG") return price * (isEntry ? 1 + SLIPPAGE_PCT : 1 - SLIPPAGE_PCT);
  return price * (isEntry ? 1 - SLIPPAGE_PCT : 1 + SLIPPAGE_PCT);
}
function commission(notional) {
  return Math.abs(notional) * COMMISSION_PCT;
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
      for (let j = start; j < i; j += 1) {
        if (atr[j] != null) prior.push(atr[j] / dailyBars[j].close);
      }
      if (prior.length >= 30) {
        prior.sort((a, b) => a - b);
        percentile = percentileRank(prior, atrPct);
      }
    }
    metaByDay.set(day, {
      high: bar.high,
      low: bar.low,
      close: bar.close,
      atrPct,
      adx,
      percentile
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
  return metaByDay;
}
function regimeOk(meta) {
  if (!meta || meta.percentile == null || meta.adx == null) return false;
  if (meta.percentile < PCT_LO || meta.percentile > PCT_HI) return false;
  return meta.adx <= 25;
}
function hasRejection(bars, i, side, box, zoneFrac) {
  const nearLow = box.boxLow + box.range * zoneFrac;
  const nearHigh = box.boxHigh - box.range * zoneFrac;
  const cur = bars[i];
  const prev = bars[i - 1];
  if (side === "LONG") {
    if (cur.low <= nearLow && cur.close > nearLow) return true;
    if (prev.low <= nearLow && cur.close > nearLow && cur.close >= prev.close) return true;
    return false;
  }
  if (cur.high >= nearHigh && cur.close < nearHigh) return true;
  if (prev.high >= nearHigh && cur.close < nearHigh && cur.close <= prev.close) return true;
  return false;
}

function runConfig({ side, zoneFrac, stopPct }, bars5m, dailyMeta) {
  const trades = [];
  const openTrades = [];
  let currentDay = null;
  let realizedPnLToday = 0;
  let skippedBudget = 0;
  let skippedRegime = 0;
  let signalsSeen = 0;
  const notionals = [];

  const closeTrade = (tr, exitPx, exitTime, reason) => {
    const fill = applySlip(exitPx, tr.side, false);
    const gross = tr.side === "LONG"
      ? (fill - tr.entryFill) * tr.qty
      : (tr.entryFill - fill) * tr.qty;
    const costs = commission(tr.entryFill * tr.qty) + commission(fill * tr.qty);
    const net = gross - costs;
    trades.push({
      side: tr.side,
      entryTime: tr.entryTime,
      exitTime,
      net,
      rMultiple: net / tr.riskDollars,
      reason,
      notional: tr.notional
    });
    if (tr.day === currentDay) realizedPnLToday += net;
  };

  for (let i = 2; i < bars5m.length; i += 1) {
    const bar = bars5m[i];
    const t = Date.parse(bar.closeTime);
    const day = utcDayKey(Date.parse(bar.openTime));

    if (day !== currentDay) {
      currentDay = day;
      realizedPnLToday = 0;
    }

    for (let k = openTrades.length - 1; k >= 0; k -= 1) {
      const tr = openTrades[k];
      const stopHit = tr.side === "LONG" ? bar.low <= tr.stop : bar.high >= tr.stop;
      const tpHit = tr.side === "LONG" ? bar.high >= tr.tp : bar.low <= tr.tp;
      const timeHit = i - tr.entryIndex >= TIME_STOP_BARS;
      const flatHit = minutesUtc(t) >= HARD_FLAT_MIN;

      let reason = null;
      let exitPx = null;
      if (stopHit && tpHit) { reason = "stop"; exitPx = tr.stop; }
      else if (stopHit) { reason = "stop"; exitPx = tr.stop; }
      else if (tpHit) { reason = "tp"; exitPx = tr.tp; }
      else if (timeHit) { reason = "time"; exitPx = bar.close; }
      else if (flatHit) { reason = "hard-flat"; exitPx = bar.close; }

      if (reason) {
        closeTrade(tr, exitPx, bar.closeTime, reason);
        openTrades.splice(k, 1);
      }
    }

    if (minutesUtc(t) >= HARD_FLAT_MIN) continue;

    const meta = dailyMeta.get(day);
    if (!meta || meta.boxHigh == null || !(meta.range > 0)) continue;
    if (!regimeOk(meta)) {
      // count only if this bar would otherwise be a rejection signal
      if (hasRejection(bars5m, i, side, meta, zoneFrac)) skippedRegime += 1;
      continue;
    }
    if (!hasRejection(bars5m, i, side, meta, zoneFrac)) continue;
    signalsSeen += 1;

    const entryFill = applySlip(bar.close, side, true);
    const stop = side === "LONG" ? entryFill * (1 - stopPct) : entryFill * (1 + stopPct);
    const tp = side === "LONG"
      ? entryFill + TP_FRAC_OF_RANGE * meta.range
      : entryFill - TP_FRAC_OF_RANGE * meta.range;

    const riskPrice = Math.abs(entryFill - stop);
    if (!(riskPrice > 0)) continue;
    const qty = RISK_PER_TRADE / riskPrice;
    const notional = qty * entryFill;
    if (!(qty > 0)) continue;

    const openRisk = openTrades.reduce((s, tr) => s + tr.riskDollars, 0);
    const realizedLoss = Math.max(0, -realizedPnLToday);
    if (realizedLoss + openRisk + RISK_PER_TRADE > DAILY_RISK_BUDGET) {
      skippedBudget += 1;
      continue;
    }

    openTrades.push({
      side,
      day,
      entryIndex: i,
      entryTime: bar.closeTime,
      entryFill,
      stop,
      tp,
      qty,
      notional,
      riskDollars: RISK_PER_TRADE
    });
    notionals.push(notional);
  }

  if (openTrades.length) {
    const last = bars5m[bars5m.length - 1];
    for (const tr of [...openTrades]) closeTrade(tr, last.close, last.closeTime, "end-of-data");
    openTrades.length = 0;
  }

  const wins = trades.filter((t) => t.net > 0);
  const netPnl = trades.reduce((s, t) => s + t.net, 0);
  const avgR = trades.length ? trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length : 0;
  const totalR = trades.reduce((s, t) => s + t.rMultiple, 0);
  const stopRate = trades.length ? trades.filter((t) => t.reason === "stop").length / trades.length : 0;
  const tpRate = trades.length ? trades.filter((t) => t.reason === "tp").length / trades.length : 0;
  const avgNotional = notionals.length ? notionals.reduce((s, n) => s + n, 0) / notionals.length : 0;

  return {
    side,
    zonePct: Math.round(zoneFrac * 1000) / 10,
    stopPct: Math.round(stopPct * 100),
    signalsSeen,
    skippedRegime,
    skippedBudget,
    trades: trades.length,
    netPnl,
    winRate: trades.length ? wins.length / trades.length : 0,
    avgR,
    totalR,
    stopRate,
    tpRate,
    avgNotional
  };
}

async function main() {
  console.log("Loading BTCUSD bars...");
  const bars5m = JSON.parse(await readFile(path.join(BARS_DIR, "5m.json"), "utf8"));
  const bars1d = JSON.parse(await readFile(path.join(BARS_DIR, "1d.json"), "utf8"));
  console.log(`5m=${bars5m.length} daily=${bars1d.length}`);
  console.log(`Risk/trade=$${RISK_PER_TRADE} | Daily budget=$${DAILY_RISK_BUDGET}`);
  console.log(`Regime: ATR% percentile ${PCT_LO}-${PCT_HI} over prior ${REGIME_LOOKBACK}d + ADX<=25`);
  console.log("Multiple concurrent trades allowed under daily budget.\n");

  const dailyMeta = buildDailyMeta(bars1d);
  const results = [];

  for (const side of SIDES) {
    for (const zoneFrac of ZONE_FRACS) {
      for (const stopPct of STOP_PCTS) {
        const r = runConfig({ side, zoneFrac, stopPct }, bars5m, dailyMeta);
        results.push(r);
        console.log(
          `${r.side}/zone${r.zonePct}%/stop${r.stopPct}%: ` +
          `n=${r.trades} net=$${r.netPnl.toFixed(2)} win=${(r.winRate * 100).toFixed(1)}% ` +
          `avgR=${r.avgR.toFixed(2)} totalR=${r.totalR.toFixed(2)} ` +
          `stopRate=${(r.stopRate * 100).toFixed(1)}% tpRate=${(r.tpRate * 100).toFixed(1)}% ` +
          `avgNotional=$${r.avgNotional.toFixed(0)} skippedRegime=${r.skippedRegime} skippedBudget=${r.skippedBudget}`
        );
      }
    }
  }

  console.log("\n=== Ranked by totalR ===");
  for (const r of [...results].sort((a, b) => b.totalR - a.totalR)) {
    console.log(
      `${r.side}/zone${r.zonePct}%/stop${r.stopPct}%: ` +
      `totalR=${r.totalR.toFixed(2)} net=$${r.netPnl.toFixed(2)} n=${r.trades} ` +
      `avgR=${r.avgR.toFixed(2)} win=${(r.winRate * 100).toFixed(1)}%`
    );
  }

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, "zone-pct-regime-summary.json");
  await writeFile(outPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${outPath}`);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

