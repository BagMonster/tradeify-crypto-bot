import test from "node:test";
import assert from "node:assert/strict";
import { startTelegramBot } from "../src/telegramBot.js";
import { formatSnapshotPack, upsertSnapshotPack } from "../src/devCompanionSnapshots.js";

class FakeBot {
  constructor(token, options) {
    this.token = token;
    this.options = options;
    this.textHandlers = [];
    this.handlers = new Map();
    this.sent = [];
    this.actions = [];
    this.commands = [];
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
  async setMyCommands(commands) { this.commands = commands; }
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
    statusText: async () => "STATUS halt virtual != broker",
    healthText: async () => "health ok",
    levelsText: async () => "LEVELS SHORT3 DISARMED 1/2",
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
  let pack = {};
  return {
    queued,
    async setSessionActive(ownerId, value) { active = value === true; },
    async isSessionActive() { return active; },
    async resetSession() { active = true; },
    async saveOperatorSnapshot(ownerId, command, text) {
      pack = upsertSnapshotPack(pack, command, text, "2026-08-26T10:00:00.000Z");
    },
    async latestOperatorSnapshot() {
      const formatted = formatSnapshotPack(pack);
      if (!formatted.text) return null;
      return { command: "/levels", text: formatted.text, at: "2026-08-26T10:00:00.000Z", present: formatted.present, missing: formatted.missing };
    },
    async enqueue(ownerId, text) { queued.push({ ownerId, text }); return nextId++; },
    async pendingDeliveries() { return []; },
    async markDelivered() {},
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
  assert.deepEqual(devCompanion.queued, [{ ownerId: 12345, text: "Please explain the current SOL runtime." }]);
  bot.stopDevCompanionDelivery();
});

test("/status and /levels stay in the pack together", async () => {
  const devCompanion = companionStub();
  const bot = await startTelegramBot({
    environment: { telegramToken: "test-token", telegramAllowedUserId: 12345 },
    service: serviceStub(),
    devCompanion,
    BotClass: FakeBot
  });
  await bot.emitMessage(ownerMessage("/code"));
  await bot.emitMessage(ownerMessage("/status"));
  await bot.emitMessage(ownerMessage("/levels"));
  await bot.emitMessage(ownerMessage("Are there discrepancies?"));
  assert.equal(devCompanion.queued.length, 1);
  assert.match(devCompanion.queued[0].text, /STATUS halt virtual != broker/);
  assert.match(devCompanion.queued[0].text, /LEVELS SHORT3 DISARMED 1\/2/);
  assert.match(devCompanion.queued[0].text, /Are there discrepancies\?/);
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
