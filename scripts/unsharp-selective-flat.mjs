#!/usr/bin/env node
/**
 * scripts/unsharp-selective-flat.mjs
 *
 * Unsharp 3-candle entry with corrected accounting + selective hard-flat.
 *
 * Rules:
 * - Risk $300 | Daily floor $750 | maxConcurrent 2
 * - Fixed 3.5% stop (always active)
 * - True break-even stop (cost-adjusted + arming) activates after 4 hours
 * - At 21:45: hard-flat ONLY if current unrealized loss ≤ $25
 * - Max hold 4 days from entry
 * - No new trades 21:15–22:06 UTC
 * - Next-bar fill, gap-through-stop, limit vs market slippage, etc.
 *
 * Research only. No live orders.
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BARS_DIR = path.resolve("artifacts", "research-bars-btcusd");
const OUT_DIR = path.resolve("artifacts", "boxfade-results");

const CONFIG = {
  riskPerTrade: 300,
  maxConcurrent: 2,
  dailyLossFloor: 750,
  stopPct: 0.035,
  beAfterBars: 48,               // 4 hours
  beOffsetPct: 0.0018,           // true break-even covers costs
  maxHoldBars: 48 * 24 * 4,      // 4 days of 5m bars
  selectiveFlatLoss: 25,         // only hard-flat if loss ≤ $25
  commissionPct: 0.0004,
  slippagePct: 0.0005,
  maxNotional: 100_000
};

const TP_PCTS = [0.003, 0.005, 0.0075, 0.01, 0.0125, 0.015, 0.02, 0.025];

const HARD_FLAT_MIN = 21 * 60 + 45;           // 21:45
const NO_NEW_TRADES_FROM = HARD_FLAT_MIN - 30; // 21:15
const TRADE_REOPEN_MIN = 22 * 60 + 6;         // 22:06
const ACCOUNT_DAY_MIN = 22 * 60;              // 22:00 account day

const utcDayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const minutesUtc = (ms) => {
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

function buildBoxes(dailyBars) {
  const byDay = new Map();
  for (const b of dailyBars) {
    byDay.set(utcDayKey(Date.parse(b.openTime)), {
      h: Number(b.high),
      l: Number(b.low)
    });
  }
  const days = [...byDay.keys()].sort();
  const boxes = new Map();
  for (let i = 1; i < days.length; i++) {
    const p = byDay.get(days[i - 1]);
    if (p.h > p.l) boxes.set(days[i], { boxHigh: p.h, boxLow: p.l });
  }
  return boxes;
}

function isUnsharpEntry(bars, i, side, box) {
  const lead = bars[i - 2];
  const conf = bars[i - 1];
  const exec = bars[i];
  if (side === "LONG") {
    return lead.low <= box.boxLow && conf.low >= lead.low && exec.close > box.boxLow;
  }
  return lead.high >= box.boxHigh && conf.high <= lead.high && exec.close < box.boxHigh;
}

function runConfig(bars, boxes, side, tpPct) {
  const cfg = CONFIG;
  const slip = (price, s, isEntry) => {
    if (s === "LONG") return price * (isEntry ? 1 + cfg.slippagePct : 1 - cfg.slippagePct);
    return price * (isEntry ? 1 - cfg.slippagePct : 1 + cfg.slippagePct);
  };

  // Only market exits get slippage
  const MARKET_EXITS = new Set(["stop", "stop-gap", "hard-flat", "be-stop", "max-hold", "end-of-data"]);
  const exitFill = (px, s, reason) =>
    MARKET_EXITS.has(reason) ? slip(px, s, false) : px;

  const budgetDayKey = (ms) =>
    utcDayKey(minutesUtc(ms) >= ACCOUNT_DAY_MIN ? ms + 86_400_000 : ms);

  const open = [];
  const realized = new Map();
  const buckets = {};
  const skips = { noBox: 0, concurrency: 0, floor: 0, notional: 0, badRisk: 0, session: 0 };
  let signals = 0;
  let totalR = 0;
  let trades = 0;
  let wins = 0;

  const closeTrade = (tr, px, ms, reason) => {
    const fill = exitFill(px, tr.side, reason);
    const gross = tr.side === "LONG"
      ? (fill - tr.entryFill) * tr.qty
      : (tr.entryFill - fill) * tr.qty;
    const costs = (Math.abs(tr.entryFill * tr.qty) + Math.abs(fill * tr.qty)) * cfg.commissionPct;
    const net = gross - costs;
    const r = net / cfg.riskPerTrade;

    (buckets[reason] ??= { n: 0, sumR: 0 });
    buckets[reason].n += 1;
    buckets[reason].sumR += r;

    totalR += r;
    trades += 1;
    if (net > 0) wins += 1;

    const key = budgetDayKey(ms); // exit day
    realized.set(key, (realized.get(key) ?? 0) + net);
  };

  for (let i = 2; i < bars.length - 1; i++) {
    const bar = bars[i];
    const m = minutesUtc(bar.ms);

    // ---- manage open positions ----
    for (let k = open.length - 1; k >= 0; k--) {
      const tr = open[k];
      if (i < tr.entryIndex) continue; // not filled yet

      // Gap through stop → fill at open
      const gapped = tr.side === "LONG" ? bar.open <= tr.stop : bar.open >= tr.stop;
      if (gapped) {
        closeTrade(tr, bar.open, bar.ms, "stop-gap");
        open.splice(k, 1);
        continue;
      }

      const stopHit = tr.side === "LONG" ? bar.low <= tr.stop : bar.high >= tr.stop;
      const tpHit = tr.side === "LONG" ? bar.high >= tr.tp : bar.low <= tr.tp;

      // True break-even stop (armed)
      const beReady = (i - tr.entryIndex) >= cfg.beAfterBars;
      const beHit = beReady && tr.beArmed &&
        (tr.side === "LONG" ? bar.low <= tr.bePrice : bar.high >= tr.bePrice);

      // Max hold
      const maxHoldHit = (i - tr.entryIndex) >= cfg.maxHoldBars;

      // Selective hard-flat
      let selectiveFlat = false;
      if (m >= HARD_FLAT_MIN && m < TRADE_REOPEN_MIN) {
        // Approximate current unrealized (using current close, no slip yet)
        const mid = bar.close;
        const unrealized = tr.side === "LONG"
          ? (mid - tr.entryFill) * tr.qty
          : (tr.entryFill - mid) * tr.qty;
        if (unrealized >= -cfg.selectiveFlatLoss) {
          selectiveFlat = true;
        }
      }

      let reason = null;
      let px = null;

      if (stopHit) {
        reason = "stop";
        px = tr.stop;
      } else if (tpHit) {
        reason = "tp";
        px = tr.tp;
      } else if (beHit) {
        reason = "be-stop";
        px = tr.bePrice;
      } else if (maxHoldHit) {
        reason = "max-hold";
        px = bar.open;
      } else if (selectiveFlat) {
        reason = "hard-flat";
        px = bar.open;
      }

      if (reason) {
        closeTrade(tr, px, bar.ms, reason);
        open.splice(k, 1);
        continue;
      }

      // Arm the BE stop after price has traded through it
      if (!tr.beArmed) {
        tr.beArmed = tr.side === "LONG"
          ? bar.high >= tr.bePrice
          : bar.low <= tr.bePrice;
      }
    }

    // ---- entries ----
    if (m >= NO_NEW_TRADES_FROM && m < TRADE_REOPEN_MIN) {
      skips.session += 1;
      continue;
    }

    const box = boxes.get(utcDayKey(bar.ms));
    if (!box) {
      skips.noBox += 1;
      continue;
    }

    if (!isUnsharpEntry(bars, i, side, box)) continue;
    signals += 1;

    if (open.length >= cfg.maxConcurrent) {
      skips.concurrency += 1;
      continue;
    }

    // Real floor: only restricts
    const todayPnl = realized.get(budgetDayKey(bar.ms)) ?? 0;
    if (todayPnl <= -cfg.dailyLossFloor) {
      skips.floor += 1;
      continue;
    }

    // Next-bar fill
    const rawEntry = bars[i + 1].open;
    const entryIndex = i + 1;
    const entryMs = bars[i + 1].ms;
    const entryFill = slip(rawEntry, side, true);

    const stop = side === "LONG"
      ? entryFill * (1 - cfg.stopPct)
      : entryFill * (1 + cfg.stopPct);

    const riskPrice = Math.abs(entryFill - stop);
    if (!(riskPrice > 0)) {
      skips.badRisk += 1;
      continue;
    }

    const qty = cfg.riskPerTrade / riskPrice;
    const notional = qty * entryFill;
    if (notional > cfg.maxNotional) {
      skips.notional += 1;
      continue;
    }

    open.push({
      side,
      entryIndex,
      entryMs,
      entryFill,
      qty,
      stop,
      tp: side === "LONG"
        ? entryFill * (1 + tpPct)
        : entryFill * (1 - tpPct),
      bePrice: side === "LONG"
        ? entryFill * (1 + cfg.beOffsetPct)
        : entryFill * (1 - cfg.beOffsetPct),
      beArmed: false
    });
  }

  // Force close any leftovers
  const last = bars.at(-1);
  for (const tr of [...open]) {
    closeTrade(tr, last.close, last.ms, "end-of-data");
  }

  return {
    side,
    tpPct: Math.round(tpPct * 10000) / 100,
    trades,
    signals,
    totalR,
    avgR: trades ? totalR / trades : 0,
    winRate: trades ? wins / trades : 0,
    netUsd: totalR * cfg.riskPerTrade,
    buckets,
    skips
  };
}

async function main() {
  console.log("Loading BTCUSD bars...");
  const raw5 = JSON.parse(await readFile(path.join(BARS_DIR, "5m.json"), "utf8"));
  const raw1 = JSON.parse(await readFile(path.join(BARS_DIR, "1d.json"), "utf8"));

  const bars = raw5.map((b) => ({
    ms: Date.parse(b.openTime),
    open: Number(b.open),
    high: Number(b.high),
    low: Number(b.low),
    close: Number(b.close)
  }));
  const boxes = buildBoxes(raw1);

  console.log(`5m=${bars.length}  boxes=${boxes.size}`);
  console.log(`Risk=$${CONFIG.riskPerTrade} | Floor=$${CONFIG.dailyLossFloor} | maxConcurrent=${CONFIG.maxConcurrent}`);
  console.log(`Stop=${CONFIG.stopPct * 100}% | BE after ${CONFIG.beAfterBars} bars | Max hold 4 days`);
  console.log(`Selective hard-flat only if loss ≤ $${CONFIG.selectiveFlatLoss}`);
  console.log(`No new trades 21:15–22:06 | Account day @ 22:00`);
  console.log(`TP sweep: ${TP_PCTS.map((p) => (p * 100).toFixed(2) + "%").join(", ")}\n`);

  const results = [];

  for (const side of ["LONG", "SHORT"]) {
    for (const tpPct of TP_PCTS) {
      const r = runConfig(bars, boxes, side, tpPct);
      results.push(r);

      console.log(
        `${r.side}/tp${r.tpPct}%: ` +
        `n=${r.trades} net=$${r.netUsd.toFixed(2)} avgR=${r.avgR.toFixed(3)} ` +
        `win=${(r.winRate * 100).toFixed(1)}% totalR=${r.totalR.toFixed(2)}`
      );

      // Compact exit breakdown
      const parts = Object.entries(r.buckets)
        .sort((a, b) => b[1].n - a[1].n)
        .map(([k, v]) => `${k}:${v.n}(${(v.sumR / v.n).toFixed(2)}R)`)
        .join(" ");
      console.log(`  exits → ${parts}`);
    }
  }

  console.log("\n=== Best by totalR ===");
  for (const r of [...results].sort((a, b) => b.totalR - a.totalR).slice(0, 12)) {
    console.log(
      `${r.side}/tp${r.tpPct}%: totalR=${r.totalR.toFixed(2)} net=$${r.netUsd.toFixed(2)} ` +
      `n=${r.trades} avgR=${r.avgR.toFixed(3)} win=${(r.winRate * 100).toFixed(1)}%`
    );
  }

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, "unsharp-selective-flat.json");
  await writeFile(
    outPath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), config: CONFIG, results }, null, 2)}\n`,
    "utf8"
  );
  console.log(`\nWrote ${outPath}`);
  console.log("Done. No live orders were placed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

