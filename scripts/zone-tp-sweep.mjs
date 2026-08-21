#!/usr/bin/env node
/**
 * scripts/zone-tp-sweep.mjs
 *
 * High-trade zone engine (zone-pct style) with fixed % take-profit sweep.
 * Research only. No live orders.
 *
 * - Zone + rejection entry
 * - Stop: 5% of entry (risk sized to $150)
 * - TP sweep: 0.25% .. 2.0% of entry
 * - 4h time stop if TP not hit
 * - Multiple concurrent trades allowed
 * - Daily budget:
 *     openRisk + newRisk <= realizedPnLToday + 500
 *   so banked wins allow more risk the same day
 *
 * Usage:
 *   node scripts/zone-tp-sweep.mjs
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BARS_DIR = path.resolve("artifacts", "research-bars-btcusd");
const OUT_DIR = path.resolve("artifacts", "boxfade-results");

const RISK_PER_TRADE = 150;
const DAILY_LOSS_FLOOR = 500; // max day drawdown budget
const STOP_PCT = 0.05; // 5%
const TP_PCTS = [0.0125, 0.015, 0.02, 0.0225,
  0.025, 0.0275, 0.03, 0.0325, 0.035,
  0.0375, 0.04, 0.0425, 0.045, 0.0475, 0.05];
const ZONE_FRACS = [0.05, 0.075, 0.10];
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

function runConfig({ side, zoneFrac, tpPct }, bars5m, boxByDay) {
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

  for (let i = 2; i < bars5m.length; i += 1) {
    const bar = bars5m[i];
    const t = Date.parse(bar.closeTime);
    const day = utcDayKey(Date.parse(bar.openTime));

    if (day !== currentDay) {
      currentDay = day;
      realizedPnLToday = 0;
    }

    // Manage open trades first
    for (let k = openTrades.length - 1; k >= 0; k -= 1) {
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
    if (!hasRejection(bars5m, i, side, box, zoneFrac)) continue;
    signalsSeen += 1;

    const entryFill = applySlip(bar.close, side, true);
    const stop = side === "LONG"
      ? entryFill * (1 - STOP_PCT)
      : entryFill * (1 + STOP_PCT);
    const tp = side === "LONG"
      ? entryFill * (1 + tpPct)
      : entryFill * (1 - tpPct);

    const riskPrice = Math.abs(entryFill - stop);
    if (!(riskPrice > 0)) continue;

    const qty = RISK_PER_TRADE / riskPrice;
    const notional = qty * entryFill;
    if (!(qty > 0) || !(notional > 0)) continue;

    // Daily budget with gains increasing capacity:
    // openRisk + newRisk <= realizedPnLToday + DAILY_LOSS_FLOOR
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
    zonePct: Math.round(zoneFrac * 1000) / 10,
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
  console.log(`Stop=${STOP_PCT * 100}% | TP sweep=${TP_PCTS.map((p) => (p * 100).toFixed(2) + "%").join(", ")}`);
  console.log("Daily rule: openRisk + newRisk <= realizedPnLToday + 500\n");

  const boxByDay = buildBoxes(bars1d);
  const results = [];

  for (const side of SIDES) {
    for (const zoneFrac of ZONE_FRACS) {
      for (const tpPct of TP_PCTS) {
        const r = runConfig({ side, zoneFrac, tpPct }, bars5m, boxByDay);
        results.push(r);
        console.log(
          `${r.side}/zone${r.zonePct}%/tp${r.tpPct}%: ` +
          `n=${r.trades} net=$${r.netPnl.toFixed(2)} win=${(r.winRate * 100).toFixed(1)}% ` +
          `avgR=${r.avgR.toFixed(3)} totalR=${r.totalR.toFixed(2)} ` +
          `tpRate=${(r.tpRate * 100).toFixed(1)}% timeRate=${(r.timeRate * 100).toFixed(1)}% ` +
          `stopRate=${(r.stopRate * 100).toFixed(1)}% avgNotional=$${r.avgNotional.toFixed(0)} ` +
          `skippedBudget=${r.skippedBudget}`
        );
      }
    }
  }

  console.log("\n=== Best by totalR ===");
  for (const r of [...results].sort((a, b) => b.totalR - a.totalR).slice(0, 20)) {
    console.log(
      `${r.side}/zone${r.zonePct}%/tp${r.tpPct}%: ` +
      `totalR=${r.totalR.toFixed(2)} net=$${r.netPnl.toFixed(2)} n=${r.trades} ` +
      `avgR=${r.avgR.toFixed(3)} win=${(r.winRate * 100).toFixed(1)}% ` +
      `tpRate=${(r.tpRate * 100).toFixed(1)}% timeRate=${(r.timeRate * 100).toFixed(1)}%`
    );
  }

  console.log("\n=== Best by avgR (min 100 trades) ===");
  for (const r of [...results].filter((x) => x.trades >= 100).sort((a, b) => b.avgR - a.avgR).slice(0, 20)) {
    console.log(
      `${r.side}/zone${r.zonePct}%/tp${r.tpPct}%: ` +
      `avgR=${r.avgR.toFixed(3)} totalR=${r.totalR.toFixed(2)} net=$${r.netPnl.toFixed(2)} ` +
      `n=${r.trades} win=${(r.winRate * 100).toFixed(1)}% tpRate=${(r.tpRate * 100).toFixed(1)}%`
    );
  }

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, "zone-tp-sweep.json");
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

