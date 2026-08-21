#!/usr/bin/env node
/**
 * scripts/zone-pct.mjs
 *
 * Fresh zone-rejection test with percent stops and multi-trade risk budget.
 * Research only. No live orders.
 *
 * Rules:
 * - Entry: zone + rejection
 * - Notional ~ risk / stopPct  (about $3000 when risk=$150 and stop=5%)
 * - Stop: 3%, 4%, 5% of entry price
 * - TP: 50% of prior-day range
 * - Multiple trades per day allowed
 * - Multiple concurrent trades allowed
 * - Daily budget: realized loss today + open risk + new risk <= $500
 *
 * Usage:
 *   node scripts/zone-pct.mjs
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BARS_DIR = path.resolve("artifacts", "research-bars-btcusd");
const OUT_DIR = path.resolve("artifacts", "boxfade-results");

const RISK_PER_TRADE = 150;          // target loss if stopped
const DAILY_RISK_BUDGET = 500;       // realized loss + open risk cap
const STOP_PCTS = [0.03, 0.04, 0.05];
const TP_FRAC_OF_RANGE = 0.50;
const ZONE_FRACS = [0.05, 0.075, 0.10]; // efficiency / middle / totalEdge-style
const SIDES = ["LONG", "SHORT"];

const COMMISSION_PCT = 0.0004;
const SLIPPAGE_PCT = 0.0005;
const TIME_STOP_BARS = 48; // 4h
const HARD_FLAT_MIN = 21 * 60 + 45;

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

function runConfig({ side, zoneFrac, stopPct }, bars5m, boxByDay) {
  const trades = [];
  const openTrades = [];
  let currentDay = null;
  let realizedPnLToday = 0;
  let skippedBudget = 0;
  let signalsSeen = 0;
  let notionals = [];

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
      notional: tr.notional,
      stopPct: tr.stopPct
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

    // Manage all open trades
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

    // New entries after hard-flat time: no
    if (minutesUtc(t) >= HARD_FLAT_MIN) continue;

    const box = boxByDay.get(day);
    if (!box || !(box.range > 0)) continue;
    if (!hasRejection(bars5m, i, side, box, zoneFrac)) continue;
    signalsSeen += 1;

    // Percent stop from entry
    const entryRaw = bar.close;
    const entryFill = applySlip(entryRaw, side, true);
    const stop = side === "LONG"
      ? entryFill * (1 - stopPct)
      : entryFill * (1 + stopPct);

    // TP: 50% of prior-day range from entry toward opposite side
    const tp = side === "LONG"
      ? entryFill + TP_FRAC_OF_RANGE * box.range
      : entryFill - TP_FRAC_OF_RANGE * box.range;

    const riskPrice = Math.abs(entryFill - stop);
    if (!(riskPrice > 0)) continue;

    // Size from fixed dollar risk
    const qty = RISK_PER_TRADE / riskPrice;
    const notional = qty * entryFill;
    if (!(qty > 0) || !(notional > 0)) continue;

    // Daily budget: realized loss today + open risk + new risk <= 500
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
      riskDollars: RISK_PER_TRADE,
      stopPct
    });
    notionals.push(notional);
  }

  // Close leftovers at end
  if (openTrades.length) {
    const last = bars5m[bars5m.length - 1];
    for (const tr of openTrades) {
      closeTrade(tr, last.close, last.closeTime, "end-of-data");
    }
    openTrades.length = 0;
  }

  const wins = trades.filter((t) => t.net > 0);
  const netPnl = trades.reduce((s, t) => s + t.net, 0);
  const avgR = trades.length ? trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length : 0;
  const totalR = trades.reduce((s, t) => s + t.rMultiple, 0);
  const stopRate = trades.length ? trades.filter((t) => t.reason === "stop").length / trades.length : 0;
  const tpRate = trades.length ? trades.filter((t) => t.reason === "tp").length / trades.length : 0;
  const avgNotional = notionals.length
    ? notionals.reduce((s, n) => s + n, 0) / notionals.length
    : 0;

  return {
    side,
    zonePct: Math.round(zoneFrac * 1000) / 10,
    stopPct: Math.round(stopPct * 100),
    signalsSeen,
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
  console.log(`Stops=${STOP_PCTS.map((p) => p * 100).join("% / ")}% | TP=${TP_FRAC_OF_RANGE * 100}% of prior-day range`);
  console.log("Multiple concurrent trades allowed under daily budget.\n");

  const boxByDay = buildBoxes(bars1d);
  const results = [];

  for (const side of SIDES) {
    for (const zoneFrac of ZONE_FRACS) {
      for (const stopPct of STOP_PCTS) {
        const r = runConfig({ side, zoneFrac, stopPct }, bars5m, boxByDay);
        results.push(r);
        console.log(
          `${r.side}/zone${r.zonePct}%/stop${r.stopPct}%: ` +
          `n=${r.trades} net=$${r.netPnl.toFixed(2)} win=${(r.winRate * 100).toFixed(1)}% ` +
          `avgR=${r.avgR.toFixed(2)} totalR=${r.totalR.toFixed(2)} ` +
          `stopRate=${(r.stopRate * 100).toFixed(1)}% tpRate=${(r.tpRate * 100).toFixed(1)}% ` +
          `avgNotional=$${r.avgNotional.toFixed(0)} skippedBudget=${r.skippedBudget}`
        );
      }
    }
  }

  console.log("\n=== Ranked by totalR ===");
  for (const r of [...results].sort((a, b) => b.totalR - a.totalR)) {
    console.log(
      `${r.side}/zone${r.zonePct}%/stop${r.stopPct}%: ` +
      `totalR=${r.totalR.toFixed(2)} net=$${r.netPnl.toFixed(2)} n=${r.trades} ` +
      `avgR=${r.avgR.toFixed(2)} win=${(r.winRate * 100).toFixed(1)}% avgNotional=$${r.avgNotional.toFixed(0)}`
    );
  }

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, "zone-pct-summary.json");
  await writeFile(outPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${outPath}`);
  console.log("Done. No live orders were placed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

