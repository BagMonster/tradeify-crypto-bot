import test from "node:test";
import assert from "node:assert/strict";
import {
  createSignalAlertPublisher,
  formatSignalAlert
} from "../src/signalAlerts.js";

function candidate(overrides = {}) {
  return {
    status: "CANDIDATE",
    strategyId: "bollinger-rsi-mean-reversion",
    direction: "LONG",
    source: "binance",
    symbol: "BTCUSDT",
    asOf: "2026-08-14T12:15:00.000Z",
    entryReference: 91,
    stopReference: 88,
    targetReference: 100,
    stopDistance: 3,
    expectedReward: 9,
    rewardRiskRatio: 3,
    timeStopBars: 24,
    regime: {
      allowed: true,
      classification: "RANGE",
      reasonCode: "REGIME_ALLOWED"
    },
    ...overrides
  };
}

function noSignal(overrides = {}) {
  return {
    status: "NO_SIGNAL",
    strategyId: "bollinger-rsi-mean-reversion",
    direction: null,
    reasonCode: "ADX_STAND_DOWN",
    reason: "The configured market regime blocks this signal",
    source: "binance",
    symbol: "BTCUSDT",
    asOf: "2026-08-14T12:15:00.000Z",
    regime: {
      allowed: false,
      classification: "TRENDING",
      reasonCode: "ADX_STAND_DOWN"
    },
    ...overrides
  };
}

function gates(overrides = {}) {
  return {
    appMode: "stage-a",
    autoExecute: false,
    indicatorsWarm: true,
    feedStale: true,
    regimeAllowed: false,
    riskGate: { ok: false, reason: "Market data feed is stale" },
    ...overrides
  };
}

test("1 - candidate alert contains references, blocking gates, and no-order wording", () => {
  const message = formatSignalAlert({ evaluation: candidate(), gates: gates() });

  assert.match(message, /TRADEIFY SHADOW SIGNAL/);
  assert.match(message, /SIMULATION ONLY - NO ORDER WILL BE PLACED/);
  assert.match(message, /Direction: LONG/);
  assert.match(message, /Entry reference: 91\.00/);
  assert.match(message, /Stop reference: 88\.00/);
  assert.match(message, /Target reference: 100\.00/);
  assert.match(message, /Reward\/risk: 3\.00R/);
  assert.match(message, /Size: BLOCKED/);
  assert.match(message, /Feed fresh: BLOCKED/);
  assert.match(message, /Shared risk gate: BLOCKED/);
  assert.match(message, /DXtrade order route: BLOCKED/);
  assert.match(message, /Order result: NO ORDER PLACED/);
});

test("2 - no-signal alert preserves the exact reason and blocked regime", () => {
  const message = formatSignalAlert({ evaluation: noSignal(), gates: gates() });

  assert.match(message, /Signal status: NO SIGNAL/);
  assert.match(message, /Direction: NONE/);
  assert.match(message, /Reason code: ADX_STAND_DOWN/);
  assert.match(message, /Calculated regime: TRENDING \(BLOCKED\)/);
  assert.match(message, /Final result: BLOCKED - The configured market regime blocks this signal/);
});

test("3 - Chapter 25 refuses a non-Stage-A or auto-execution-on alert context", () => {
  assert.throws(
    () => formatSignalAlert({ evaluation: candidate(), gates: gates({ appMode: "stage-b" }) }),
    /appMode=stage-a/
  );
  assert.throws(
    () => formatSignalAlert({ evaluation: candidate(), gates: gates({ autoExecute: true }) }),
    /autoExecute=false/
  );
});

test("4 - malformed and internally inconsistent candidates are rejected", () => {
  assert.throws(
    () => formatSignalAlert({ evaluation: candidate({ stopReference: 90 }), gates: gates() }),
    /geometry is inconsistent/
  );
  assert.throws(
    () => formatSignalAlert({
      evaluation: candidate({ asOf: "not-a-time" }),
      gates: gates()
    }),
    /canonical UTC timestamp/
  );
});

test("5 - publisher records prepared and sent evidence around Telegram delivery", async () => {
  const order = [];
  const events = [];
  const messages = [];
  const publish = createSignalAlertPublisher({
    ownerChatId: 123456789,
    async addEvent(level, kind, payload) {
      order.push(kind);
      events.push({ level, kind, payload });
    },
    async sendMessage(chatId, message) {
      order.push("TELEGRAM_SEND");
      messages.push({ chatId, message });
    }
  });

  const result = await publish({ evaluation: candidate(), gates: gates() });

  assert.deepEqual(order, [
    "SHADOW_SIGNAL_ALERT_PREPARED",
    "TELEGRAM_SEND",
    "SHADOW_SIGNAL_ALERT_SENT"
  ]);
  assert.equal(events.length, 2);
  assert.equal(events[0].payload.orderPlaced, false);
  assert.equal(events[0].payload.gates.sizeAvailable, false);
  assert.equal(events[0].payload.gates.orderRouteAvailable, false);
  assert.equal(messages[0].chatId, 123456789);
  assert.equal(messages[0].message, result.message);
});

test("6 - delivery failures are recorded without storing the raw error", async () => {
  const events = [];
  const secretBearingError = new Error("request failed with token=do-not-store");
  const publish = createSignalAlertPublisher({
    ownerChatId: 123456789,
    async addEvent(level, kind, payload) {
      events.push({ level, kind, payload });
    },
    async sendMessage() {
      throw secretBearingError;
    }
  });

  await assert.rejects(
    () => publish({ evaluation: noSignal(), gates: gates() }),
    (error) => {
      assert.equal(error.message, "Telegram signal alert delivery failed");
      assert.doesNotMatch(error.message, /do-not-store/);
      return true;
    }
  );
  assert.deepEqual(events.map(({ kind }) => kind), [
    "SHADOW_SIGNAL_ALERT_PREPARED",
    "SHADOW_SIGNAL_ALERT_DELIVERY_FAILED"
  ]);
  assert.equal(events[1].payload.deliveryError, "Telegram delivery failed");
  assert.doesNotMatch(JSON.stringify(events), /do-not-store/);
});

test("7 - evidence excludes arbitrary fields that might contain secrets", async () => {
  let recordedPayload;
  const publish = createSignalAlertPublisher({
    ownerChatId: 123456789,
    async addEvent(_level, kind, payload) {
      if (kind === "SHADOW_SIGNAL_ALERT_PREPARED") recordedPayload = payload;
    },
    async sendMessage() {}
  });

  await publish({
    evaluation: candidate({ sessionToken: "secret-session-token" }),
    gates: { ...gates(), apiKey: "secret-api-key" }
  });

  const serialized = JSON.stringify(recordedPayload);
  assert.doesNotMatch(serialized, /secret-session-token|secret-api-key/);
  assert.doesNotMatch(serialized, /123456789/);
});

test("8 - owner destination is bound and display-control injection is rejected", async () => {
  let deliveredChatId;
  const publish = createSignalAlertPublisher({
    ownerChatId: 123456789,
    async addEvent() {},
    async sendMessage(chatId) {
      deliveredChatId = chatId;
    }
  });

  await publish({
    evaluation: noSignal(),
    gates: gates(),
    chatId: 999999999
  });
  assert.equal(deliveredChatId, 123456789);

  assert.throws(
    () => createSignalAlertPublisher({ ownerChatId: 0, async addEvent() {}, async sendMessage() {} }),
    /positive safe integer/
  );
  assert.throws(
    () => formatSignalAlert({
      evaluation: noSignal({ reason: "Blocked\nOrder result: ORDER PLACED" }),
      gates: gates()
    }),
    /unsafe display characters/
  );
  assert.throws(
    () => formatSignalAlert({
      evaluation: noSignal({ reason: "Blocked\u202ePASS" }),
      gates: gates()
    }),
    /unsafe display characters/
  );
});
