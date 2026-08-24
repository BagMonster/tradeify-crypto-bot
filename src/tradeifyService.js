import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual
} from "node:crypto";
import { calculateAccountFloors } from "./risk/accountRules.js";
import { FROZEN_GRID } from "./strategies/grid.js";
import { runDxtradePreflight } from "./execution/dxtradePreflight.js";
import { resolveInstrumentProfile } from "./instrumentProfile.js";

function money(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2
  }).format(value);
}

function price(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

function hashCode(code, salt) {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

function safeHexEqual(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function nextLevelText(gridState, side, gridDefinition) {
  if (!gridState) return "WAITING FOR INITIAL REFERENCE";
  const isBuy = side === "BUY";
  const pointer = isBuy ? gridState.buyPtr : gridState.sellPtr;
  const count = isBuy ? gridState.buyCount : gridState.sellCount;
  const levels = isBuy ? gridDefinition.buyLevels : gridDefinition.sellLevels;
  const maxConsecutive = gridDefinition.maxConsecutive ?? levels.length;
  if (count >= maxConsecutive) return `BLOCKED - ${maxConsecutive} consecutive fills reached`;
  const level = levels[pointer];
  if (!level) return "BLOCKED";
  const trigger = gridState.referencePrice * (isBuy ? 1 - level.movePct : 1 + level.movePct);
  const sign = isBuy ? "-" : "+";
  return `${isBuy ? "BUY" : "SELL"}${pointer + 1} ${sign}${(level.movePct * 100).toFixed(2)}% @ ~${price(trigger)} for ${money(level.usd)}`;
}

function preflightValidationLine(label, result) {
  if (result?.ok) return `${label}: PASS`;
  return `${label}: REJECTED (HTTP ${result?.http ?? "NONE"}, API ${result?.api ?? "NONE"})`;
}

export function createTradeifyService({
  database,
  account,
  strategy,
  environment,
  dxtradeClient = null,
  gridDefinition = FROZEN_GRID
}) {
  const instrument = resolveInstrumentProfile(strategy);
  const strategyPending = typeof strategy.strategyStatus === "string" && strategy.strategyStatus.startsWith("pending-");

  async function statusText() {
    const state = await database.getState();
    const gridState = strategyPending ? null : await database.gridState.load();
    const floors = calculateAccountFloors({
      startingBalance: account.startingBalance,
      maxLossOffset: account.maxLossOffset,
      peakClosedBalance: Math.max(account.startingBalance, state.high_water),
      payoutTaken: state.payout_taken,
      previousDayClosingBalance: state.prev_day_close,
      dailyLossLimit: account.dailyLossLimit
    });
    const operatingStatus = state.operator_killed || state.safety_halt ? "PAUSED" : "RUNNING";
    const lines = [
      `TRADEIFY ${instrument.asset} GRID STATUS`,
      "",
      `Mode: ${environment.appMode.toUpperCase()} / PRODUCTION GRID LOCKED`,
      "Auto-execution: OFF",
      `Bot: ${operatingStatus}`,
      `Market source: Binance ${instrument.binanceSymbol}`,
      `Account source: DXtrade ${instrument.dxtradeSymbol}`,
      "",
      `Balance: ${money(state.balance)}`,
      `Live equity: ${money(state.equity)}`,
      `Daily floor: ${money(floors.dailyFloor)}`,
      `MLL floor: ${money(floors.mllFloor)}`,
      `Active floor: ${money(floors.activeFloor)}`,
      `Floor buffer: ${money(state.equity - floors.activeFloor)}`,
      `${instrument.asset} position open: ${state.has_open_position ? "YES" : "NO"}`,
      "",
      `Binance feed stale: ${state.feed_stale ? "YES" : "NO"}`
    ];

    if (strategyPending) {
      lines.push(`Strategy: PENDING (${strategy.strategyStatus})`);
      lines.push("Grid reference: NOT INITIALIZED FOR NEW STRATEGY");
      lines.push("Next buy: WAITING FOR APPROVED SOL STRATEGY");
      lines.push("Next sell: WAITING FOR APPROVED SOL STRATEGY");
    } else {
      const max = gridDefinition.maxConsecutive ?? gridDefinition.buyLevels.length;
      lines.push(`Grid reference: ${gridState ? price(gridState.referencePrice) : "NOT INITIALIZED"}`);
      lines.push(`Grid state version: ${gridState?.version ?? "N/A"}`);
      lines.push(`Buy ladder: ${gridState ? `${gridState.buyCount}/${max}` : "N/A"}`);
      lines.push(`Sell ladder: ${gridState ? `${gridState.sellCount}/${max}` : "N/A"}`);
      lines.push(`Next buy: ${nextLevelText(gridState, "BUY", gridDefinition)}`);
      lines.push(`Next sell: ${nextLevelText(gridState, "SELL", gridDefinition)}`);
      if (gridState?.lastFillAt) {
        lines.push(`Last confirmed grid fill: ${gridState.lastFillSide} @ ${price(gridState.lastFillPrice)} (${gridState.lastFillAt})`);
      }
    }

    if (state.operator_killed) lines.push("Operator pause: ACTIVE");
    if (state.safety_halt) lines.push(`Safety halt: ${state.halt_reason ?? "Manual review required"}`);
    return lines.join("\n");
  }

  async function kill() {
    await database.setOperatorKilled(true);
    await database.clearResumeChallenge();
    await database.addEvent("WARN", "OPERATOR_KILL", { source: "telegram" });
    return "Bot paused. This state is stored in PostgreSQL and survives a Railway restart.";
  }

  async function requestResume() {
    const state = await database.getState();
    if (!state.operator_killed) return { code: null, message: "The operator pause is not active." };
    const code = String(randomInt(100000, 1000000));
    const salt = randomBytes(16).toString("hex");
    const hash = hashCode(code, salt);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await database.setResumeChallenge(hash, salt, expiresAt);
    return {
      code,
      message: `To resume, send /confirmresume ${code} within 10 minutes.`
    };
  }

  async function confirmResume(code) {
    const state = await database.getState();
    if (!state.operator_killed) return "The operator pause is not active.";
    if (!/^\d{6}$/.test(code ?? "")) return "Use /confirmresume followed by the 6-digit code.";
    if (!state.resume_code_hash || !state.resume_code_salt || !state.resume_code_expires_at) {
      return "No resume request is pending. Send /resume first.";
    }
    if (new Date(state.resume_code_expires_at).getTime() < Date.now()) {
      await database.clearResumeChallenge();
      return "That resume code expired. Send /resume for a new code.";
    }
    const suppliedHash = hashCode(code, state.resume_code_salt);
    if (!safeHexEqual(suppliedHash, state.resume_code_hash)) {
      await database.addEvent("WARN", "RESUME_CODE_REJECTED", { source: "telegram" });
      return "The resume code is incorrect.";
    }
    await database.setOperatorKilled(false);
    await database.clearResumeChallenge();
    await database.addEvent("INFO", "OPERATOR_RESUME", { source: "telegram" });
    if (state.safety_halt) {
      return "Operator pause removed, but the safety halt remains active. Grid actions remain blocked until the safety condition is reviewed.";
    }
    return "Bot resumed. Account, market-data, and execution gates still apply; resume cannot bypass them.";
  }

  function flatInstructions() {
    return [
      `${instrument.asset} GRID FLAT INSTRUCTIONS`,
      "",
      "Automatic execution is currently locked OFF.",
      "1. Open DXtrade.",
      `2. Close any open ${instrument.dxtradeSymbol} position.`,
      `3. Cancel any remaining ${instrument.dxtradeSymbol} working orders after confirming the position is flat.`,
      `4. Send /status and confirm ${instrument.asset} position open shows NO.`,
      "",
      "The automatic protective-flatten adapter must pass its broker validation before live activation."
    ].join("\n");
  }

  async function healthText() {
    const databaseTime = await database.ping();
    return [
      "Worker: OK",
      "PostgreSQL: OK",
      `Database time: ${new Date(databaseTime).toISOString()}`,
      `Instrument: ${instrument.dxtradeSymbol} / Binance ${instrument.binanceSymbol}`,
      `Strategy: ${strategyPending ? `PENDING (${strategy.strategyStatus})` : gridDefinition.strategyId ?? "grid"}`,
      "Auto-execution: OFF"
    ].join("\n");
  }

  async function dxPreflightText() {
    if (!dxtradeClient) return "DXtrade preflight is unavailable in this worker.";

    const result = await runDxtradePreflight({ client: dxtradeClient });
    await database.addEvent("INFO", "DXTRADE_VALIDATION_PREFLIGHT", {
      source: "telegram",
      instrument: result.instrument,
      smallestPassingCash: result.smallestPassingCash,
      gridBuy250: result.gridBuy?.ok ?? false,
      gridSell250: result.gridSell?.ok ?? false,
      validationEndpointAvailable: result.validationEndpointAvailable,
      instrumentSettingsAvailable: result.instrumentSettingsAvailable,
      validationOnly: true
    });

    const lines = [
      `DXTRADE ${instrument.asset} PREFLIGHT`,
      "",
      "READ-ONLY / VALIDATION ONLY — no order was placed.",
      `Instrument: ${result.instrument}`,
      "",
      `Account instrument settings: ${result.instrumentSettingsAvailable ? "AVAILABLE" : "UNAVAILABLE"}`
    ];

    if (result.instrumentHints.length > 0) {
      lines.push("Minimum-size metadata:");
      for (const hint of result.instrumentHints) {
        lines.push(`${hint.path}: ${hint.value}`);
      }
    } else if (result.instrumentSettingsAvailable) {
      lines.push("Minimum-size metadata: no numeric minimum-size field found in the response.");
    }

    lines.push("");

    if (!result.validationEndpointAvailable) {
      lines.push("Order-validation endpoint: UNAVAILABLE (HTTP 405)");
      lines.push("Cash-size probing stopped after the first 405 instead of repeating the same unsupported request.");
    } else {
      lines.push("BUY cash-size probes:");
      for (const probe of result.probes) {
        lines.push(preflightValidationLine(money(probe.amount), probe));
      }
      lines.push("");
      lines.push(`Smallest passing BUY probe: ${result.smallestPassingCash === null ? "NONE" : money(result.smallestPassingCash)}`);
      lines.push(preflightValidationLine("Grid $250 BUY", result.gridBuy));
      lines.push(preflightValidationLine("Grid $250 SELL", result.gridSell));
    }

    lines.push("");
    lines.push("Auto-execution remains OFF. This command never calls the order-placement endpoint.");

    return lines.join("\n");
  }

  return {
    statusText,
    kill,
    requestResume,
    confirmResume,
    flatInstructions,
    healthText,
    dxPreflightText
  };
}
