function positive(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`${name} must be positive`);
  return n;
}

function canonicalTrade(trade, marketSymbol) {
  if (!trade || trade.source !== "binance" || trade.symbol !== marketSymbol) throw new TypeError(`ring instance accepts only Binance ${marketSymbol} trades`);
  const tradeTime = typeof trade.tradeTime === "string" ? trade.tradeTime : "";
  if (!Number.isFinite(Date.parse(tradeTime)) || new Date(tradeTime).toISOString() !== tradeTime) throw new TypeError("trade time must be canonical UTC");
  return Object.freeze({ source: "binance", symbol: marketSymbol, price: positive("trade price", trade.price), tradeTime });
}

function requiredStore(store) {
  for (const method of ["init", "load", "initializeIfMissing", "save"]) if (typeof store?.[method] !== "function") throw new TypeError(`stateStore.${method} is required`);
  return store;
}

// A D-060 instance owns one grid's memory, MA, broker guard, and state row. The
// multi-asset coordinator is the only account-level decision maker above it.
export function createRingGridInstance({ grid, stateStore, maProvider, execution, minimumHoldSeconds = 25, addEvent = async () => {} }) {
  if (!grid || typeof grid.createInitialState !== "function" || typeof grid.entryCandidates !== "function") throw new TypeError("grid must be a ring-grid instance");
  const store = requiredStore(stateStore);
  if (typeof maProvider?.getCurrent !== "function") throw new TypeError("maProvider.getCurrent is required");
  if (typeof execution?.executeIntent !== "function" || typeof execution?.executeProtectiveCut !== "function" || typeof execution?.executeProtectiveFlatten !== "function") throw new TypeError("execution interface is invalid");
  if (!Number.isInteger(minimumHoldSeconds) || minimumHoldSeconds < 25) throw new TypeError("minimumHoldSeconds is invalid");
  if (typeof addEvent !== "function") throw new TypeError("addEvent must be a function");
  const { instrument, marketSymbol, lotStep, perRing, grossExposureCeilingUsd } = grid.definition;
  let previousPrice = null;
  let entryBrake = false;
  let currentState = null;

  async function init() {
    await store.init();
    const prior = await store.load();
    currentState = prior ?? await store.initializeIfMissing(grid.createInitialState());
    return currentState;
  }
  async function load() {
    currentState = (await store.load()) ?? await store.initializeIfMissing(grid.createInitialState());
    return currentState;
  }
  async function setEntryBrake(value) { entryBrake = value === true; }

  async function cut({ fraction, reason, dayKey }) {
    const state = await load();
    const plan = grid.buildProtectiveCutPlan(state, fraction);
    if (plan.quantity < lotStep - 1e-12) return Object.freeze({ status: "BELOW_LOT_STEP" });
    const result = await execution.executeProtectiveCut({ stateVersion: state.version, dayKey, quantity: plan.quantity, side: plan.side, reason, bypassSlippageCap: true });
    if (result.status !== "FILLED") return result;
    const next = grid.applyConfirmedProtectiveCut(state, plan, result);
    await store.save(state.version, next);
    return result;
  }

  async function flatten({ reason, dayKey }) {
    const state = await load();
    const result = await execution.executeProtectiveFlatten({ stateVersion: state.version, dayKey, reason, bypassSlippageCap: true });
    if (result.status === "ALREADY_FLAT") return result;
    if (result.status !== "FILLED") return result;
    const next = grid.resetAfterProtectiveFlatten(state, { fillPrice: result.fillPrice, filledAt: result.filledAt });
    await store.save(state.version, next);
    return result;
  }

  async function process(input) {
    const trade = canonicalTrade(input, marketSymbol);
    const maState = await maProvider.getCurrent();
    const ma = positive(`${instrument} MA`, maState?.ma);
    let state = await load();
    const rearmed = grid.observeRearm(state, { price: trade.price, ma });
    if (rearmed.version !== state.version) state = await store.save(state.version, rearmed);
    while (true) {
      const action = grid.nextExitAction(state, { price: trade.price, ma });
      if (!action) break;
      if (action.type === "SKIP_EXIT") { state = await store.save(state.version, grid.applySkippedExit(state, action)); continue; }
      const lot = state.rings.flatMap((ring) => ring.lots).find((candidate) => candidate.id === action.lotId);
      if (!lot || Date.parse(trade.tradeTime) - Date.parse(lot.openedAt) < minimumHoldSeconds * 1000) break;
      if (execution.isEnabled?.() !== true) break;
      const result = await execution.executeIntent(action);
      if (result.status !== "FILLED") return Object.freeze({ status: "EXIT_PENDING", state, action, result });
      state = await store.save(state.version, grid.applyConfirmedExit(state, action, result));
    }
    if (!entryBrake) {
      for (const candidate of grid.entryCandidates(state, { previousPrice, price: trade.price, ma })) {
        const ring = state.rings.find((item) => item.tag === candidate.ringTag);
        if (!ring || !ring.armed || ring.lots.length >= perRing) continue;
        const proposed = candidate.quantity * trade.price;
        if (grid.grossVirtualExposureUsd(state, trade.price) + proposed > grossExposureCeilingUsd + 1e-8) continue;
        if (execution.isEnabled?.() !== true) continue;
        const intent = Object.freeze({ ...candidate, stateVersion: state.version, lotId: `${candidate.tag}-V${state.version}` });
        const result = await execution.executeIntent(intent);
        if (result.status !== "FILLED") return Object.freeze({ status: "ENTRY_PENDING", state, intent, result });
        state = await store.save(state.version, grid.applyConfirmedEntry(state, intent, result));
      }
    }
    previousPrice = trade.price;
    currentState = state;
    await addEvent("INFO", "D060_RING_INSTANCE_PROCESSED", { instrument, stateVersion: state.version, entryBrake });
    return Object.freeze({ status: entryBrake ? "BRAKED" : "PROCESSED", state, ma });
  }

  return Object.freeze({
    instrument,
    init,
    process,
    setEntryBrake,
    cut,
    flatten,
    getEntryBrake: () => entryBrake,
    getState: () => currentState
  });
}
