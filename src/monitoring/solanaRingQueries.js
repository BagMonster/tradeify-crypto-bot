import { GRID_DEFINITION } from "../strategies/solanaGrid.js";

function positive(name, value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`${name} must be a positive finite number`);
  return n;
}

function fixed8(value) {
  return Number(Number(value).toFixed(8));
}

export function floorSolUnits(units) {
  const n = positive("units", units);
  const step = GRID_DEFINITION.lotStep;
  return fixed8(Math.floor((n + 1e-12) / step) * step);
}

export function buildSolanaRingLevels({ ma }) {
  const movingAverage = positive("ma", ma);
  const buys = [];
  const shorts = [];

  for (let level = 1; level <= GRID_DEFINITION.activeLevelsPerSide; level += 1) {
    const bands = GRID_DEFINITION.deadZoneBands + level;
    const distance = GRID_DEFINITION.band * bands;
    const usd = GRID_DEFINITION.baseUsd * (GRID_DEFINITION.growth ** (level - 1));
    const buyPrice = movingAverage * (1 - distance);
    const shortPrice = movingAverage * (1 + distance);

    buys.push(Object.freeze({
      level,
      tag: `BUY${level}`,
      engineTag: `BUY${level}`,
      side: "BUY",
      distance,
      triggerPrice: buyPrice,
      usd,
      estimatedUnitsAtTrigger: floorSolUnits(usd / buyPrice)
    }));
    shorts.push(Object.freeze({
      level,
      tag: `SHORT${level}`,
      engineTag: `SELL${level}`,
      side: "SHORT",
      distance,
      triggerPrice: shortPrice,
      usd,
      estimatedUnitsAtTrigger: floorSolUnits(usd / shortPrice)
    }));
  }

  return Object.freeze({
    ma: movingAverage,
    buys: Object.freeze(buys),
    shorts: Object.freeze(shorts)
  });
}

function atLevel(price, level) {
  return Math.abs(price - level) <= Math.max(0.005, Math.abs(level) * 1e-8);
}

function distanceView(price, level) {
  const dollars = level - price;
  const pct = (dollars / price) * 100;
  return Object.freeze({ dollars, pct });
}

export function summarizeSolanaRingPosition({ price, ma }) {
  const livePrice = positive("price", price);
  const levels = buildSolanaRingLevels({ ma });
  const buy1 = levels.buys[0];
  const short1 = levels.shorts[0];
  const insideDeadZone = livePrice > buy1.triggerPrice && livePrice < short1.triggerPrice;

  const crossedBuys = levels.buys.filter((ring) => livePrice <= ring.triggerPrice);
  const crossedShorts = levels.shorts.filter((ring) => livePrice >= ring.triggerPrice);
  const deepestBuy = crossedBuys.at(-1) ?? null;
  const deepestShort = crossedShorts.at(-1) ?? null;

  const nextBuy = [...levels.buys]
    .filter((ring) => ring.triggerPrice < livePrice && !atLevel(livePrice, ring.triggerPrice))
    .sort((a, b) => b.triggerPrice - a.triggerPrice)[0] ?? null;
  const nextShort = [...levels.shorts]
    .filter((ring) => ring.triggerPrice > livePrice && !atLevel(livePrice, ring.triggerPrice))
    .sort((a, b) => a.triggerPrice - b.triggerPrice)[0] ?? null;

  let touched = null;
  if (deepestBuy) {
    touched = Object.freeze({ ...deepestBuy, status: atLevel(livePrice, deepestBuy.triggerPrice) ? "TOUCHED" : "THROUGH" });
  } else if (deepestShort) {
    touched = Object.freeze({ ...deepestShort, status: atLevel(livePrice, deepestShort.triggerPrice) ? "TOUCHED" : "THROUGH" });
  }

  const nextBuyDistance = nextBuy ? distanceView(livePrice, nextBuy.triggerPrice) : null;
  const nextShortDistance = nextShort ? distanceView(livePrice, nextShort.triggerPrice) : null;
  let closer = null;
  if (nextBuyDistance && nextShortDistance) {
    closer = Math.abs(nextBuyDistance.dollars) <= Math.abs(nextShortDistance.dollars) ? "BUY" : "SHORT";
  } else if (nextBuyDistance) {
    closer = "BUY";
  } else if (nextShortDistance) {
    closer = "SHORT";
  }

  return Object.freeze({
    price: livePrice,
    ma: levels.ma,
    status: insideDeadZone ? "Dead zone" : (livePrice <= buy1.triggerPrice ? "BUY ring zone" : "SHORT ring zone"),
    insideDeadZone,
    touched,
    nextBuy,
    nextBuyDistance,
    nextShort,
    nextShortDistance,
    closer,
    levels
  });
}
