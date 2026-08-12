import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual
} from "node:crypto";
import {
  activeFloor,
  calculateConsistency,
  dailyFloor,
  determineStage,
  evaluateDailyControl,
  riskGate,
  stageProfitCeiling,
  stageRiskCap
} from "./riskEngine.js";

function money(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2
  }).format(value);
}

function percent(value) {
  return value === null ? "N/A" : `${(value * 100).toFixed(2)}%`;
}

function hashCode(code, salt) {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

function safeHexEqual(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function createTradeifyService({ database, account, strategy, environment }) {
  async function getSnapshot() {
    const [state, days] = await Promise.all([
      database.getState(),
      database.getDailyLedger()
    ]);
    const floors = {
      prevDayClose: state.prev_day_close,
      highWater: state.high_water,
      mllFloor: state.mll_floor,
      payoutTaken: state.payout_taken
    };
    const stage = determineStage(state.balance, strategy);
    const floor = activeFloor(floors, account);
    const daily = evaluateDailyControl({
      realizedPnl: state.daily_realized_pnl,
      unrealizedPnl: state.daily_unrealized_pnl,
      lossesToday: state.losses_today,
      stage
    }, strategy);
    const consistency = calculateConsistency(days, account.consistencyMax);
    const gate = riskGate({
      source: "manual",
      instrument: "BTC/USD",
      side: "BUY",
      balance: state.balance,
      liveEquity: state.equity,
      activeFloor: floor,
      dailyRealizedPnl: state.daily_realized_pnl,
      dailyUnrealizedPnl: state.daily_unrealized_pnl,
      stage,
      hasOpenPosition: state.has_open_position,
      lockedOut: state.operator_killed || state.safety_halt,
      indicatorsWarm: state.indicators_warm,
      feedStale: state.feed_stale,
      regimeAllowed: state.regime_allowed,
      newsBlackout: state.news_blackout
    }, strategy);
    return { state, floors, stage, floor, daily, consistency, gate };
  }

  async function statusText() {
    const snapshot = await getSnapshot();
    const state = snapshot.state;
    const operatingStatus = state.operator_killed || state.safety_halt ? "PAUSED" : "RUNNING";
    const lines = [
      "TRADEIFY BOT STATUS",
      "",
      `Mode: ${environment.appMode.toUpperCase()} / SIMULATION`,
      `Auto-execution: OFF`,
      `Bot: ${operatingStatus}`,
      `Stage: ${snapshot.stage}`,
      "",
      `Balance: ${money(state.balance)}`,
      `Live equity: ${money(state.equity)}`,
      `Daily floor: ${money(dailyFloor(snapshot.floors, account))}`,
      `MLL floor: ${money(state.mll_floor)}`,
      `Active floor: ${money(snapshot.floor)}`,
      `Floor buffer: ${money(state.equity - snapshot.floor)}`,
      "",
      `Daily realized P&L: ${money(state.daily_realized_pnl)}`,
      `Daily unrealized P&L: ${money(state.daily_unrealized_pnl)}`,
      `Daily control: ${snapshot.daily.action}`,
      `Risk cap: ${money(stageRiskCap(snapshot.stage, strategy))}`,
      `Profit ceiling: ${money(stageProfitCeiling(snapshot.stage, strategy))}`,
      "",
      `Consistency score: ${percent(snapshot.consistency.score)}`,
      `Indicators warm: ${state.indicators_warm ? "YES" : "NO"}`,
      `Feed stale: ${state.feed_stale ? "YES" : "NO"}`,
      `Regime allowed: ${state.regime_allowed ? "YES" : "NO"}`,
      `Entry gate: ${snapshot.gate.ok ? "PASS" : `BLOCKED - ${snapshot.gate.reason}`}`
    ];
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
      return "Operator pause removed, but the safety halt remains active. The bot cannot signal or trade until the safety condition is reviewed.";
    }
    return "Bot resumed. All live risk gates still apply; this command cannot bypass them.";
  }

  function flatInstructions() {
    return [
      "STAGE A FLAT INSTRUCTIONS",
      "",
      "Auto-execution is intentionally disabled.",
      "1. Open DXtrade.",
      "2. Close any open BTC/USD or SOL/USD position.",
      "3. Cancel remaining entry, stop, and take-profit orders only after confirming the position is flat.",
      "4. Send /status and compare the bot state with the dashboard.",
      "",
      "After Stage B is verified, /flat will call the checked DXtrade order adapter."
    ].join("\n");
  }

  async function healthText() {
    const databaseTime = await database.ping();
    return `Worker: OK\nPostgreSQL: OK\nDatabase time: ${new Date(databaseTime).toISOString()}\nAuto-execution: OFF`;
  }

  return {
    statusText,
    kill,
    requestResume,
    confirmResume,
    flatInstructions,
    healthText
  };
}
