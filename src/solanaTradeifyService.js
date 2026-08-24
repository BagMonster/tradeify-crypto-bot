import { calculateAccountFloors } from "./risk/accountRules.js";
import { createTradeifyService } from "./tradeifyService.js";
import { expectedNetUnits, grossVirtualExposureUsd } from "./strategies/solanaGrid.js";

function money(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(value);
}

function price(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
}

export function createSolanaTradeifyService({ database, account, strategy, environment, dxtradeClient, persistence, maProvider, execution, canary = null }) {
  const base = createTradeifyService({ database, account, strategy, environment, dxtradeClient });

  async function statusText() {
    const [botState, gridState, maState] = await Promise.all([
      database.getState(),
      persistence.state.load(),
      maProvider.getCurrent()
    ]);
    const floors = calculateAccountFloors({
      startingBalance: account.startingBalance,
      maxLossOffset: account.maxLossOffset,
      peakClosedBalance: Math.max(account.startingBalance, botState.high_water),
      payoutTaken: botState.payout_taken,
      previousDayClosingBalance: botState.prev_day_close,
      dailyLossLimit: account.dailyLossLimit
    });
    const openLots = gridState?.rings.reduce((n, ring) => n + ring.lots.length, 0) ?? 0;
    const occupiedRings = gridState?.rings.filter((ring) => ring.lots.length > 0).length ?? 0;
    const armedRings = gridState?.rings.filter((ring) => ring.armed).length ?? 0;
    const mark = maState.ma;
    const gross = gridState ? grossVirtualExposureUsd(gridState, mark) : 0;
    const net = gridState ? expectedNetUnits(gridState) : 0;
    const operating = botState.operator_killed || botState.safety_halt ? "PAUSED" : "RUNNING";
    const executionState = execution.isEnabled() ? "LIVE" : (strategy.execution.autoExecute ? "ARMED" : "LOCKED");

    const lines = [
      "TRADEIFY SOL OUTER-HEAVY STATUS",
      "",
      `Mode: ${environment.appMode.toUpperCase()} / PRODUCTION ${executionState}`,
      `Auto-execution: ${execution.isEnabled() ? "ON" : "OFF"}`,
      `Railway execution control: ${environment.autoExecute ? "ON" : "OFF"}`,
      `Strategy execution control: ${strategy.execution.autoExecute ? "ON" : "OFF"}`,
      `Bot: ${operating}`,
      "Strategy: sol-outer-heavy-v1",
      "Market source: Binance SOLUSDT",
      "Account source: DXtrade SOL/USD",
      "",
      `Balance: ${money(botState.balance)}`,
      `Live equity: ${money(botState.equity)}`,
      `Daily floor: ${money(floors.dailyFloor)}`,
      `MLL floor: ${money(floors.mllFloor)}`,
      `Active floor: ${money(floors.activeFloor)}`,
      `Floor buffer: ${money(botState.equity - floors.activeFloor)}`,
      `SOL broker position open: ${botState.has_open_position ? "YES" : "NO"}`,
      "",
      `200-day MA: ${price(maState.ma)}`,
      `MA completed through: ${maState.completedThrough}`,
      `Virtual net SOL: ${net.toFixed(2)}`,
      `Virtual gross exposure @ MA: ${money(gross)} / $1,830.00`,
      `Open virtual lots: ${openLots}`,
      `Occupied rings: ${occupiedRings}/16`,
      `Armed rings: ${armedRings}/16`,
      `SOL state version: ${gridState?.version ?? "N/A"}`,
      `Binance feed stale: ${botState.feed_stale ? "YES" : "NO"}`
    ];
    if (gridState?.lastFillAt) lines.push(`Last confirmed strategy fill: ${gridState.lastFillSide} @ ${price(gridState.lastFillPrice)} (${gridState.lastFillAt})`);
    if (botState.operator_killed) lines.push("Operator pause: ACTIVE");
    if (botState.safety_halt) lines.push(`Safety halt: ${botState.halt_reason ?? "Manual review required"}`);
    return lines.join("\n");
  }

  async function healthText() {
    const databaseTime = await database.ping();
    const ma = await maProvider.getCurrent();
    return [
      "Worker: OK",
      "PostgreSQL: OK",
      `Database time: ${new Date(databaseTime).toISOString()}`,
      "Instrument: SOL/USD / Binance SOLUSDT",
      "Strategy: sol-outer-heavy-v1",
      `200-day MA: OK (${ma.completedThrough})`,
      `Auto-execution: ${execution.isEnabled() ? "ON" : "OFF"}`,
      `Mode: ${environment.appMode}`
    ].join("\n");
  }

  async function canaryText() {
    if (!canary || typeof canary.run !== "function") return "SOL live canary is unavailable in this worker.";
    const [botState, gridState] = await Promise.all([
      database.getState(),
      persistence.state.load()
    ]);
    const floors = calculateAccountFloors({
      startingBalance: account.startingBalance,
      maxLossOffset: account.maxLossOffset,
      peakClosedBalance: Math.max(account.startingBalance, botState.high_water),
      payoutTaken: botState.payout_taken,
      previousDayClosingBalance: botState.prev_day_close,
      dailyLossLimit: account.dailyLossLimit
    });

    if (botState.operator_killed) return "SOL live canary is blocked while the operator pause is active.";
    if (botState.safety_halt) return `SOL live canary is blocked by the safety halt: ${botState.halt_reason ?? "owner review required"}`;
    if (botState.has_open_position) return "SOL live canary requires the DXtrade account to be flat first.";
    if (botState.equity <= floors.activeFloor) return "SOL live canary is blocked because live equity is at or below the active account floor.";

    const result = await canary.run({ stateVersion: gridState?.version ?? 0 });
    if (result.status === "COMPLETE" && result.openPrice && result.closePrice) {
      return [
        "SOL LIVE CANARY COMPLETE",
        "",
        `Quantity: ${result.quantity.toFixed(2)} SOL`,
        `Open fill: ${price(result.openPrice)}`,
        `Close fill: ${price(result.closePrice)}`,
        "Broker account: FLAT",
        "Automatic grid execution: OFF",
        "",
        "The real DXtrade order lifecycle has been verified."
      ].join("\n");
    }
    return result.message ?? `SOL live canary ended with status ${result.status}.`;
  }

  return Object.freeze({ ...base, statusText, healthText, canaryText });
}
