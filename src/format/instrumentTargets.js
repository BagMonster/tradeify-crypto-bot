/**
 * src/format/instrumentTargets.js
 *
 * Renders every open lot's tranche exit targets.
 *
 * Nothing in the bot previously showed these. /status and /rings report where the
 * RING levels sit — the prices at which a new lot opens — but never the price at
 * which an OPEN lot takes profit. Those are different numbers, and without the
 * second one there is no way to tell whether the bot is behaving.
 *
 * Formula, mirrored exactly from src/strategies/ringGrid.js:153-157:
 *
 *   tranche = lot.done + 1
 *   target  = entryPrice + (ma - entryPrice) * (tranche / 4)
 *   BUY  -> target = max(target, entryPrice * (1 + roundTripCostFloor))
 *   SELL -> target = min(target, entryPrice * (1 - roundTripCostFloor))
 *
 * A lot walks toward the moving average in four steps: a quarter of the way, half,
 * three quarters, then the MA itself. The cost floor means a tranche can never close
 * below its round-trip cost, which is why every tranche exit is profitable.
 *
 * Direction matters and is the thing most easily misread: a SHORT lot sits ABOVE the
 * MA and profits when price FALLS back toward it. Watching price rise on a short is
 * watching it move away from profit.
 */

const TRANCHES = [1, 2, 3, 4];

function money(value, dp) {
  if (!Number.isFinite(value)) return "n/a";
  return `$${value.toFixed(dp)}`;
}

function decimalsFor(price) {
  if (!Number.isFinite(price) || price <= 0) return 4;
  if (price >= 100) return 2;
  if (price >= 1) return 4;
  if (price >= 0.01) return 5;
  return 8;
}

export function trancheTarget({ entryPrice, ma, side, tranche, roundTripCostFloor }) {
  const raw = entryPrice + ((ma - entryPrice) * (tranche / 4));
  return side === "BUY"
    ? Math.max(raw, entryPrice * (1 + roundTripCostFloor))
    : Math.min(raw, entryPrice * (1 - roundTripCostFloor));
}

function trancheSizing(definition) {
  const weights = Array.isArray(definition?.trancheWeights) && definition.trancheWeights.length === 4
    ? definition.trancheWeights
    : (Array.isArray(definition?.tranches?.weights) && definition.tranches.weights.length === 4
      ? definition.tranches.weights
      : [1, 2, 3, 4]);
  const sum = Number(
    definition?.trancheWeightSum
    ?? definition?.trancheDenominator
    ?? definition?.tranches?.denominator
    ?? 10
  );
  const step = Number(definition?.lotStep ?? definition?.sizing?.lotStep ?? 0.01);
  return { weights, sum, step };
}

export function lotTargets({ lot, ma, definition }) {
  const floor = definition.roundTripCostFloor;
  const { weights, sum, step } = trancheSizing(definition);
  const done = Number(lot.done ?? 0);

  return TRANCHES.map((tranche) => {
    const target = trancheTarget({ entryPrice: lot.entryPrice, ma, side: lot.side, tranche, roundTripCostFloor: floor });
    let units;
    if (tranche === 4) {
      units = Number(lot.remainingUnits);
    } else if (Number.isFinite(sum) && sum > 0 && Number.isFinite(step) && step > 0) {
      units = Math.min(
        Number(lot.remainingUnits),
        Math.floor(((Number(lot.originalUnits) * (weights[tranche - 1] / sum)) + 1e-12) / step) * step
      );
    } else {
      units = Number(lot.remainingUnits);
    }
    if (!Number.isFinite(units) || units < 0) units = 0;
    const gainPerUnit = lot.side === "BUY" ? target - lot.entryPrice : lot.entryPrice - target;
    return Object.freeze({
      tranche,
      target,
      units: Number(units.toFixed(8)),
      gainPerUnit,
      estimatedUsd: gainPerUnit * units,
      status: tranche <= done ? "DONE" : (tranche === done + 1 ? "NEXT" : "pending")
    });
  });
}

export function formatInstrumentTargets({ definition, gridState, price, ma }) {
  const dp = decimalsFor(price ?? ma);
  const head = [
    `${definition.instrument} EXIT TARGETS`,
    `Price ${money(price, dp)}   200-day MA ${money(ma, dp)}`
  ];

  const lots = [];
  for (const ring of gridState?.rings ?? []) {
    for (const lot of ring.lots ?? []) {
      if (!(lot.remainingUnits > 0)) continue;
      lots.push({ ring, lot });
    }
  }

  if (lots.length === 0) {
    head.push("", "No open lots. Nothing to take profit on.");
    head.push(`Rings arm between ±${(definition.band * (definition.deadZoneBands + 1) * 100).toFixed(1)}%` +
      ` and ±${(definition.band * (definition.deadZoneBands + definition.activeLevelsPerSide) * 100).toFixed(1)}% of the MA.`);
    return head.join("\n");
  }

  lots.sort((a, b) => (a.ring.tag < b.ring.tag ? -1 : a.ring.tag > b.ring.tag ? 1 : 0));

  for (const { ring, lot } of lots) {
    const rows = lotTargets({ lot, ma, definition });
    const next = rows.find((row) => row.status === "NEXT") ?? null;
    const direction = lot.side === "BUY" ? "LONG" : "SHORT";
    const moves = lot.side === "BUY" ? "rises" : "falls";

    head.push("");
    head.push(`${ring.tag}  ${lot.id}  ${direction}`);
    head.push(`  entry ${money(lot.entryPrice, dp)}   holding ${lot.remainingUnits} of ${lot.originalUnits}   tranches done ${lot.done}/4`);

    if (next) {
      const distance = lot.side === "BUY" ? next.target - price : price - next.target;
      const pct = Number.isFinite(price) && price > 0 ? (distance / price) * 100 : NaN;
      head.push(`  NEXT EXIT: tranche ${next.tranche} closes ${next.units} when price ${moves} to ${money(next.target, dp)}` +
        (Number.isFinite(pct) ? `  (${pct >= 0 ? "" : "+"}${Math.abs(pct).toFixed(2)}% away)` : ""));
    } else {
      head.push("  all four tranches done; awaiting final close");
    }

    for (const row of rows) {
      const mark = row.status === "DONE" ? "x" : row.status === "NEXT" ? ">" : " ";
      head.push(`   ${mark} T${row.tranche}  ${money(row.target, dp)}   closes ${row.units}   ~${money(row.estimatedUsd, 2)}`);
    }
  }

  head.push("");
  head.push(lots[0].lot.side === "BUY"
    ? "Long lots sit BELOW the MA and pay when price recovers up toward it."
    : "Short lots sit ABOVE the MA and pay when price falls back toward it.");
  head.push("Targets move as the MA moves. A tranche never closes below its round-trip cost.");
  return head.join("\n");
}
