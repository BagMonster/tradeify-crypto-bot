#!/usr/bin/env node
/**
 * scripts/unsharp-stop-sweep.mjs
 *
 * Unsharp 3-candle entry
 * + stop-distance sweep (while keeping $150 risk fixed)
 *
 * Goal: find at what stop % the stop-loss becomes a meaningful exit,
 * and where the trade-off between higher stop rate vs larger size turns negative.
 *
 * Research only. No live orders.
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BARS_DIR = path.resolve("artifacts", "research-bars-btcusd");
const OUT_DIR = path.resolve("artifacts", "boxfade-results");

const RISK_PER_TRADE = 150;
const DAILY_LOSS_FLOOR = 500;

const STOP_PCTS = [
  0.01, 0.0125, 0.015, 0.0175, 0.02,
  0.0225, 0.025, 0.03, 0.04, 0.05
];

const TP_PCTS = [
  0.0125, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05
];

const SIDES = ["LONG", "SHORT"];
const COMMISSION_PCT = 0.0004;
const SLIPPAGE_PCT = 0.0005;
const TIME_STOP_BARS = 48; // 4 hours
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
    byDay.set(utcDayKey(Date.parse(b.openTime)), {
      high: b.high,
      low: b.low,
      range: b.high - b.low
    });
  }
  const days = [...byDay.keys()].sort();
  const boxByDay = new Map();
  for (let i = 1; i < days.length; i++) {
    const prev = byDay.get(days[i - 1]);
    if (!(prev.range > 0)) continue;
    boxByDay.set(days[i], {
      boxHigh: prev.high,
      boxLow: prev.low,
      range: prev.range
    });
  }
  return boxByDay;
}

/**
 * Unsharp 3-candle sequence ending at index i (Execution candle)
 */
function isUnsharpEntry(bars, i, side, box) {
  if (i < 2) return false;

  const lead = bars[i - 2];
  const conf = bars[i - 1];
  const exec = bars[i];

  if (side === "LONG") {
    // Lead pokes below boxLow
    if (lead.low > box.boxLow) return false;
    // Confirmation does not make a lower low
    if (conf.low < lead.low) return false;
    // Execution closes back inside the box
    if (exec.close <= box.boxLow) return false;
    return true;
  }

  // SHORT
  if (lead.high < box.boxHigh) return false;
  if (conf.high > lead.high) return false;
  if (exec.close >= box.boxHigh) return false;
  return true;
}

function runConfig({ side, stopPct, tpPct }, bars5m, boxByDay) {
  const trades = [];
  const openTrades = [];
  let currentDay = null;
  let realizedPnLToday = 0;
  let skippedBudget = 0;
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

  for (let i = 2; i < bars5m.length; i++) {
    const bar = bars5m[i];
    const t = Date.parse(bar.closeTime);
    const day = utcDayKey(Date.parse(bar.openTime));

    if (day !== currentDay) {
      currentDay = day;
      realizedPnLToday = 0;
    }

    // Manage open trades
    for (let k = openTrades.length - 1; k >= 0; k--) {
      const tr = openTrades[k];
      const stopHit = tr.side === "LONG" ? bar.low <= tr.stop : bar.high >= tr.stop;
      const tpHit = tr.side === "LONG" ? bar.high >= tr.tp : bar.low <= tr.tp;
      const timeHit = i - tr.entryIndex >= TIME_STOP_BARS;
      const flatHit = minutesUtc(t) >= HARD_FLAT_MIN;

      let reason = null;
      let exitPx = null;

      if (stopHit && tpHit) {
        reason = "stop";
        exitPx = tr.stop;
      } else if (stopHit) {
        reason = "stop";
        exitPx = tr.stop;
      } else if (tpHit) {
        reason = "tp";
        exitPx = tr.tp;
      } else if (timeHit) {
        reason = "time";
        exitPx = bar.close;
      } else if (flatHit) {
        reason = "hard-flat";
        exitPx = bar.close;
      }

      if (reason) {
        closeTrade(tr, exitPx, bar.closeTime, reason);
        openTrades.splice(k, 1);
      }
    }

    if (minutesUtc(t) >= HARD_FLAT_MIN) continue;

    const box = boxByDay.get(day);
    if (!box || !(box.range > 0)) continue;

    if (!isUnsharpEntry(bars5m, i, side, box)) continue;

    signalsSeen += 1;

    const entryFill = applySlip(bar.close, side, true);

    const stop = side === "LONG"
      ? entryFill * (1 - stopPct)
      : entryFill * (1 + stopPct);

    const tp = side === "LONG"
      ? entryFill * (1 + tpPct)
      : entryFill * (1 - tpPct);

    const riskPrice = Math.abs(entryFill - stop);
    if (!(riskPrice > 0)) continue;

    const qty = RISK_PER_TRADE / riskPrice;
    const notional = qty * entryFill;
    if (!(qty > 0) || !(notional > 0)) continue;

    const openRisk = openTrades.reduce((s, tr) => s + tr.riskDollars, 0);
    if (openRisk + RISK_PER_TRADE > realizedPnLToday + DAILY_LOSS_FLOOR) {
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

  // Force-close leftovers
  if (openTrades.length) {
    const last = bars5m[bars5m.length - 1];
    for (const tr of [...openTrades]) {
      closeTrade(tr, last.close, last.closeTime, "end-of-data");
    }
    openTrades.length = 0;
  }

  const n = trades.length;
  const wins = trades.filter((t) => t.net > 0).length;
  const netPnl = trades.reduce((s, t) => s + t.net, 0);
  const avgR = n ? trades.reduce((s, t) => s + t.rMultiple, 0) / n : 0;
  const totalR = trades.reduce((s, t) => s + t.rMultiple, 0);

  const reasons = { tp: 0, stop: 0, time: 0, "hard-flat": 0, "end-of-data": 0 };
  for (const t of trades) reasons[t.reason] = (reasons[t.reason] || 0) + 1;

  const avgNotional = notionals.length
    ? notionals.reduce((s, x) => s + x, 0) / notionals.length
    : 0;

  return {
    side,
    stopPct: Math.round(stopPct * 10000) / 100,
    tpPct: Math.round(tpPct * 10000) / 100,
    signalsSeen,
    skippedBudget,
    trades: n,
    netPnl,
    winRate: n ? wins / n : 0,
    avgR,
    totalR,
    tpRate: n ? reasons.tp / n : 0,
    stopRate: n ? reasons.stop / n : 0,
    timeRate: n ? ((reasons.time || 0) + (reasons["hard-flat"] || 0) + (reasons["end-of-data"] || 0)) / n : 0,
    avgNotional,
    reasons
  };
}

async function main() {
  console.log("Loading BTCUSD bars...");
  const bars5m = JSON.parse(await readFile(path.join(BARS_DIR, "5m.json"), "utf8"));
  const bars1d = JSON.parse(await readFile(path.join(BARS_DIR, "1d.json"), "utf8"));

  console.log(`5m=${bars5m.length} daily=${bars1d.length}`);
  console.log(`Risk/trade=$${RISK_PER_TRADE} | Daily floor=$${DAILY_LOSS_FLOOR}`);
  console.log(`Unsharp 3-candle entry | 4h time stop`);
  console.log(`Stop sweep: ${STOP_PCTS.map((p) => (p * 100).toFixed(2) + "%").join(", ")}`);
  console.log(`TP sweep:   ${TP_PCTS.map((p) => (p * 100).toFixed(2) + "%").join(", ")}\n`);

  const boxByDay = buildBoxes(bars1d);
  const results = [];

  for (const side of SIDES) {
    for (const stopPct of STOP_PCTS) {
      for (const tpPct of TP_PCTS) {
        const r = runConfig({ side, stopPct, tpPct }, bars5m, boxByDay);
        results.push(r);
        console.log(
          `${r.side}/stop${r.stopPct}%/tp${r.tpPct}%: ` +
          `n=${r.trades} net=$${r.netPnl.toFixed(2)} win=${(r.winRate * 100).toFixed(1)}% ` +
          `avgR=${r.avgR.toFixed(3)} totalR=${r.totalR.toFixed(2)} ` +
          `stopRate=${(r.stopRate * 100).toFixed(1)}% tpRate=${(r.tpRate * 100).toFixed(1)}% ` +
          `timeRate=${(r.timeRate * 100).toFixed(1)}% avgNotional=$${r.avgNotional.toFixed(0)} ` +
          `skippedBudget=${r.skippedBudget}`
        );
      }
    }
  }

  console.log("\n=== Best by totalR ===");
  for (const r of [...results].sort((a, b) => b.totalR - a.totalR).slice(0, 25)) {
    console.log(
      `${r.side}/stop${r.stopPct}%/tp${r.tpPct}%: ` +
      `totalR=${r.totalR.toFixed(2)} net=$${r.netPnl.toFixed(2)} n=${r.trades} ` +
      `avgR=${r.avgR.toFixed(3)} win=${(r.winRate * 100).toFixed(1)}% ` +
      `stopRate=${(r.stopRate * 100).toFixed(1)}% tpRate=${(r.tpRate * 100).toFixed(1)}% ` +
      `timeRate=${(r.timeRate * 100).toFixed(1)}% avgNotional=$${r.avgNotional.toFixed(0)}`
    );
  }

  console.log("\n=== Best by avgR (min 30 trades) ===");
  for (const r of [...results].filter((x) => x.trades >= 30).sort((a, b) => b.avgR - a.avgR).slice(0, 25)) {
    console.log(
      `${r.side}/stop${r.stopPct}%/tp${r.tpPct}%: ` +
      `avgR=${r.avgR.toFixed(3)} totalR=${r.totalR.toFixed(2)} net=$${r.netPnl.toFixed(2)} ` +
      `n=${r.trades} win=${(r.winRate * 100).toFixed(1)}% ` +
      `stopRate=${(r.stopRate * 100).toFixed(1)}% tpRate=${(r.tpRate * 100).toFixed(1)}% ` +
      `avgNotional=$${r.avgNotional.toFixed(0)}`
    );
  }

  // Summary table by stop distance (averaged across TPs)
  console.log("\n=== Stop-distance summary (avg across TPs) ===");
  for (const side of SIDES) {
    console.log(`\n${side}:`);
    for (const stopPct of STOP_PCTS) {
      const subset = results.filter((r) => r.side === side && Math.abs(r.stopPct - stopPct * 100) < 0.01);
      if (subset.length === 0) continue;
      const avgStopRate = subset.reduce((s, r) => s + r.stopRate, 0) / subset.length;
      const avgTimeRate = subset.reduce((s, r) => s + r.timeRate, 0) / subset.length;
      const avgAvgR = subset.reduce((s, r) => s + r.avgR, 0) / subset.length;
      const avgNotional = subset.reduce((s, r) => s + r.avgNotional, 0) / subset.length;
      const totalTrades = subset.reduce((s, r) => s + r.trades, 0);
      console.log(
        `  stop ${ (stopPct * 100).toFixed(2) }%: ` +
        `avgStopRate=${(avgStopRate * 100).toFixed(1)}%  avgTimeRate=${(avgTimeRate * 100).toFixed(1)}%  ` +
        `avgR=${avgAvgR.toFixed(3)}  avgNotional=$${avgNotional.toFixed(0)}  totalTrades≈${totalTrades}`
      );
    }
  }

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, "unsharp-stop-sweep.json");
  await writeFile(
    outPath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`,
    "utf8"
  );
  console.log(`\nWrote ${outPath}`);
  console.log("Done. No live orders were placed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

