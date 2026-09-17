import { trustedSignedNetFor } from "../account/dxtradeSignedNet.js";

function money(value) {
  if (!Number.isFinite(value)) return "unavailable";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(value);
}

function price(value) {
  if (!Number.isFinite(value)) return "unavailable";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4
  }).format(value);
}

function units(value) {
  if (!Number.isFinite(value)) return "unavailable";
  return value.toFixed(2);
}

function ringLabel(ring, capacity) {
  const count = Array.isArray(ring?.lots) ? ring.lots.length : 0;
  const cap = Number.isInteger(capacity) && capacity > 0 ? capacity : 1;
  if (count >= cap) return `FULL ${cap}/${cap}`;
  if (ring?.armed) return `ARMED ${count}/${cap}`;
  return count > 0 ? `REARM REQUIRED ${count}/${cap}` : `DISARMED ${count}/${cap}`;
}

function capacityForRing(definition, ring, stateRing) {
  const capacity = stateRing?.capacity
    ?? definition.capacityForLevel?.(ring.level)
    ?? definition.perRing
    ?? 1;
  return Number.isInteger(capacity) && capacity > 0 ? capacity : 1;
}

function openLots(gridState) {
  const ringLots = (gridState?.rings ?? []).flatMap((ring) => ring.lots ?? []);
  return [...ringLots, ...(gridState?.adopted ?? [])];
}

function priceRelation(livePrice, ma) {
  if (!(Number.isFinite(livePrice) && livePrice > 0 && Number.isFinite(ma) && ma > 0)) return "MA relation unavailable";
  if (Math.abs(livePrice - ma) < 1e-12) return "AT MA";
  return livePrice > ma ? "ABOVE MA" : "BELOW MA";
}

function tierCapacityText(definition) {
  const innerLevels = Number(definition.innerLevels ?? 0);
  const levels = Number(definition.activeLevelsPerSide ?? 0);
  const innerCapacity = Number(definition.innerPositionsPerRing ?? definition.perRing ?? 1);
  const outerCapacity = Number(definition.outerPositionsPerRing ?? definition.perRing ?? innerCapacity);
  if (innerLevels > 0 && innerLevels < levels && innerCapacity !== outerCapacity) {
    return `Tier capacity: levels 1–${innerLevels} = ${innerCapacity} lot${innerCapacity === 1 ? "" : "s"} | levels ${innerLevels + 1}–${levels} = ${outerCapacity} lots`;
  }
  return `Tier capacity: levels 1–${levels} = ${innerCapacity} lot${innerCapacity === 1 ? "" : "s"}`;
}

export function brokerBookLines(accountMonitor, instrument) {
  const status = accountMonitor?.getSnapshot?.() ?? null;
  const snapshot = status?.snapshot ?? null;
  const failed = snapshot?.positionsReadFailed === true;
  const net = failed ? null : trustedSignedNetFor(status, instrument);
  const book = snapshot?.signedNetByInstrument?.[instrument] ?? null;
  const source = failed
    ? "unavailable (positions read failed)"
    : (snapshot?.positionSource ?? (snapshot ? "metrics" : "no-snapshot"));
  const freshness = status == null
    ? "unavailable"
    : status.healthy === true
      ? "YES"
      : status.fresh === true
        ? "NO (unhealthy)"
        : "NO";
  const age = Number.isFinite(status?.ageMs) && status.ageMs !== Infinity
    ? ` (${Math.round(status.ageMs)}ms)`
    : snapshot == null
      ? " (monitor has not published a snapshot)"
      : "";
  const lines = [
    `DXtrade broker net: ${net == null ? "unavailable" : units(net)}`,
    `DXtrade tickets: ${book?.ticketCount ?? 0}`,
    `DXtrade net source: ${source}`,
    `DXtrade account data fresh: ${freshness}${age}`
  ];
  if (book?.hedged === true) lines.push("DXtrade warning: opposing tickets on this instrument");
  if (snapshot?.overlayError) lines.push(`DXtrade positions overlay: ${snapshot.overlayError}`);
  if (status?.error) lines.push(`DXtrade monitor error: ${status.error}`);
  return lines;
}

export function formatInstrumentStatus({
  definition,
  grid,
  gridState,
  maState,
  environment,
  execution,
  botState,
  accountMonitor,
  supervisorBook = null
}) {
  const instrument = definition.instrument;
  const ringCount = definition.activeLevelsPerSide * 2;
  const openLots = gridState?.rings.reduce((n, ring) => n + ring.lots.length, 0) ?? 0;
  const occupied = gridState?.rings.filter((ring) => ring.lots.length > 0).length ?? 0;
  const armed = gridState?.rings.filter((ring) => ring.armed).length ?? 0;
  const mark = Number(maState?.ma);
  const net = gridState && grid ? grid.expectedNetUnits(gridState) : 0;
  const gross = gridState && grid && Number.isFinite(mark)
    ? grid.grossVirtualExposureUsd(gridState, mark)
    : 0;
  const operating = botState?.operator_killed || botState?.safety_halt ? "PAUSED" : "RUNNING";
  const live = execution?.isEnabled?.() === true;
  const strategyOn = definition.executionAutoExecute !== false;

  const lines = [
    `${instrument} STATUS`,
    `Strategy: ${definition.strategyId}`,
    `Feed: Binance ${definition.marketSymbol}`,
    `Broker: DXtrade ${instrument}`,
    `Mode: ${String(environment?.appMode ?? "?").toUpperCase()} / ${live ? "LIVE" : "ARMED-OR-LOCKED"}`,
    `Auto-execution: ${live ? "ON" : "OFF"}`,
    `Railway execution control: ${environment?.autoExecute ? "ON" : "OFF"}`,
    `Strategy execution control: ${strategyOn ? "ON" : "OFF"}`,
    `Bot: ${operating}`,
    `Geometry: ${definition.activeLevelsPerSide} rings/side, ±${(definition.innermostDistance * 100).toFixed(1)}% .. ±${(definition.outermostDistance * 100).toFixed(1)}% of ${definition.maDays}d MA`,
    `Cap: ${money(definition.grossExposureCeilingUsd ?? definition.capUsd)}`,
    "",
    `200-day MA: ${price(mark)}`,
    `MA completed through: ${maState?.completedThrough ?? "unavailable"}`,
    `Virtual net: ${units(net)}`,
    `Virtual gross exposure @ MA: ${money(gross)} / ${money(definition.grossExposureCeilingUsd ?? definition.capUsd)}`,
    `Open virtual lots: ${openLots}`,
    `Occupied rings: ${occupied}/${ringCount}`,
    `Armed rings: ${armed}/${ringCount}`,
    `State version: ${gridState?.version ?? "not initialized"}`
  ];
  if (supervisorBook) {
    lines.push(
      `Supervisor day P&L: ${money(supervisorBook.dayPnlUsd)}`,
      `Supervisor brake: ${supervisorBook.braked ? "ACTIVE" : "READY"}${supervisorBook.readFailed ? " (book unread)" : ""}`
    );
  }
  if (botState?.operator_killed) {
    lines.push("Operator pause: ACTIVE", `  → release with: /resume ${instrument}`);
  }
  if (botState?.safety_halt) {
    lines.push(`Safety halt: ${botState.halt_reason ?? "Manual review required"}`);
    lines.push(`  → release with: ${haltReleaseHint(botState.halt_reason, instrument)}`);
  }
  lines.push("", ...brokerBookLines(accountMonitor, instrument));
  return lines.join("\n");
}

// Six different things can stop this bot and each has its own release. Reading
// the halt text and remembering which command clears it is exactly the wrong
// thing to ask of someone at 7am, so /status names the command directly.
export function haltReleaseHint(reason, instrument = null) {
  const text = typeof reason === "string" ? reason.toLowerCase() : "";
  const code = typeof instrument === "string" && instrument.includes("/")
    ? instrument.split("/")[0]
    : "<INSTRUMENT>";
  if (text.endsWith("production runtime error; owner review required")) {
    return "/rerun  (needs every book matching first)";
  }
  if (text.includes("does not reconcile to the dxtrade net position")) {
    return `/rematch ${code}  (needs virtual and broker nets to agree first)`;
  }
  if (text.includes("harvest could not confirm every book flat")) {
    return "close any remaining broker positions, then /harvestrecover";
  }
  if (text.includes("foreign position") || text.includes("position metrics")) {
    return "clear the unexpected broker position in DXtrade, then /pausehalt if it is still counting down";
  }
  if (text.includes("virtual") && text.includes("flat")) {
    return `/reconcile ${code}  (broker flat, virtual lots left over)`;
  }
  return `/rerun if it ends "production runtime error", /rematch ${code} for a net mismatch, /reconcile ${code} for leftover virtual lots on a flat broker`;
}

export function formatInstrumentHealth({
  definition,
  environment,
  execution,
  databaseTime,
  maState,
  accountMonitor
}) {
  return [
    `${definition.instrument} HEALTH`,
    "Worker: OK",
    "PostgreSQL: OK",
    `Database time: ${databaseTime ? new Date(databaseTime).toISOString() : "unavailable"}`,
    `Instrument: ${definition.instrument} / Binance ${definition.marketSymbol}`,
    `Strategy: ${definition.strategyId}`,
    `200-day MA: ${maState ? `OK (${maState.completedThrough})` : "unavailable"}`,
    `Auto-execution: ${execution?.isEnabled?.() === true ? "ON" : "OFF"}`,
    `Mode: ${environment?.appMode ?? "?"}`,
    ...brokerBookLines(accountMonitor, definition.instrument)
  ].join("\n");
}

export function formatInstrumentLevels({
  definition,
  gridState,
  price: livePrice,
  ma
}) {
  const live = Number(livePrice);
  const mark = Number(ma);
  const stateByTag = new Map((gridState?.rings ?? []).map((ring) => [ring.tag, ring]));
  const lots = openLots(gridState);
  const sides = [...new Set(lots.map((lot) => lot.side).filter((side) => side === "BUY" || side === "SELL"))];
  const activeSide = sides.length === 0 ? "NONE" : sides.length === 1 ? sides[0] : "MIXED — REVIEW";
  const gross = Number.isFinite(live) && live > 0
    ? lots.reduce((total, lot) => total + (Number(lot.remainingUnits) * live), 0)
    : null;
  const cap = Number(definition.grossExposureCeilingUsd ?? definition.capUsd);
  const remaining = Number.isFinite(gross) && Number.isFinite(cap) ? Math.max(0, cap - gross) : null;
  const oppositeSide = sides.length === 1 ? (activeSide === "BUY" ? "SELL" : "BUY") : null;
  const unitName = definition.orderPrefix || definition.instrument.split("/")[0];
  const lines = [
    `${definition.instrument} GRID LEVELS`,
    `${definition.instrument} ${price(live)} | MA ${price(mark)} | ${priceRelation(live, mark)}`,
    `Strategy: ${definition.strategyId}`,
    `Active side: ${activeSide} | Open lots: ${lots.length}`,
    `Open gross @ price: ${money(gross)} | Capacity remaining: ${money(remaining)} / ${money(cap)}`,
    tierCapacityText(definition),
    "Rows: trigger price · cash/lot · units at trigger · state",
    "",
    "BUY RINGS"
  ];
  const buys = definition.rings.filter((ring) => ring.side === "BUY");
  const shorts = definition.rings.filter((ring) => ring.side === "SELL");
  for (const ring of buys) {
    const trigger = mark * (1 + ring.distance);
    const est = trigger > 0 ? ring.usd / trigger : null;
    const stateRing = stateByTag.get(ring.tag);
    const label = oppositeSide === ring.side
      ? `BLOCKED — ${activeSide} inventory open`
      : ringLabel(stateRing, capacityForRing(definition, ring, stateRing));
    lines.push(`${ring.tag} ${price(trigger)} · ${money(ring.usd)} · ~${units(est)} ${unitName} · ${label}`);
  }
  lines.push("", "SHORT RINGS");
  for (const ring of shorts) {
    const trigger = mark * (1 + ring.distance);
    const est = trigger > 0 ? ring.usd / trigger : null;
    const stateRing = stateByTag.get(ring.tag);
    const label = oppositeSide === ring.side
      ? `BLOCKED — ${activeSide} inventory open`
      : ringLabel(stateRing, capacityForRing(definition, ring, stateRing));
    lines.push(`${ring.tag} ${price(trigger)} · ${money(ring.usd)} · ~${units(est)} ${unitName} · ${label}`);
  }
  lines.push("", `Trigger prices use Binance ${definition.marketSymbol}; units are estimated at each trigger price. Actual DXtrade ${definition.instrument} fills may differ.`);
  return lines.join("\n");
}

export function formatInstrumentRings({
  definition,
  price: livePrice,
  ma
}) {
  const px = Number(livePrice);
  const mark = Number(ma);
  const dist = (mark > 0 && px > 0) ? (px / mark) - 1 : null;
  let zone = "unknown";
  if (Number.isFinite(dist)) {
    if (Math.abs(dist) < definition.innermostDistance) zone = "Dead zone";
    else if (dist < 0) zone = "BUY ring zone";
    else zone = "SHORT ring zone";
  }
  return [
    `${definition.instrument} ${price(px)} | MA ${price(mark)}`,
    `Strategy: ${definition.strategyId}`,
    `Status: ${zone}`,
    Number.isFinite(dist) ? `Distance from MA: ${(dist * 100).toFixed(2)}%` : "Distance from MA: unavailable",
    `Active span: ±${(definition.innermostDistance * 100).toFixed(1)}% .. ±${(definition.outermostDistance * 100).toFixed(1)}%`
  ].join("\n");
}
