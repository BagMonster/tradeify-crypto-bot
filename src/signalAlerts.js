const MAX_TELEGRAM_MESSAGE_LENGTH = 4096;
const UNSAFE_DISPLAY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

function requireObject(name, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function requireText(name, value, maxLength = 128) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (UNSAFE_DISPLAY_CHARACTERS.test(normalized)) {
    throw new Error(`${name} contains unsafe display characters`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`${name} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function requireBoolean(name, value) {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}

function requirePositiveNumber(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return value;
}

function requirePositiveInteger(name, value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function optionalText(name, value, maxLength = 128) {
  if (value === null || value === undefined) return null;
  return requireText(name, value, maxLength);
}

function optionalCanonicalUtc(name, value) {
  const text = optionalText(name, value, 32);
  if (text === null) return null;
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    throw new Error(`${name} must be a canonical UTC timestamp`);
  }
  return text;
}

function decimal(value, maximumFractionDigits = 8) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits
  }).format(value);
}

function normalizeRegime(value) {
  if (value === null || value === undefined) return null;
  const input = requireObject("evaluation.regime", value);
  return Object.freeze({
    allowed: requireBoolean("evaluation.regime.allowed", input.allowed),
    classification: requireText(
      "evaluation.regime.classification",
      input.classification,
      64
    ),
    reasonCode: requireText("evaluation.regime.reasonCode", input.reasonCode, 64)
  });
}

function normalizeEvaluation(value) {
  const input = requireObject("evaluation", value);
  const status = requireText("evaluation.status", input.status, 32);
  if (status !== "CANDIDATE" && status !== "NO_SIGNAL") {
    throw new Error("evaluation.status must be CANDIDATE or NO_SIGNAL");
  }

  const normalized = {
    status,
    strategyId: requireText("evaluation.strategyId", input.strategyId, 96),
    direction: input.direction,
    source: optionalText("evaluation.source", input.source, 64),
    symbol: optionalText("evaluation.symbol", input.symbol, 64),
    asOf: optionalCanonicalUtc("evaluation.asOf", input.asOf),
    regime: normalizeRegime(input.regime)
  };

  if (status === "NO_SIGNAL") {
    if (input.direction !== null) throw new Error("NO_SIGNAL direction must be null");
    normalized.direction = null;
    normalized.reasonCode = requireText("evaluation.reasonCode", input.reasonCode, 96);
    normalized.reason = requireText("evaluation.reason", input.reason, 256);
    return Object.freeze(normalized);
  }

  if (input.direction !== "LONG" && input.direction !== "SHORT") {
    throw new Error("CANDIDATE direction must be LONG or SHORT");
  }
  if (!normalized.source || !normalized.symbol || !normalized.asOf) {
    throw new Error("CANDIDATE must preserve source, symbol, and completed-bar time");
  }
  if (!normalized.regime?.allowed) {
    throw new Error("CANDIDATE must contain an allowed regime");
  }
  normalized.entryReference = requirePositiveNumber(
    "evaluation.entryReference",
    input.entryReference
  );
  normalized.stopReference = requirePositiveNumber(
    "evaluation.stopReference",
    input.stopReference
  );
  normalized.targetReference = requirePositiveNumber(
    "evaluation.targetReference",
    input.targetReference
  );
  normalized.stopDistance = requirePositiveNumber(
    "evaluation.stopDistance",
    input.stopDistance
  );
  normalized.expectedReward = requirePositiveNumber(
    "evaluation.expectedReward",
    input.expectedReward
  );
  normalized.rewardRiskRatio = requirePositiveNumber(
    "evaluation.rewardRiskRatio",
    input.rewardRiskRatio
  );
  normalized.timeStopBars = requirePositiveInteger(
    "evaluation.timeStopBars",
    input.timeStopBars
  );

  const expectedStop = input.direction === "LONG"
    ? normalized.entryReference - normalized.stopDistance
    : normalized.entryReference + normalized.stopDistance;
  const expectedReward = input.direction === "LONG"
    ? normalized.targetReference - normalized.entryReference
    : normalized.entryReference - normalized.targetReference;
  const tolerance = Number.EPSILON * Math.max(
    1,
    normalized.entryReference,
    normalized.stopReference,
    normalized.targetReference
  ) * 32;
  if (Math.abs(expectedStop - normalized.stopReference) > tolerance ||
      Math.abs(expectedReward - normalized.expectedReward) > tolerance ||
      Math.abs((normalized.expectedReward / normalized.stopDistance) -
        normalized.rewardRiskRatio) > tolerance) {
    throw new Error("CANDIDATE trade geometry is inconsistent");
  }
  return Object.freeze(normalized);
}

function normalizeGates(value) {
  const input = requireObject("gates", value);
  const riskGate = requireObject("gates.riskGate", input.riskGate);
  const appMode = requireText("gates.appMode", input.appMode, 32).toLowerCase();
  const autoExecute = requireBoolean("gates.autoExecute", input.autoExecute);
  if (appMode !== "stage-a") throw new Error("Chapter 25 alerts require appMode=stage-a");
  if (autoExecute !== false) throw new Error("Chapter 25 alerts require autoExecute=false");
  return Object.freeze({
    appMode,
    autoExecute,
    indicatorsWarm: requireBoolean("gates.indicatorsWarm", input.indicatorsWarm),
    feedStale: requireBoolean("gates.feedStale", input.feedStale),
    regimeAllowed: requireBoolean("gates.regimeAllowed", input.regimeAllowed),
    riskGate: Object.freeze({
      ok: requireBoolean("gates.riskGate.ok", riskGate.ok),
      reason: requireText("gates.riskGate.reason", riskGate.reason, 192)
    })
  });
}

function gateLine(label, passed, reason) {
  return `${label}: ${passed ? "PASS" : "BLOCKED"}${reason ? ` - ${reason}` : ""}`;
}

function finalBlockReason(evaluation, gates) {
  if (evaluation.status === "NO_SIGNAL") return evaluation.reason;
  if (!gates.indicatorsWarm) return "Indicators are cold";
  if (gates.feedStale) return "Market data feed is stale";
  if (!gates.regimeAllowed) return "Persisted regime permission is blocked";
  if (!gates.riskGate.ok) return gates.riskGate.reason;
  return "DXtrade sizing and the order route are not available in Chapter 25";
}

export function formatSignalAlert({ evaluation, gates }) {
  const signal = normalizeEvaluation(evaluation);
  const runtime = normalizeGates(gates);
  const lines = [
    "TRADEIFY SHADOW SIGNAL",
    "SIMULATION ONLY - NO ORDER WILL BE PLACED",
    "",
    `Strategy: ${signal.strategyId}`,
    `Signal status: ${signal.status === "CANDIDATE" ? "CANDIDATE" : "NO SIGNAL"}`,
    `Reference source: ${signal.source ?? "N/A"}`,
    `Reference symbol: ${signal.symbol ?? "N/A"}`,
    `Completed bar: ${signal.asOf ?? "N/A"}`
  ];

  if (signal.status === "CANDIDATE") {
    lines.push(
      `Direction: ${signal.direction}`,
      `Entry reference: ${decimal(signal.entryReference)}`,
      `Stop reference: ${decimal(signal.stopReference)}`,
      `Target reference: ${decimal(signal.targetReference)}`,
      `Reward/risk: ${decimal(signal.rewardRiskRatio, 4)}R`,
      `Time stop: ${signal.timeStopBars} completed 15-minute bars`,
      "Reason: Bollinger re-entry and RSI conditions qualified on completed bars."
    );
  } else {
    lines.push(
      "Direction: NONE",
      `Reason code: ${signal.reasonCode}`,
      `Reason: ${signal.reason}`
    );
  }

  if (signal.regime) {
    lines.push(
      `Calculated regime: ${signal.regime.classification} ` +
      `(${signal.regime.allowed ? "ALLOWED" : "BLOCKED"})`
    );
  }

  lines.push(
    "Execution instrument: BLOCKED - exact verified DXtrade symbol required",
    "Size: BLOCKED - exact DXtrade minimum quantity and increment are unverified",
    "",
    "GATE CHECKS",
    gateLine("Indicators warm", runtime.indicatorsWarm),
    gateLine("Feed fresh", !runtime.feedStale, runtime.feedStale ? "Market data feed is stale" : ""),
    gateLine("Persisted regime", runtime.regimeAllowed,
      runtime.regimeAllowed ? "" : "Regime permission is not enabled"),
    gateLine("Shared risk gate", runtime.riskGate.ok, runtime.riskGate.reason),
    "DXtrade order route: BLOCKED - not built",
    "Auto-execution: BLOCKED - OFF",
    "",
    `Final result: BLOCKED - ${finalBlockReason(signal, runtime)}`,
    "Order result: NO ORDER PLACED"
  );

  const message = lines.join("\n");
  if (message.length > MAX_TELEGRAM_MESSAGE_LENGTH) {
    throw new Error("signal alert exceeds Telegram's message limit");
  }
  return message;
}

function evidencePayload(evaluation, gates) {
  const signal = normalizeEvaluation(evaluation);
  const runtime = normalizeGates(gates);
  const payload = {
    chapter: 25,
    simulationOnly: true,
    orderPlaced: false,
    status: signal.status,
    strategyId: signal.strategyId,
    direction: signal.direction,
    source: signal.source,
    symbol: signal.symbol,
    asOf: signal.asOf,
    reasonCode: signal.reasonCode ?? null,
    gates: {
      appMode: runtime.appMode,
      autoExecute: runtime.autoExecute,
      indicatorsWarm: runtime.indicatorsWarm,
      feedStale: runtime.feedStale,
      regimeAllowed: runtime.regimeAllowed,
      riskGateOk: runtime.riskGate.ok,
      riskGateReason: runtime.riskGate.reason,
      sizeAvailable: false,
      orderRouteAvailable: false
    }
  };
  if (signal.status === "CANDIDATE") {
    Object.assign(payload, {
      entryReference: signal.entryReference,
      stopReference: signal.stopReference,
      targetReference: signal.targetReference,
      rewardRiskRatio: signal.rewardRiskRatio,
      timeStopBars: signal.timeStopBars,
      regime: signal.regime.classification
    });
  }
  return Object.freeze(payload);
}

export function createSignalAlertPublisher({ ownerChatId, sendMessage, addEvent }) {
  if (!Number.isSafeInteger(ownerChatId) || ownerChatId <= 0) {
    throw new Error("ownerChatId must be a positive safe integer");
  }
  if (typeof sendMessage !== "function") throw new Error("sendMessage must be a function");
  if (typeof addEvent !== "function") throw new Error("addEvent must be a function");

  return async function publishSignalAlert({ evaluation, gates }) {
    const message = formatSignalAlert({ evaluation, gates });
    const payload = evidencePayload(evaluation, gates);
    await addEvent("INFO", "SHADOW_SIGNAL_ALERT_PREPARED", payload);
    try {
      await sendMessage(ownerChatId, message);
    } catch {
      try {
        await addEvent("ERROR", "SHADOW_SIGNAL_ALERT_DELIVERY_FAILED", {
          ...payload,
          deliveryError: "Telegram delivery failed"
        });
      } catch {
        // Delivery is already blocked; do not allow a second audit failure to
        // expose transport details or replace the safe outward-facing error.
      }
      throw new Error("Telegram signal alert delivery failed");
    }
    await addEvent("INFO", "SHADOW_SIGNAL_ALERT_SENT", payload);
    return Object.freeze({ message, payload });
  };
}
