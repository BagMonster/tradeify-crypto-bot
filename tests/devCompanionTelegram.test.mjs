import test from "node:test";
import assert from "node:assert/strict";
import { startTelegramBot } from "../src/telegramBot.js";

class FakeBot {
  static instance = null;

  constructor(token, options) {
    this.token = token;
    this.options = options;
    this.textHandlers = [];
    this.handlers = new Map();
    this.sent = [];
    this.actions = [];
    this.commands = [];
    FakeBot.instance = this;
  }

  onText(regex, handler) {
    this.textHandlers.push({ regex, handler });
  }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(handler);
  }

  async sendMessage(chatId, text, options) {
    this.sent.push({ chatId, text, options });
    return { chat: { id: chatId }, text };
  }

  async sendChatAction(chatId, action) {
    this.actions.push({ chatId, action });
  }

  async answerCallbackQuery() {}

  async setMyCommands(commands) {
    this.commands = commands;
  }

  async stopPolling() {}

  async emitMessage(message) {
    for (const { regex, handler } of this.textHandlers) {
      const match = typeof message.text === "string" ? message.text.match(regex) : null;
      if (match) await handler(message, match);
    }
    for (const handler of this.handlers.get("message") ?? []) await handler(message);
  }
}

function serviceStub() {
  return {
    statusText: async () => "TRADEIFY SOL OUTER-HEAVY STATUS\nVirtual net SOL: -0.06\nLast confirmed strategy fill: SELL @ $100.535",
    healthText: async () => "health",
    levelsText: async () => "levels",
    ringsText: async () => "rings",
    dxPreflightText: async () => "preflight",
    canaryText: async () => "canary",
    kill: async () => "killed",
    requestResume: async () => ({ message: "resume" }),
    confirmResume: async () => "confirmed",
    flatInstructions: () => "flat"
  };
}

function companionStub() {
  let active = false;
  let nextId = 1;
  const queued = [];
  const delivered = [];
  let snapshot = null;
  return {
    queued,
    delivered,
    async setSessionActive(ownerId, value) { active = value === true; },
    async isSessionActive() { return active; },
    async resetSession() { active = true; },
    async saveOperatorSnapshot(ownerId, command, text) {
      snapshot = { command, text, at: "2026-08-26T10:00:00.000Z" };
    },
    async latestOperatorSnapshot() { return snapshot; },
    async enqueue(ownerId, text) { queued.push({ ownerId, text }); return nextId++; },
    async pendingDeliveries() { return []; },
    async markDelivered(id, ownerId) { delivered.push({ id, ownerId }); },
    async status() { return { active, hasContext: false, pending: queued.length, processing: 0, ready: 0, failed: 0 }; }
  };
}

function ownerMessage(text, ownerId = 12345) {
  return { chat: { id: 12345 }, from: { id: ownerId }, text };
}

test("/code activates owner-only development routing and ordinary text queues a job", async () => {
  const devCompanion = companionStub();
  const bot = await startTelegramBot({
    environment: { telegramToken: "test-token", telegramAllowedUserId: 12345 },
    service: serviceStub(),
    devCompanion,
    BotClass: FakeBot
  });

  await bot.emitMessage(ownerMessage("/code"));
  await bot.emitMessage(ownerMessage("Please explain the current SOL runtime."));

  assert.deepEqual(devCompanion.queued, [
    { ownerId: 12345, text: "Please explain the current SOL runtime." }
  ]);
  assert.ok(bot.sent.some((message) => message.text.includes("development mode is ACTIVE")));
  assert.equal(bot.sent.some((message) => message.text.includes("queued")), false);
  assert.ok(bot.actions.some((item) => item.chatId === 12345 && item.action === "typing"));
  bot.stopDevCompanionDelivery();
});

test("/status while /code is active is latched into the next companion job", async () => {
  const devCompanion = companionStub();
  const bot = await startTelegramBot({
    environment: { telegramToken: "test-token", telegramAllowedUserId: 12345 },
    service: serviceStub(),
    devCompanion,
    BotClass: FakeBot
  });

  await bot.emitMessage(ownerMessage("/code"));
  await bot.emitMessage(ownerMessage("/status"));
  await bot.emitMessage(ownerMessage("Did we buy or sell short?"));

  assert.equal(devCompanion.queued.length, 1);
  assert.match(devCompanion.queued[0].text, /LATEST OPERATOR SNAPSHOT \(\/status/);
  assert.match(devCompanion.queued[0].text, /Virtual net SOL: -0\.06/);
  assert.match(devCompanion.queued[0].text, /Did we buy or sell short\?/);
  bot.stopDevCompanionDelivery();
});

test("ordinary text is ignored outside development mode", async () => {
  const devCompanion = companionStub();
  const bot = await startTelegramBot({
    environment: { telegramToken: "test-token", telegramAllowedUserId: 12345 },
    service: serviceStub(),
    devCompanion,
    BotClass: FakeBot
  });

  await bot.emitMessage(ownerMessage("Normal Telegram text"));
  assert.equal(devCompanion.queued.length, 0);
  bot.stopDevCompanionDelivery();
});

test("unauthorized users cannot activate or feed development mode", async () => {
  const devCompanion = companionStub();
  const bot = await startTelegramBot({
    environment: { telegramToken: "test-token", telegramAllowedUserId: 12345 },
    service: serviceStub(),
    devCompanion,
    BotClass: FakeBot
  });

  await bot.emitMessage(ownerMessage("/code", 99999));
  await bot.emitMessage(ownerMessage("Change the repository", 99999));

  assert.equal(devCompanion.queued.length, 0);
  assert.ok(bot.sent.some((message) => message.text.startsWith("Not authorized")));
  bot.stopDevCompanionDelivery();
});

test("development commands are registered without replacing trading commands", async () => {
  const devCompanion = companionStub();
  const bot = await startTelegramBot({
    environment: { telegramToken: "test-token", telegramAllowedUserId: 12345 },
    service: serviceStub(),
    devCompanion,
    BotClass: FakeBot
  });

  const commands = new Set(bot.commands.map((item) => item.command));
  for (const command of ["status", "health", "kill", "code", "devstatus", "devreset", "devexit"]) {
    assert.equal(commands.has(command), true, `missing /${command}`);
  }
  bot.stopDevCompanionDelivery();
});
