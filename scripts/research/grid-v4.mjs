#!/usr/bin/env node
/**
 * scripts/grid-btc.mjs
 *
 * BTC progressive reference-resetting grid — the frozen $250/$550/$1,250
 * specification, with Tradeify account rules enforced.
 *
 * Research only. Reads files, writes files. No network, no database, no
 * secrets, no orders placed. Never imported by index.mjs.
 * Governing document: claude/grid-strategy-spec-2026-08-19.md
 *
 * ---------------------------------------------------------------------
 * USAGE
 *
 *   node scripts/grid-btc.mjs                 full window + 89-start sweep
 *   node scripts/grid-btc.mjs --trades        also print every trade
 *   node scripts/grid-btc.mjs --csv           write the trade log to CSV
 *   node scripts/grid-btc.mjs --sweep-only    skip the detailed run
 *   node scripts/grid-btc.mjs --scale 1.2     multiply the whole ladder
 *   node scripts/grid-btc.mjs --financing 0   turn off overnight financing
 *
 * Expects artifacts/research-bars-btcusd/5m.json — the dukascopy BTCUSD
 * 5-minute bars already in your repo.
 *
 * ---------------------------------------------------------------------
 * HOW IT WORKS, in one paragraph
 *
 * A reference price is recorded at the start. Every bar, the % change from
 * that reference is computed. If price has fallen far enough, a BUY level
 * fires; if it has risen far enough, a SELL level fires. After ANY fill the
 * reference resets to the fill price, so the levels are cumulative rather
 * than absolute — Buy 2 needs another 9% below wherever Buy 1 filled, not
 * 9% below the original price. Three consecutive trades per side maximum;
 * a trade on the opposite side resets the other side's counter.
 *
 * Profit comes from the leftover coin: the same dollars buy more units low
 * and require fewer units to sell high, so a completed cycle leaves you
 * holding units you never had to sell.
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/* ==================================================================== */
/*  ▼▼▼  TWEAK HERE  ▼▼▼                                                */
/* ==================================================================== */

const CONFIG = {
  startingEquity: 50_000,

  // FROZEN LADDER. Percentages are measured from the CURRENT reference.
  buyLevels: [
    { movePct: 0.0400, usd: 250 },
    { movePct: 0.0900, usd: 550 },
    { movePct: 0.1000, usd: 1_250 }
  ],
  sellLevels: [
    { movePct: 0.0375, usd: 250 },
    { movePct: 0.0750, usd: 550 },
    { movePct: 0.1000, usd: 1_250 }
  ],

  maxConsecutive: 3,      // per side, before that side stops
  twoSided: true,         // false = spot-style, can only sell what you own

  commissionPct: 0.0004,  // 0.04% per side
  slippagePct: 0.0005,    // 0.05% per fill
  overnightPct: 0.00033,  // 0.033%/night — UNVERIFIED, see spec §7.2

  // Account rules (D-010). These are enforced, not advisory.
  dailyLossLimit: 1_500,  // on equity INCLUDING unrealised
  maxLossFloor: 47_000,   // $50,000 - $3,000
  maxNotional: 100_000,   // 2x leverage

  // Evaluate bar highs and lows, approximating the live ~20s poll.
  // false = bar closes only (fewer trades, more conservative).
  useIntrabar: true,

  // NEW — model corrections under test
  ratchetDay: false,     // true = day baseline is equity at 22:00 roll incl. unrealised
  trailingFloor: false   // true = 6% end-of-trade trailing floor instead of static $47,000
};

/* ==================================================================== */
/*  ▲▲▲  END TWEAK ZONE  ▲▲▲                                            */
/* ==================================================================== */

const BARS_FILE = path.resolve("artifacts", "research-bars-btcusd", "5m.json");
const OUT_DIR = path.resolve("artifacts", "grid-results");
const ACCOUNT_DAY_MIN = 22 * 60;   // 22:00 UTC

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : dflt;
};

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const minsUtc = (ms) => {
  const d = new Date(ms);
  return (d.getUTCHours() * 60) + d.getUTCMinutes();
};
/** The Tradeify account day rolls at 22:00 UTC, not midnight. */
const accountDay = (ms) =>
  utcDay(minsUtc(ms) >= ACCOUNT_DAY_MIN ? ms + 86_400_000 : ms);

const money = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US",
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ------------------------------------------------------------------ */
/* The simulation                                                      */
/* ------------------------------------------------------------------ */

function simulate(bars, cfg, keepTrades = false) {
  const scale = value("scale", 1);
  const financingOn = value("financing", 1) !== 0;

  const buy = cfg.buyLevels.map((l) => ({ ...l, usd: l.usd * scale }));
  const sell = cfg.sellLevels.map((l) => ({ ...l, usd: l.usd * scale }));

  const slip = (price, isBuy) =>
    price * (isBuy ? 1 + cfg.slippagePct : 1 - cfg.slippagePct);

  let reference = bars[0].close;
  let units = 0;            // signed: >0 long, <0 short
  let avgCost = 0;
  let realised = 0;
  let commission = 0;
  let financing = 0;
  let nights = 0;

  let buyCount = 0, buyPtr = 0, sellCount = 0, sellPtr = 0;
  let day = accountDay(bars[0].ms), dayStartRealised = 0, halted = false;

  const trades = [];
  let tradeCount = 0, breaches = 0, worstDay = 0, peakNotional = 0;
  let dayStartEquity = cfg.startingEquity;   // equity at the 22:00 UTC roll, incl. unrealised
  let peakClosedBal = cfg.startingEquity;    // highest CLOSED-trade balance (for the trailing floor)
  let minFloorMargin = Infinity;             // closest approach to the ratcheting floor
  let barsLong = 0, barsShort = 0, barsFlat = 0, barsBoth = 0;   // position-state census
  let peakEquity = cfg.startingEquity, maxEqDD = 0;   // peak-to-trough EQUITY drawdown (incl. unrealised)
  let firstBreach = null, mllTouched = null, skippedNotional = 0;

  const fill = (price, usd, isBuy, ms, tag) => {
    const px = slip(price, isBuy);
    const qty = usd / px;
    const signed = isBuy ? qty : -qty;
    const fee = usd * cfg.commissionPct;
    commission += fee;
    realised -= fee;

    let closedPnl = 0;
    if (units === 0 || Math.sign(units) === Math.sign(signed)) {
      avgCost = ((Math.abs(units) * avgCost) + (qty * px)) / (Math.abs(units) + qty);
      units += signed;
    } else {
      const closing = Math.min(Math.abs(signed), Math.abs(units));
      closedPnl = units > 0 ? (px - avgCost) * closing : (avgCost - px) * closing;
      realised += closedPnl;
      const leftover = Math.abs(signed) - closing;
      units += signed;
      if (leftover > 1e-12) avgCost = px;
      else if (Math.abs(units) < 1e-12) { units = 0; avgCost = 0; }
    }

    tradeCount += 1;
    if (cfg.startingEquity + realised > peakClosedBal) peakClosedBal = cfg.startingEquity + realised;
    reference = px;
    if (keepTrades) {
      trades.push({
        time: new Date(ms).toISOString(), tag,
        side: isBuy ? "BUY" : "SELL", price: px, usd,
        qty: isBuy ? qty : -qty, closedPnl,
        unitsAfter: units, avgCostAfter: avgCost, realisedAfter: realised
      });
    }
  };

  for (let i = 1; i < bars.length; i += 1) {
    const bar = bars[i];
    const key = accountDay(bar.ms);

    if (key !== day) {
      day = key;
      dayStartRealised = realised;
      dayStartEquity = cfg.startingEquity + realised + (units * (bars[i - 1].close - avgCost));
      halted = false;
      if (units !== 0 && financingOn) {
        nights += 1;
        financing += Math.abs(units) * bar.close * cfg.overnightPct;
      }
    }

    // ---- account rules, on equity INCLUDING unrealised ----
    if (units > 1e-12) barsLong += 1; else if (units < -1e-12) barsShort += 1; else barsFlat += 1;
    const unrealised = units * (bar.close - avgCost);
    const equity = cfg.startingEquity + realised + unrealised;
    const dayDelta = cfg.ratchetDay
      ? (equity - dayStartEquity)
      : ((realised - dayStartRealised) + unrealised);
    const trailFloor = Math.min(cfg.startingEquity, peakClosedBal - 3_000);
    const floorNow = cfg.trailingFloor ? trailFloor : cfg.maxLossFloor;
    if (equity - floorNow < minFloorMargin) minFloorMargin = equity - floorNow;
    if (equity > peakEquity) peakEquity = equity;
    if (peakEquity - equity > maxEqDD) maxEqDD = peakEquity - equity;
    if (dayDelta < worstDay) worstDay = dayDelta;
    if (equity <= floorNow && !mllTouched) {
      mllTouched = { time: new Date(bar.ms).toISOString(), equity };
    }

    if (!halted && dayDelta <= -cfg.dailyLossLimit) {
      if (units !== 0) fill(bar.close, Math.abs(units) * bar.close, units < 0, bar.ms, "BREACH-FLAT");
      halted = true;
      breaches += 1;
      if (!firstBreach) {
        firstBreach = { day: key, time: new Date(bar.ms).toISOString(), equity };
      }
      buyCount = 0; buyPtr = 0; sellCount = 0; sellPtr = 0;
      reference = bar.close;
      continue;
    }
    if (halted) continue;

    const notional = Math.abs(units) * bar.close;
    if (notional > peakNotional) peakNotional = notional;

    const points = cfg.useIntrabar ? [bar.low, bar.high] : [bar.close];
    for (const px of points) {
      const change = (px - reference) / reference;

      // BUY side — price fell far enough
      if (change < 0 && buyCount < cfg.maxConsecutive) {
        const level = buy[buyPtr];
        if (level && -change >= level.movePct) {
          if (Math.abs(units) * px + level.usd > cfg.maxNotional) skippedNotional += 1;
          else {
            fill(px, level.usd, true, bar.ms, `BUY${buyPtr + 1}`);
            buyCount += 1; buyPtr += 1; sellCount = 0; sellPtr = 0;
          }
        }
      }

      // SELL side — price rose far enough
      if (change > 0 && sellCount < cfg.maxConsecutive) {
        const level = sell[sellPtr];
        if (level && change >= level.movePct) {
          const openingShort = units <= 0;
          if (openingShort && !cfg.twoSided) { /* spot: nothing to sell */ }
          else if (Math.abs(units) * px + level.usd > cfg.maxNotional) skippedNotional += 1;
          else {
            fill(px, level.usd, false, bar.ms, `SELL${sellPtr + 1}`);
            sellCount += 1; sellPtr += 1; buyCount = 0; buyPtr = 0;
          }
        }
      }
    }
  }

  const lastPrice = bars.at(-1).close;
  const unrealised = units * (lastPrice - avgCost);
  return {
    tradeCount, realised, unrealised, total: realised + unrealised,
    commission, financing, nights,
    unitsHeld: units, avgCost, lastPrice,
    inventoryValue: Math.abs(units) * lastPrice,
    breaches, firstBreach, mllTouched, worstDay, peakNotional, skippedNotional, minFloorMargin,
    barsLong, barsShort, barsFlat, barsBoth, maxEqDD,
    finalEquity: cfg.startingEquity + realised + unrealised,
    days: Math.round(bars.length / 288),
    trades
  };
}

/* ------------------------------------------------------------------ */

async function main() {
  let raw;
  try {
    raw = JSON.parse(await readFile(BARS_FILE, "utf8"));
  } catch {
    console.error(`Could not read ${BARS_FILE}`);
    console.error("Expected the dukascopy BTCUSD 5-minute bars at that path.");
    process.exitCode = 1;
    return;
  }

  const bars = raw.map((b) => ({
    ms: Date.parse(b.openTime),
    high: Number(b.high), low: Number(b.low), close: Number(b.close)
  }));
  for (let i = 1; i < bars.length; i += 1) {
    if (bars[i].ms <= bars[i - 1].ms) throw new Error(`bars out of order at ${i}`);
  }

  const scale = value("scale", 1);
  const ladder = CONFIG.buyLevels.map((l) => "$" + (l.usd * scale).toLocaleString()).join(" / ");

  console.log("=".repeat(78));
  console.log("BTC PROGRESSIVE GRID — frozen specification");
  console.log("=".repeat(78));
  console.log(`data      ${raw[0].source} ${raw[0].symbol}, ${bars.length} 5m bars`);
  console.log(`          ${new Date(bars[0].ms).toISOString().slice(0, 10)} to ${new Date(bars.at(-1).ms).toISOString().slice(0, 10)}`);
  console.log(`ladder    ${ladder}${scale !== 1 ? `  (scale x${scale})` : ""}`);
  console.log(`buys at   -4.00% / -9.00% / -10.00%   from the CURRENT reference`);
  console.log(`sells at  +3.75% / +7.50% / +10.00%   from the CURRENT reference`);
  console.log(`mode      ${CONFIG.twoSided ? "two-sided (can open shorts)" : "long only (spot-style)"}, max ${CONFIG.maxConsecutive} consecutive per side`);
  console.log(`account   $${CONFIG.startingEquity.toLocaleString()} | daily limit $${CONFIG.dailyLossLimit} on equity incl. unrealised | floor $${CONFIG.maxLossFloor.toLocaleString()}`);

  if (!flag("sweep-only")) {
    const r = simulate(bars, CONFIG, true);
    console.log("\n" + "-".repeat(78));
    console.log(`FULL WINDOW — ${r.days} days`);
    console.log("-".repeat(78));
    console.log(`  trades                 ${r.tradeCount}`);
    console.log(`  realised P&L           ${money(r.realised)}`);
    console.log(`  unrealised P&L         ${money(r.unrealised)}`);
    console.log(`  ${"─".repeat(40)}`);
    console.log(`  TOTAL                  ${money(r.total)}`);
    console.log(`  final equity           ${money(r.finalEquity)}`);
    console.log(`\n  commission paid        ${money(r.commission)}`);
    console.log(`  overnight financing    ${money(r.financing)} over ${r.nights} nights  [rate UNVERIFIED]`);
    console.log(`  total after financing  ${money(r.total - r.financing)}`);
    console.log(`  inventory still held   ${r.unitsHeld.toFixed(6)} BTC, worth ${money(r.inventoryValue)}`);

    console.log(`\n  ACCOUNT RULES`);
    console.log(`  peak position          ${money(r.peakNotional)}  (max allowed $${CONFIG.maxNotional.toLocaleString()})`);
    console.log(`  worst single day       ${money(r.worstDay)}  (limit -$${CONFIG.dailyLossLimit}, margin ${money(CONFIG.dailyLossLimit + r.worstDay)})`);
    console.log(`  daily-limit breaches   ${r.breaches}${r.breaches ? `   FIRST: ${r.firstBreach.time}` : ""}`);
    console.log(`  max-loss floor         ${r.mllTouched ? `TOUCHED at ${r.mllTouched.time}` : "never touched"}`);
    console.log(`  levels skipped (size)  ${r.skippedNotional}`);

    if (flag("trades")) {
      console.log(`\n  TRADE LOG`);
      console.log(`  ${"time".padEnd(21)} ${"lvl".padEnd(6)} ${"side".padEnd(5)} ${"price".padStart(11)} ${"usd".padStart(8)} ${"closed P&L".padStart(11)} ${"units after".padStart(12)}`);
      for (const t of r.trades) {
        console.log(`  ${t.time.slice(0, 19).replace("T", " ").padEnd(21)} ${t.tag.padEnd(6)} ${t.side.padEnd(5)} ${t.price.toFixed(2).padStart(11)} ${("$" + t.usd).padStart(8)} ${(t.closedPnl ? money(t.closedPnl) : "-").padStart(11)} ${t.unitsAfter.toFixed(6).padStart(12)}`);
      }
    }

    if (flag("csv")) {
      await mkdir(OUT_DIR, { recursive: true });
      const csv = ["time,level,side,price,usd,qty,closedPnl,unitsAfter,avgCostAfter,realisedAfter"]
        .concat(r.trades.map((t) => [t.time, t.tag, t.side, t.price.toFixed(2), t.usd,
          t.qty.toFixed(8), t.closedPnl.toFixed(2), t.unitsAfter.toFixed(8),
          t.avgCostAfter.toFixed(2), t.realisedAfter.toFixed(2)].join(","))).join("\n");
      const p = path.join(OUT_DIR, "grid-btc-trades.csv");
      await writeFile(p, csv + "\n", "utf8");
      console.log(`\n  Wrote ${p}`);
    }
  }

  /* ---- start-date sweep ---- */
  console.log("\n" + "-".repeat(78));
  console.log("START-DATE SWEEP — a fresh start every ~5 days, each run at least 104 days");
  console.log("-".repeat(78));
  const runs = [];
  for (let off = 0; off + 30_000 <= bars.length; off += 1_440) {
    runs.push({ start: new Date(bars[off].ms).toISOString().slice(0, 10), ...simulate(bars.slice(off), CONFIG) });
  }
  const totals = runs.map((r) => r.total).sort((a, b) => a - b);
  const worstDays = runs.map((r) => r.worstDay).sort((a, b) => a - b);
  const mean = totals.reduce((s, x) => s + x, 0) / totals.length;
  const profitable = runs.filter((r) => r.total > 0).length;
  const breached = runs.filter((r) => r.breaches > 0).length;

  console.log(`  runs                   ${runs.length}`);
  console.log(`  profitable             ${profitable}/${runs.length}  (${(100 * profitable / runs.length).toFixed(0)}%)`);
  console.log(`  breached the limit     ${breached}/${runs.length}  (${(100 * breached / runs.length).toFixed(0)}%)`);
  console.log(`  mean total             ${money(mean)}`);
  console.log(`  median                 ${money(totals[Math.floor(totals.length / 2)])}`);
  console.log(`  worst run              ${money(totals[0])}`);
  console.log(`  best run               ${money(totals.at(-1))}`);
  console.log(`  deepest single day     ${money(worstDays[0])}  (margin ${money(CONFIG.dailyLossLimit + worstDays[0])})`);
  console.log(`  avg trades per run     ${(runs.reduce((s, r) => s + r.tradeCount, 0) / runs.length).toFixed(0)}`);
  console.log(`  avg run length         ${(runs.reduce((s, r) => s + r.days, 0) / runs.length).toFixed(0)} days`);

  const losers = runs.filter((r) => r.total <= 0);
  if (losers.length) {
    console.log(`\n  LOSING START DATES:`);
    for (const l of losers.slice(0, 12)) console.log(`    ${l.start}  ${money(l.total)}  worstDay ${money(l.worstDay)}  breaches ${l.breaches}`);
  }
  const breachRuns = runs.filter((r) => r.breaches > 0);
  if (breachRuns.length) {
    console.log(`\n  BREACHING START DATES:`);
    for (const b of breachRuns.slice(0, 12)) console.log(`    ${b.start}  first breach ${b.firstBreach.time.slice(0, 10)}  total ${money(b.total)}`);
  }

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, "grid-btc.json");
  await writeFile(outPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(), config: CONFIG, scale,
    sweep: { runs: runs.length, profitable, breached, mean,
      median: totals[Math.floor(totals.length / 2)], worst: totals[0], best: totals.at(-1),
      deepestDay: worstDays[0] },
    runs: runs.map(({ trades, ...rest }) => rest)
  }, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${outPath}`);
  console.log("Research only. No live orders placed. Both execution locks untouched.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
