#!/usr/bin/env node
/**
 * scripts/box-edge-focused-study.mjs
 *
 * Focused research only. No orders. No network.
 *
 * Zones: 5%, 10%, 15% of prior-day range
 * Stops: 0.5, 1.0, 1.5 ATR beyond box edge
 * TP: 25%, 35%, 50% of prior-day range
 * Split: LONG and SHORT reported separately
 *
 * Usage:
 *   node scripts/box-edge-focused-study.mjs
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BARS_DIR = path.resolve("artifacts", "research-bars-btcusd");
const OUT_DIR = path.resolve("artifacts", "box-edge-study");

const ZONE_FRACS = [0.05, 0.10, 0.15];
const STOP_ATRS = [0.5, 1.0, 1.5];
const TP_FRACS = [0.25, 0.35, 0.50];
const MAX_HOLD_BARS = 48; // 4 hours
const ATR_PERIOD = 14;
const MIN_SAMPLES = 20;

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
  const byDay = new Map();
  for (const b of dailyBars) {
    const day = utcDayKey(Date.parse(b.openTime));
    byDay.set(day, { high: b.high, low: b.low });
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

function collectSignals(bars5m, boxByDay, atr5, zoneFrac, sideFilter) {
  const signals = [];
  let currentDay = null;
  let touchedLow = false;
  let touchedHigh = false;

  for (let i = ATR_PERIOD + 2; i < bars5m.length - MAX_HOLD_BARS; i += 1) {
    const bar = bars5m[i];
    const day = utcDayKey(Date.parse(bar.openTime));
    if (day !== currentDay) {
      currentDay = day;
      touchedLow = false;
      touchedHigh = false;
    }

    const box = boxByDay.get(day);
    if (!box || atr5[i] == null || !(atr5[i] > 0)) continue;

    const nearLow = box.boxLow + box.range * zoneFrac;
    const nearHigh = box.boxHigh - box.range * zoneFrac;

    if (sideFilter === "LONG" && !touchedLow && bar.low <= nearLow) {
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

    if (sideFilter === "SHORT" && !touchedHigh && bar.high >= nearHigh) {
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

  const tp = side === "LONG"
    ? Math.min(boxHigh, entry + tpFrac * range)
    : Math.max(boxLow, entry - tpFrac * range);

  const risk = Math.abs(entry - stop);
  const reward = Math.abs(tp - entry);
  if (!(risk > 0) || !(reward > 0)) return null;

  let maxFavor = 0;
  let maxAdverse = 0;
  let result = "time";
  let exitPrice = bars5m[Math.min(index + MAX_HOLD_BARS, bars5m.length - 1)].close;

  for (let j = index + 1; j <= index + MAX_HOLD_BARS && j < bars5m.length; j += 1) {
    const b = bars5m[j];

    if (side === "LONG") {
      maxFavor = Math.max(maxFavor, b.high - entry);
      maxAdverse = Math.max(maxAdverse, entry - b.low);
      const stopHit = b.low <= stop;
      const tpHit = b.high >= tp;
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
  return {
    result,
    risk,
    reward,
    plannedRR: reward / risk,
    pnlPoints,
    rMultiple: pnlPoints / risk,
    maxFavor,
    maxAdverse,
    win: pnlPoints > 0
  };
}

function summarize(rows) {
  if (rows.length === 0) {
    return {
      n: 0, winRate: 0, avgR: 0, avgFavor: 0, avgAdverse: 0,
      stopRate: 0, tpRate: 0, avgPlannedRR: 0
    };
  }
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  const wins = rows.filter((r) => r.win).length;
  const stops = rows.filter((r) => r.result === "stop").length;
  const tps = rows.filter((r) => r.result === "tp").length;
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

function printTop(title, grid) {
  console.log(`\n=== ${title} ===`);
  const usable = grid.filter((g) => g.n >= MIN_SAMPLES).sort((a, b) => b.avgR - a.avgR);
  const list = usable.length > 0 ? usable : grid.filter((g) => g.n >= 10).sort((a, b) => b.avgR - a.avgR);
  if (list.length === 0) {
    console.log("No rows to show.");
    return;
  }
  for (const g of list.slice(0, 12)) {
    console.log(
      `zone=${g.zonePct}% stop=${g.stopAtr}ATR tp=${g.tpPct}%range ` +
      `n=${g.n} win=${(g.winRate * 100).toFixed(1)}% avgR=${g.avgR.toFixed(2)} ` +
      `RR=${g.avgPlannedRR.toFixed(2)} stopRate=${(g.stopRate * 100).toFixed(1)}% ` +
      `tpRate=${(g.tpRate * 100).toFixed(1)}%`
    );
  }
}

async function runSide(side, bars5m, boxByDay, atr5) {
  const grid = [];
  for (const zoneFrac of ZONE_FRACS) {
    const signals = collectSignals(bars5m, boxByDay, atr5, zoneFrac, side);
    console.log(`${side} zone ${Math.round(zoneFrac * 100)}% → ${signals.length} signals`);
    for (const stopAtr of STOP_ATRS) {
      for (const tpFrac of TP_FRACS) {
        const evaluated = [];
        for (const sig of signals) {
          const row = evaluateSignal(sig, bars5m, stopAtr, tpFrac);
          if (row) evaluated.push(row);
        }
        const s = summarize(evaluated);
        grid.push({
          side,
          zonePct: Math.round(zoneFrac * 100),
          stopAtr,
          tpPct: Math.round(tpFrac * 100),
          ...s
        });
      }
    }
  }
  return grid;
}

async function main() {
  console.log("Loading BTCUSD bars...");
  const bars5m = JSON.parse(await readFile(path.join(BARS_DIR, "5m.json"), "utf8"));
  const bars1d = JSON.parse(await readFile(path.join(BARS_DIR, "1d.json"), "utf8"));
  console.log(`5m=${bars5m.length} daily=${bars1d.length}`);

  const boxByDay = buildBoxes(bars1d);
  const atr5 = atrSeries(bars5m, ATR_PERIOD);

  console.log("\nRunning LONG grid...");
  const longGrid = await runSide("LONG", bars5m, boxByDay, atr5);

  console.log("\nRunning SHORT grid...");
  const shortGrid = await runSide("SHORT", bars5m, boxByDay, atr5);

  printTop("LONG top setups (by avgR)", longGrid);
  printTop("SHORT top setups (by avgR)", shortGrid);

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, "focused-long-short.json");
  await writeFile(
    outPath,
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      minSamples: MIN_SAMPLES,
      longGrid,
      shortGrid
    }, null, 2)}\n`,
    "utf8"
  );
  console.log(`\nWrote ${outPath}`);
  console.log("Done.");
}

main().catch((err) => {
  console.error(`box-edge-focused-study failed: ${err.message}`);
  console.error(err.stack);
  process.exitCode = 1;
});

