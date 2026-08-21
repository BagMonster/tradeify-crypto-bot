#!/usr/bin/env node
/**
 * scripts/box-edge-rr-study.mjs
 *
 * Research only. No orders. No network.
 *
 * Question:
 * When price approaches the prior-day high/low zone, how often does it reverse,
 * how far does it go in our favor, and where should stops/targets sit for
 * usable reward:risk?
 *
 * Usage:
 *   node scripts/box-edge-rr-study.mjs
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BARS_DIR = path.resolve("artifacts", "research-bars-btcusd");
const OUT_DIR = path.resolve("artifacts", "box-edge-study");

// Zone depth as fraction of prior-day range (from the edge inward)
const ZONE_FRACS = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40];

// Stop distance beyond the box edge, in ATR(14, 5m) multiples
const STOP_ATRS = [0.25, 0.5, 1.0, 1.5, 2.0, 3.0];

// Take-profit as fraction of prior-day range traveled toward the opposite edge
const TP_FRACS = [0.15, 0.25, 0.35, 0.50, 0.75, 1.00];

// Max bars to evaluate after a signal (4 hours on 5m)
const MAX_HOLD_BARS = 48;

const ATR_PERIOD = 14;

function utcDayKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function trueRange(bar, prevClose) {
  return Math.max(
    bar.high - bar.low,
    Math.abs(bar.high - prevClose),
    Math.abs(bar.low - prevClose)
  );
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
  // Map each UTC day -> prior day high/low and range
  const byDay = new Map();
  for (const b of dailyBars) {
    const day = utcDayKey(Date.parse(b.openTime));
    byDay.set(day, { high: b.high, low: b.low, close: b.close });
  }
  const days = [...byDay.keys()].sort();
  const boxByDay = new Map();
  for (let i = 1; i < days.length; i += 1) {
    const prev = byDay.get(days[i - 1]);
    const range = prev.high - prev.low;
    if (!(range > 0)) continue;
    boxByDay.set(days[i], {
      boxHigh: prev.high,
      boxLow: prev.low,
      range
    });
  }
  return boxByDay;
}

/**
 * First touch of a zone on a side for a day.
 * Long zone: near boxLow. Short zone: near boxHigh.
 */
function collectSignals(bars5m, boxByDay, atr5, zoneFrac) {
  const signals = [];
  let currentDay = null;
  let touchedLow = false;
  let touchedHigh = false;

  for (let i = ATR_PERIOD + 2; i < bars5m.length - MAX_HOLD_BARS; i += 1) {
    const bar = bars5m[i];
    const openMs = Date.parse(bar.openTime);
    const day = utcDayKey(openMs);
    if (day !== currentDay) {
      currentDay = day;
      touchedLow = false;
      touchedHigh = false;
    }

    const box = boxByDay.get(day);
    if (!box) continue;
    if (atr5[i] == null || !(atr5[i] > 0)) continue;

    const nearLow = box.boxLow + box.range * zoneFrac;
    const nearHigh = box.boxHigh - box.range * zoneFrac;

    // LONG candidate: first time price enters low zone this day
    if (!touchedLow && bar.low <= nearLow) {
      touchedLow = true;
      signals.push({
        side: "LONG",
        index: i,
        entry: bar.close,
        boxHigh: box.boxHigh,
        boxLow: box.boxLow,
        range: box.range,
        atr: atr5[i],
        time: bar.closeTime
      });
    }

    // SHORT candidate: first time price enters high zone this day
    if (!touchedHigh && bar.high >= nearHigh) {
      touchedHigh = true;
      signals.push({
        side: "SHORT",
        index: i,
        entry: bar.close,
        boxHigh: box.boxHigh,
        boxLow: box.boxLow,
        range: box.range,
        atr: atr5[i],
        time: bar.closeTime
      });
    }
  }
  return signals;
}

function evaluateSignal(signal, bars5m, stopAtrMult, tpFrac) {
  const { side, index, entry, boxHigh, boxLow, range, atr } = signal;

  const stop = side === "LONG"
    ? boxLow - stopAtrMult * atr
    : boxHigh + stopAtrMult * atr;

  // TP toward opposite edge by tpFrac of prior-day range
  const tp = side === "LONG"
    ? Math.min(boxHigh, entry + tpFrac * range)
    : Math.max(boxLow, entry - tpFrac * range);

  const risk = Math.abs(entry - stop);
  const reward = Math.abs(tp - entry);
  if (!(risk > 0) || !(reward > 0)) {
    return null;
  }

  let maxFavor = 0;
  let maxAdverse = 0;
  let result = "time";
  let exitPrice = bars5m[index + MAX_HOLD_BARS]?.close ?? bars5m[bars5m.length - 1].close;

  for (let j = index + 1; j <= index + MAX_HOLD_BARS && j < bars5m.length; j += 1) {
    const b = bars5m[j];

    if (side === "LONG") {
      maxFavor = Math.max(maxFavor, b.high - entry);
      maxAdverse = Math.max(maxAdverse, entry - b.low);
      const stopHit = b.low <= stop;
      const tpHit = b.high >= tp;
      if (stopHit && tpHit) {
        // conservative: assume stop first
        result = "stop";
        exitPrice = stop;
        break;
      }
      if (stopHit) {
        result = "stop";
        exitPrice = stop;
        break;
      }
      if (tpHit) {
        result = "tp";
        exitPrice = tp;
        break;
      }
    } else {
      maxFavor = Math.max(maxFavor, entry - b.low);
      maxAdverse = Math.max(maxAdverse, b.high - entry);
      const stopHit = b.high >= stop;
      const tpHit = b.low <= tp;
      if (stopHit && tpHit) {
        result = "stop";
        exitPrice = stop;
        break;
      }
      if (stopHit) {
        result = "stop";
        exitPrice = stop;
        break;
      }
      if (tpHit) {
        result = "tp";
        exitPrice = tp;
        break;
      }
    }
  }

  const pnlPoints = side === "LONG" ? exitPrice - entry : entry - exitPrice;
  const rMultiple = pnlPoints / risk;

  return {
    result,
    risk,
    reward,
    plannedRR: reward / risk,
    pnlPoints,
    rMultiple,
    maxFavor,
    maxAdverse,
    win: pnlPoints > 0
  };
}

function summarize(rows) {
  if (rows.length === 0) {
    return {
      n: 0,
      winRate: 0,
      avgR: 0,
      avgFavor: 0,
      avgAdverse: 0,
      stopRate: 0,
      tpRate: 0,
      avgPlannedRR: 0
    };
  }
  const wins = rows.filter((r) => r.win).length;
  const stops = rows.filter((r) => r.result === "stop").length;
  const tps = rows.filter((r) => r.result === "tp").length;
  const sum = (key) => rows.reduce((s, r) => s + r[key], 0);
  return {
    n: rows.length,
    winRate: wins / rows.length,
    avgR: sum("rMultiple") / rows.length,
    avgFavor: sum("maxFavor") / rows.length,
    avgAdverse: sum("maxAdverse") / rows.length,
    stopRate: stops / rows.length,
    tpRate: tps / rows.length,
    avgPlannedRR: sum("plannedRR") / rows.length
  };
}

async function main() {
  console.log("Loading BTCUSD bars...");
  const bars5m = JSON.parse(await readFile(path.join(BARS_DIR, "5m.json"), "utf8"));
  const bars1d = JSON.parse(await readFile(path.join(BARS_DIR, "1d.json"), "utf8"));
  console.log(`5m=${bars5m.length} daily=${bars1d.length}`);

  const boxByDay = buildBoxes(bars1d);
  const atr5 = atrSeries(bars5m, ATR_PERIOD);

  const grid = [];

  for (const zoneFrac of ZONE_FRACS) {
    const signals = collectSignals(bars5m, boxByDay, atr5, zoneFrac);
    console.log(`\nZone ${Math.round(zoneFrac * 100)}% of prior-day range → ${signals.length} first-touches`);

    for (const stopAtr of STOP_ATRS) {
      for (const tpFrac of TP_FRACS) {
        const evaluated = [];
        for (const sig of signals) {
          const row = evaluateSignal(sig, bars5m, stopAtr, tpFrac);
          if (row) evaluated.push(row);
        }
        const s = summarize(evaluated);
        grid.push({
          zonePct: Math.round(zoneFrac * 100),
          stopAtr,
          tpPctOfRange: Math.round(tpFrac * 100),
          ...s
        });
      }
    }
  }

  // Rank by avgR among cells with enough samples
  const usable = grid
    .filter((g) => g.n >= 30)
    .sort((a, b) => b.avgR - a.avgR);

  console.log("\n=== Top setups by average R (min 30 samples) ===");
  if (usable.length === 0) {
    console.log("No setups reached 30 samples. Showing top by avgR with n >= 10:");
    const fallback = grid.filter((g) => g.n >= 10).sort((a, b) => b.avgR - a.avgR).slice(0, 15);
    for (const g of fallback) {
      console.log(
        `zone=${g.zonePct}% stop=${g.stopAtr}ATR tp=${g.tpPctOfRange}%range ` +
        `n=${g.n} win=${(g.winRate * 100).toFixed(1)}% avgR=${g.avgR.toFixed(2)} ` +
        `plannedRR=${g.avgPlannedRR.toFixed(2)} stopRate=${(g.stopRate * 100).toFixed(1)}%`
      );
    }
  } else {
    for (const g of usable.slice(0, 20)) {
      console.log(
        `zone=${g.zonePct}% stop=${g.stopAtr}ATR tp=${g.tpPctOfRange}%range ` +
        `n=${g.n} win=${(g.winRate * 100).toFixed(1)}% avgR=${g.avgR.toFixed(2)} ` +
        `plannedRR=${g.avgPlannedRR.toFixed(2)} stopRate=${(g.stopRate * 100).toFixed(1)}%`
      );
    }
  }

  // Also print pure reversal follow-through by zone (no stop/tp model)
  console.log("\n=== Zone follow-through (max favorable move in 4h) ===");
  for (const zoneFrac of ZONE_FRACS) {
    const signals = collectSignals(bars5m, boxByDay, atr5, zoneFrac);
    let fav = 0;
    let adv = 0;
    let n = 0;
    for (const sig of signals) {
      // use a loose stop so we mainly observe path; still track excursions
      const row = evaluateSignal(sig, bars5m, 3.0, 1.0);
      if (!row) continue;
      fav += row.maxFavor;
      adv += row.maxAdverse;
      n += 1;
    }
    if (n === 0) continue;
    console.log(
      `zone=${Math.round(zoneFrac * 100)}% n=${n} ` +
      `avgFavor=${(fav / n).toFixed(2)} avgAdverse=${(adv / n).toFixed(2)} ` +
      `favor/adverse=${((fav / n) / (adv / n || 1)).toFixed(2)}`
    );
  }

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, "rr-grid.json");
  await writeFile(outPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), grid }, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${outPath}`);
  console.log("Done.");
}

main().catch((err) => {
  console.error(`box-edge-rr-study failed: ${err.message}`);
  console.error(err.stack);
  process.exitCode = 1;
});

