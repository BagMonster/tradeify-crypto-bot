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

function ringLabel(ring, perRing) {
  const count = Array.isArray(ring?.lots) ? ring.lots.length : 0;
  const cap = Number.isFinite(perRing) ? perRing : 2;
  if (count >= cap) return `FULL ${cap}/${cap}`;
  if (ring?.armed) return count > 0 ? `ARMED ${count}/${cap}` : "ARMED";
  return count > 0 ? `DISARMED ${count}/${cap}` : "DISARMED";
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
  if (botState?.operator_killed) lines.push("Operator pause: ACTIVE");
  if (botState?.safety_halt) lines.push(`Safety halt: ${botState.halt_reason ?? "Manual review required"}`);
  lines.push("", ...brokerBookLines(accountMonitor, instrument));
  return lines.join("\n");
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
  const perRing = definition.perRing ?? 2;
  const stateByTag = new Map((gridState?.rings ?? []).map((ring) => [ring.tag, ring]));
  const lines = [
    `${definition.instrument} GRID LEVELS`,
    `${definition.instrument} ${price(livePrice)} | MA ${price(ma)}`,
    `Strategy: ${definition.strategyId}`,
    "",
    "BUY RINGS"
  ];
  const buys = definition.rings.filter((ring) => ring.side === "BUY");
  const shorts = definition.rings.filter((ring) => ring.side === "SELL");
  for (const ring of buys) {
    const trigger = ma * (1 + ring.distance);
    const est = livePrice > 0 ? ring.usd / livePrice : 0;
    lines.push(`${ring.tag} ${price(trigger)} · ${money(ring.usd)} · ~${est.toFixed(2)} · ${ringLabel(stateByTag.get(ring.tag), perRing)}`);
  }
  lines.push("", "SHORT RINGS");
  for (const ring of shorts) {
    const trigger = ma * (1 + ring.distance);
    const est = livePrice > 0 ? ring.usd / livePrice : 0;
    lines.push(`${ring.tag} ${price(trigger)} · ${money(ring.usd)} · ~${est.toFixed(2)} · ${ringLabel(stateByTag.get(ring.tag), perRing)}`);
  }
  lines.push("", `Trigger prices use Binance ${definition.marketSymbol}. Actual DXtrade ${definition.instrument} fills may differ.`);
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
