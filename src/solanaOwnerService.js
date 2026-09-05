import { createSolanaTradeifyService } from "./solanaTradeifyService.js";
import { createRematchHandlers } from "./state/solanaRematch.js";
import { createRingGrid } from "./strategies/ringGrid.js";
import { netsMatch, trustedSignedNetFor } from "./account/dxtradeSignedNet.js";
import {
  brokerBookLines,
  formatInstrumentStatus,
  formatInstrumentHealth,
  formatInstrumentLevels,
  formatInstrumentRings
} from "./monitoring/instrumentOwnerText.js";

/** @deprecated use brokerBookLines(accountMonitor, instrument) */
export function brokerSnapshotLines(accountMonitor, instrument = "SOL/USD") {
  return brokerBookLines(accountMonitor, instrument);
}

export function createSolanaOwnerService(opts) {
  const tradeify = createSolanaTradeifyService(opts);
  const definition = opts.gridDefinition ?? null;
  const grid = definition ? createRingGrid(definition) : null;
  const stateStore = grid && typeof opts.persistence?.createStateStore === "function"
    ? opts.persistence.createStateStore(grid)
    : opts.persistence?.state ?? null;

  async function refreshBrokerSnapshot() {
    if (typeof opts.accountMonitor?.pollOnce === "function") {
      try {
        await opts.accountMonitor.pollOnce();
      } catch {
        // /status still prints the last known monitor state
      }
    }
  }

  async function loadLiveState() {
    if (!stateStore || typeof stateStore.load !== "function") return null;
    try {
      return await stateStore.load();
    } catch {
      return null;
    }
  }

  function supervisorBook() {
    const instrument = definition?.instrument ?? opts.instrument;
    const snapshot = opts.riskSupervisor?.getSnapshot?.();
    if (!snapshot || !instrument) return null;
    return snapshot.perInstrument?.find((row) => row.instrument === instrument) ?? null;
  }

  async function statusText() {
    await refreshBrokerSnapshot();
    if (!definition || !grid) return tradeify.statusText();
    const [botState, gridState, maState] = await Promise.all([
      opts.database.getState(),
      loadLiveState(),
      opts.maProvider.getCurrent()
    ]);
    return formatInstrumentStatus({
      definition,
      grid,
      gridState,
      maState,
      environment: opts.environment,
      execution: opts.execution,
      botState,
      accountMonitor: opts.accountMonitor,
      supervisorBook: supervisorBook()
    });
  }

  async function healthText() {
    await refreshBrokerSnapshot();
    if (!definition) return tradeify.healthText();
    const [databaseTime, maState] = await Promise.all([
      opts.database.ping(),
      opts.maProvider.getCurrent()
    ]);
    return formatInstrumentHealth({
      definition,
      environment: opts.environment,
      execution: opts.execution,
      databaseTime,
      maState,
      accountMonitor: opts.accountMonitor
    });
  }

  async function ringInputs() {
    const market = opts.getLiveMarketSnapshot?.() ?? null;
    if (!market || !Number.isFinite(Number(market.price)) || Number(market.price) <= 0) {
      return { error: `${definition?.instrument ?? "instrument"} ring data unavailable: live Binance price has not been received yet.` };
    }
    if (market.stale === true) {
      return { error: `${definition?.instrument ?? "instrument"} ring data unavailable: the Binance feed is stale. No level was guessed.` };
    }
    const maState = await opts.maProvider.getCurrent();
    if (!maState || !Number.isFinite(Number(maState.ma)) || Number(maState.ma) <= 0) {
      return { error: `${definition?.instrument ?? "instrument"} ring data unavailable: the current completed-day 200-day MA is unavailable.` };
    }
    return { price: Number(market.price), ma: Number(maState.ma) };
  }

  async function levelsText() {
    if (!definition) return tradeify.levelsText();
    const inputs = await ringInputs();
    if (inputs.error) return inputs.error;
    return formatInstrumentLevels({
      definition,
      gridState: await loadLiveState(),
      price: inputs.price,
      ma: inputs.ma
    });
  }

  async function ringsText() {
    if (!definition) return tradeify.ringsText();
    const inputs = await ringInputs();
    if (inputs.error) return inputs.error;
    return formatInstrumentRings({
      definition,
      price: inputs.price,
      ma: inputs.ma
    });
  }

  async function inspectForRerun() {
    await refreshBrokerSnapshot();
    const instrument = definition?.instrument ?? opts.instrument;
    const state = await loadLiveState();
    const accountStatus = opts.accountMonitor?.getSnapshot?.() ?? null;
    const brokerNet = trustedSignedNetFor(accountStatus, instrument);
    if (!state || !grid) {
      return Object.freeze({
        instrument,
        ok: false,
        match: false,
        virtualNet: null,
        brokerNet,
        openLots: 0,
        error: "grid state missing"
      });
    }
    const virtualNet = grid.expectedNetUnits(state);
    const openLots = state.rings.reduce((n, ring) => n + (Array.isArray(ring.lots) ? ring.lots.length : 0), 0);
    const ok = Number.isFinite(brokerNet);
    return Object.freeze({
      instrument,
      ok,
      match: ok && netsMatch(virtualNet, brokerNet),
      virtualNet,
      brokerNet,
      openLots,
      error: ok ? null : "broker net unavailable"
    });
  }

  return Object.freeze({
    ...tradeify,
    ...createRematchHandlers(opts),
    statusText,
    healthText,
    levelsText,
    ringsText,
    inspectForRerun,
    trustedSignedNetFor: (instrument) => trustedSignedNetFor(opts.accountMonitor?.getSnapshot?.(), instrument)
  });
}
