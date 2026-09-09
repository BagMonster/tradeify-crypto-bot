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
import { formatInstrumentTargets } from "./format/instrumentTargets.js";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

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

  function reconcileHash(code, salt) {
    return createHash("sha256").update(`${salt}:ring-reconcile:${definition.instrument}:${code}`).digest("hex");
  }

  function sameHex(left, right) {
    return Boolean(left && right && left.length === right.length && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex")));
  }

  async function freshBrokerNet() {
    await opts.accountMonitor?.pollOnce?.();
    const net = trustedSignedNetFor(opts.accountMonitor?.getSnapshot?.(), definition.instrument);
    if (!Number.isFinite(net)) throw new Error(`fresh DXtrade ${definition.instrument} net is unavailable`);
    return net;
  }

  async function requestReconcile() {
    const state = await stateStore.load();
    const brokerNet = await freshBrokerNet();
    if (Math.abs(brokerNet) > 1e-8) return { code: null, message: `Reconcile refused: DXtrade ${definition.instrument} is not flat (${brokerNet.toFixed(8)}).` };
    const virtualNet = grid.expectedNetUnits(state);
    const openLots = state.rings.reduce((sum, ring) => sum + ring.lots.length, 0);
    if (Math.abs(virtualNet) <= 1e-8 && openLots === 0) return { code: null, message: `${definition.instrument} is already reconciled.` };
    const code = String(randomInt(100000, 1000000));
    const salt = randomBytes(16).toString("hex");
    await opts.database.setResumeChallenge(reconcileHash(code, salt), salt, new Date(Date.now() + 10 * 60 * 1000));
    return { code, message: `AUDITED ${definition.instrument} RECONCILE\nBroker net: 0.00\nVirtual net: ${virtualNet.toFixed(8)}\nOpen lots: ${openLots}\nNo DXtrade order will be placed.\nSend /confirmreconcile ${code} ${definition.instrument.split("/")[0]} within 10 minutes.` };
  }

  async function confirmReconcile(code) {
    const state = await stateStore.load();
    const bot = await opts.database.getState();
    if (!/^\d{6}$/.test(code ?? "") || !bot.resume_code_hash || !bot.resume_code_salt || !bot.resume_code_expires_at) return "No reconcile request is pending. Send /reconcile INSTRUMENT first.";
    if (new Date(bot.resume_code_expires_at).getTime() < Date.now() || !sameHex(reconcileHash(code, bot.resume_code_salt), bot.resume_code_hash)) return "Reconcile code is invalid or expired. Send /reconcile INSTRUMENT again.";
    const brokerNet = await freshBrokerNet();
    if (Math.abs(brokerNet) > 1e-8) return `Reconcile aborted: DXtrade ${definition.instrument} is no longer flat.`;
    const empty = grid.createInitialState();
    const next = grid.normalizeState({ ...empty, version: state.version + 1 });
    await stateStore.save(state.version, next);
    await opts.database.clearResumeChallenge();
    await opts.database.addEvent("WARN", "RING_VIRTUAL_RECONCILE_APPLIED", { instrument: definition.instrument, priorVirtualNet: grid.expectedNetUnits(state), priorLots: state.rings.reduce((sum, ring) => sum + ring.lots.length, 0), brokerNet });
    return `${definition.instrument} virtual inventory cleared and rearmed. No DXtrade order was placed. Global safety/harvest gates remain until every book is verified.`;
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

  async function targetsText() {
    if (!definition) return "Exit targets are only available for ring-grid instruments.";
    const inputs = await ringInputs();
    if (inputs.error) return inputs.error;
    return formatInstrumentTargets({
      definition,
      gridState: await loadLiveState(),
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
    ...createRematchHandlers({
      ...opts,
      gridDefinition: definition,
      instrument: definition?.instrument ?? opts.instrument ?? "SOL/USD",
      grid,
      stateStore
    }),
    requestReconcile,
    confirmReconcile,
    statusText,
    healthText,
    levelsText,
    ringsText,
    targetsText,
    inspectForRerun,
    trustedSignedNetFor: (instrument) => trustedSignedNetFor(opts.accountMonitor?.getSnapshot?.(), instrument)
  });
}
