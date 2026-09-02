import { createRiskSupervisor, RISK_SUPERVISOR_ACTIONS } from "../risk/riskSupervisor.js";

function requireInstances(instances) {
  if (!Array.isArray(instances) || instances.length === 0) throw new TypeError("instances must be a non-empty array");
  const byInstrument = new Map();
  for (const instance of instances) {
    if (!instance || typeof instance !== "object" || typeof instance.instrument !== "string" || !instance.instrument) throw new TypeError("each instance needs an instrument");
    if (typeof instance.setEntryBrake !== "function" || typeof instance.process !== "function" || typeof instance.cut !== "function" || typeof instance.flatten !== "function") throw new TypeError(`${instance.instrument} lacks the multi-asset runtime interface`);
    if (byInstrument.has(instance.instrument)) throw new Error(`duplicate grid instance: ${instance.instrument}`);
    byInstrument.set(instance.instrument, instance);
  }
  return byInstrument;
}

// Individual per-instrument runtimes own D-059 execution. This coordinator has no
// broker or credential interface; it applies only the D-060 account decision.
export function createMultiAssetGridRuntime({ accountRisk, instances, addEvent = async () => {} }) {
  const supervisor = createRiskSupervisor(accountRisk);
  const byInstrument = requireInstances(instances);
  if (typeof addEvent !== "function") throw new TypeError("addEvent must be a function");
  let state = null;

  async function process({ dayKey, snapshots, trades = {} }) {
    if (!snapshots || typeof snapshots !== "object" || Array.isArray(snapshots)) throw new TypeError("snapshots must be keyed by instrument");
    const values = [];
    for (const [instrument] of byInstrument) {
      const snapshot = snapshots[instrument];
      if (!snapshot || typeof snapshot !== "object") throw new Error(`missing account snapshot for ${instrument}`);
      if (!(instrument in trades)) throw new Error(`missing market trade for ${instrument}`);
      values.push({ instrument, realisedPnlUsd: snapshot.realisedPnlUsd ?? 0, unrealisedPnlUsd: snapshot.unrealisedPnlUsd ?? 0 });
    }
    const verdict = supervisor.evaluate({ instances: values, dayKey, state });
    state = verdict.state;
    const brakes = new Set(verdict.brakes);
    await Promise.all([...byInstrument].map(([instrument, instance]) => instance.setEntryBrake(brakes.has(instrument) || verdict.action === RISK_SUPERVISOR_ACTIONS.HALTED || verdict.action === RISK_SUPERVISOR_ACTIONS.FLATTEN)));
    if (verdict.action === RISK_SUPERVISOR_ACTIONS.FLATTEN) {
      await addEvent("WARN", "D060_ACCOUNT_FULL_FLATTEN", { dayKey, combinedPnlUsd: verdict.combinedPnlUsd, instruments: [...byInstrument.keys()] });
      return Object.freeze({ verdict, results: Object.freeze(await Promise.all([...byInstrument.values()].map((instance) => instance.flatten({ reason: "D-060 account full flatten", dayKey })))) });
    }
    if (verdict.action === RISK_SUPERVISOR_ACTIONS.CUT) {
      await addEvent("WARN", "D060_ACCOUNT_PROPORTIONAL_CUT", { dayKey, combinedPnlUsd: verdict.combinedPnlUsd, allocations: verdict.allocations });
      const allocations = new Map(verdict.allocations.map((entry) => [entry.instrument, entry]));
      return Object.freeze({ verdict, results: Object.freeze(await Promise.all([...byInstrument].map(([instrument, instance]) => {
        const allocation = allocations.get(instrument);
        return allocation ? instance.cut({ fraction: allocation.fraction, reason: "D-060 account proportional cut", dayKey }) : null;
      }))) });
    }
    if (verdict.action === RISK_SUPERVISOR_ACTIONS.BRAKE) await addEvent("INFO", "D060_INSTRUMENT_ENTRY_BRAKE", { dayKey, combinedPnlUsd: verdict.combinedPnlUsd, instruments: verdict.brakes });
    return Object.freeze({ verdict, results: Object.freeze(await Promise.all([...byInstrument].map(([instrument, instance]) => instance.process(trades[instrument])))) });
  }
  return Object.freeze({ process, getState: () => state });
}
