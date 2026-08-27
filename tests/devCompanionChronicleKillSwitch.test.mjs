import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startTelegramBot } from "../src/telegramBot.js";
import { wrapCompanionWithChronicleControl } from "../src/devCompanionChronicleWiring.js";
import { createChroniclePersistence, initChroniclePersistence } from "../src/devCompanionChroniclePersistence.js";
import { createChroniclePublisher } from "../src/devCompanionChroniclePublish.js";
import { CHRONICLE_COMMANDS } from "../src/devCompanionChronicleTelegram.js";

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
    statusText: async () => "status",
    healthText: async () => "health",
    levelsText: async () => "levels",
    ringsText: async () => "rings",
    dxPreflightText: async () => "preflight",
    canaryText: async () => "canary",
    kill: async () => "killed",
    requestResume: async () => ({ message: "resume" }),
    confirmResume: async () => "confirmed",
    requestReconcile: async () => ({ message: "reconcile pending" }),
    confirmReconcile: async () => "reconcile applied",
    requestRematch: async () => ({ message: "rematch pending" }),
    confirmRematch: async () => "rematch applied",
    flatInstructions: () => "flat"
  };
}

function companionMethods(store) {
  let active = false;
  const queued = [];
  return {
    queued,
    async setSessionActive(_ownerId, value) { active = value === true; },
    async isSessionActive() { return active; },
    async resetSession() { active = true; },
    async saveOperatorSnapshot() {},
    async latestOperatorSnapshot() { return null; },
    async enqueue(_ownerId, text) { queued.push(text); return queued.length; },
    async pendingDeliveries() { return []; },
    async markDelivered() {},
    async status() { return { active, hasContext: false, pending: queued.length, processing: 0, ready: 0, failed: 0 }; },
    isChroniclePaused: store.isChroniclePaused,
    setChroniclePaused: store.setChroniclePaused
  };
}

function memoryPool() {
  const control = new Map([[1, { paused: false }]]);
  const publications = new Map();
  return {
    async query(sql, params = []) {
      const text = String(sql);
      if (text.includes("CREATE TABLE") || text.includes("ON CONFLICT (id) DO NOTHING")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("SELECT paused FROM ai_chronicle_control")) {
        const row = control.get(1);
        return row
          ? { rowCount: 1, rows: [{ paused: row.paused }] }
          : { rowCount: 0, rows: [] };
      }
      if (text.includes("INSERT INTO ai_chronicle_control") && text.includes("paused")) {
        control.set(1, { paused: params[0] === true });
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("SELECT * FROM ai_chronicle_publications")) {
        const row = publications.get(params[0]);
        return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    }
  };
}

function ownerMessage(text, ownerId = 12345) {
  return { chat: { id: 12345 }, from: { id: ownerId }, text };
}

function lastText(bot) {
  return bot.sent.at(-1)?.text ?? "";
}

test("authorized owner can pause, inspect, and resume chronicle publishing", async () => {
  const pool = memoryPool();
  await initChroniclePersistence(pool);
  const store = createChroniclePersistence(pool);
  const devCompanion = wrapCompanionWithChronicleControl(companionMethods(store));
  const bot = await startTelegramBot({
    environment: { telegramToken: "test-token", telegramAllowedUserId: 12345 },
    service: serviceStub(),
    devCompanion,
    BotClass: FakeBot
  });

  const registered = new Set(bot.commands.map((item) => item.command));
  for (const item of CHRONICLE_COMMANDS) {
    assert.equal(registered.has(item.command), true, `missing /${item.command}`);
  }

  await bot.emitMessage(ownerMessage("/chroniclestatus"));
  assert.match(lastText(bot), /ARMED/);

  await bot.emitMessage(ownerMessage("/chroniclepause"));
  assert.match(lastText(bot), /PAUSED/);
  assert.equal(await store.isChroniclePaused(), true);

  await bot.emitMessage(ownerMessage("/chroniclestatus"));
  assert.match(lastText(bot), /PAUSED/);

  await bot.emitMessage(ownerMessage("/chronicleresume"));
  assert.match(lastText(bot), /ARMED/);
  assert.equal(await store.isChroniclePaused(), false);
  bot.stopDevCompanionDelivery();
});

test("unauthorized users cannot pause, resume, or inspect chronicle publishing", async () => {
  const pool = memoryPool();
  await initChroniclePersistence(pool);
  const store = createChroniclePersistence(pool);
  const devCompanion = wrapCompanionWithChronicleControl(companionMethods(store));
  const bot = await startTelegramBot({
    environment: { telegramToken: "test-token", telegramAllowedUserId: 12345 },
    service: serviceStub(),
    devCompanion,
    BotClass: FakeBot
  });

  await bot.emitMessage(ownerMessage("/chroniclepause", 99999));
  await bot.emitMessage(ownerMessage("/chronicleresume", 99999));
  await bot.emitMessage(ownerMessage("/chroniclestatus", 99999));
  assert.equal(bot.sent.every((item) => item.text.startsWith("Not authorized")), true);
  assert.equal(await store.isChroniclePaused(), false);
  bot.stopDevCompanionDelivery();
});

test("pause persists through the shared PostgreSQL control table", async () => {
  const pool = memoryPool();
  await initChroniclePersistence(pool);
  const first = wrapCompanionWithChronicleControl(createChroniclePersistence(pool));
  await first.chroniclePause();
  assert.equal(await createChroniclePersistence(pool).isChroniclePaused(), true);

  const second = wrapCompanionWithChronicleControl(createChroniclePersistence(pool));
  const status = await second.chronicleStatus();
  assert.equal(status.paused, true);
  assert.match(status.message, /PAUSED/);
});

test("paused publisher never reaches a GitHub write or merge call", async () => {
  const pool = memoryPool();
  await initChroniclePersistence(pool);
  const store = createChroniclePersistence(pool);
  await wrapCompanionWithChronicleControl(store).chroniclePause();

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ method: options.method || "GET", href: String(url) });
    return { ok: true, status: 200, async text() { return "{}"; } };
  };
  const publisher = createChroniclePublisher({
    token: "ghs_test",
    fetchImpl,
    store,
    enabled: true
  });
  const result = await publisher.publishEntry({
    date: "2026-08-26",
    slug: "founding",
    content: "# Note\n\n**Fact:** live.\n",
    timelineLine: "| 2026-08-26 | Founding | Fact | this entry |"
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /paused/);
  assert.equal(calls.length, 0);
  assert.equal(calls.some((call) => /\/git\/|\/pulls|\/merge/.test(call.href)), false);
});

test("trading worker has no GitHub write credential or publisher execution interface", () => {
  const index = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");
  const telegram = readFileSync(new URL("../src/telegramBot.js", import.meta.url), "utf8");
  for (const source of [index, telegram]) {
    assert.match(source, /wrapCompanionWithChronicleControl|attachChronicleCommands/);
    assert.equal(/GITHUB_TOKEN|createChroniclePublisher|publish_chronicle_entry/.test(source), false);
    assert.equal(/api\.github\.com/.test(source), false);
  }
  assert.match(index, /wrapCompanionWithChronicleControl\(companionStore\)/);
  assert.match(telegram, /attachChronicleCommands/);
  assert.match(telegram, /text\.startsWith\("\/"\)/);
});

test("chronicle slash commands are never queued into the AI conversation", async () => {
  const pool = memoryPool();
  await initChroniclePersistence(pool);
  const store = createChroniclePersistence(pool);
  const methods = companionMethods(store);
  const devCompanion = wrapCompanionWithChronicleControl(methods);
  const bot = await startTelegramBot({
    environment: { telegramToken: "test-token", telegramAllowedUserId: 12345 },
    service: serviceStub(),
    devCompanion,
    BotClass: FakeBot
  });
  await bot.emitMessage(ownerMessage("/code"));
  await bot.emitMessage(ownerMessage("/chroniclepause"));
  await bot.emitMessage(ownerMessage("/chroniclestatus"));
  assert.equal(methods.queued.length, 0);
  assert.equal(await store.isChroniclePaused(), true);
  bot.stopDevCompanionDelivery();
});
