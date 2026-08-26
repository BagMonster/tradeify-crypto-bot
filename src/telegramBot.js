import TelegramBot from "node-telegram-bot-api";

const MAIN_MENU = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "Status", callback_data: "status" },
        { text: "Health", callback_data: "health" }
      ],
      [
        { text: "Grid Levels", callback_data: "levels" },
        { text: "Ring Position", callback_data: "rings" }
      ],
      [
        { text: "Pause Bot", callback_data: "kill" },
        { text: "Resume", callback_data: "resume" }
      ],
      [
        { text: "Development", callback_data: "code" },
        { text: "Help", callback_data: "help" }
      ],
      [
        { text: "Flat Instructions", callback_data: "flat" }
      ]
    ]
  }
};

const HELP_TEXT = [
  "TRADEIFY BOT COMMANDS",
  "",
  "/status - show account, floors, SOL strategy state, and live execution controls",
  "/health - confirm the worker, PostgreSQL, MA provider, and execution state",
  "/levels - show all 10 BUY and 10 SHORT trigger prices, sizes, estimated SOL quantities, and ring state",
  "/rings - show where live SOL sits relative to the frozen ring ladder and the next BUY/SHORT levels",
  "/dxpreflight - inspect active-instrument order settings without placing an order",
  "/solcanary - inspect/replay the approved lifecycle canary only while automatic execution is OFF",
  "/kill - pause the bot and persist the pause",
  "/resume - request a 6-digit resume code",
  "/confirmresume CODE - confirm the restart",
  "/flat - show manual SOL/USD flattening instructions",
  "/code - enter the owner-only OpenAI development conversation",
  "/devstatus - show development companion queue/session status",
  "/devreset - reset OpenAI conversation context and remain in development mode",
  "/devexit - leave development mode",
  "/whoami - show your Telegram numeric user ID",
  "/help - show this list",
  "",
  "There are no /long or /short commands. /levels and /rings are read-only. The frozen SOL grid trades automatically only when both live execution controls are ON and every safety gate passes.",
  "Development mode is conversational only in Phase 1. It cannot place trades or change GitHub."
].join("\n");

function devStatusText(status) {
  return [
    "OPENAI DEVELOPMENT COMPANION",
    `Mode: ${status.active ? "ACTIVE" : "OFF"}`,
    `Conversation context: ${status.hasContext ? "PERSISTED" : "NEW"}`,
    `Queued: ${status.pending}`,
    `Processing: ${status.processing}`,
    `Ready to deliver: ${status.ready}`,
    `Failed awaiting notice: ${status.failed}`,
    "Phase 1: conversational/read-only"
  ].join("\n");
}

export async function startTelegramBot({
  environment,
  service,
  notifications = null,
  devCompanion = null,
  BotClass = TelegramBot
}) {
  const bot = new BotClass(environment.telegramToken, { polling: true });

  if (notifications !== null) {
    if (typeof notifications?.setSender !== "function") throw new TypeError("notifications.setSender must be a function");
    notifications.setSender(async (text) => {
      if (!Number.isSafeInteger(environment.telegramAllowedUserId) || environment.telegramAllowedUserId <= 0) {
        throw new Error("Owner Telegram destination is unavailable");
      }
      await bot.sendMessage(environment.telegramAllowedUserId, text);
    });
  }

  if (devCompanion !== null) {
    const required = ["setSessionActive", "isSessionActive", "resetSession", "enqueue", "pendingDeliveries", "markDelivered", "status"];
    for (const method of required) {
      if (typeof devCompanion?.[method] !== "function") throw new TypeError(`devCompanion.${method} must be a function`);
    }
  }

  function isAuthorized(from) {
    return environment.telegramAllowedUserId > 0
      && Number(from?.id) === environment.telegramAllowedUserId;
  }

  async function deny(chatId) {
    await bot.sendMessage(chatId, "Not authorized. Use /whoami to see your numeric Telegram user ID.");
  }

  function withAuthorization(handler) {
    return async (message, match) => {
      const chatId = message.chat.id;
      if (!isAuthorized(message.from)) return deny(chatId);
      try {
        return await handler(message, match);
      } catch (error) {
        console.error("Telegram command failed:", error.message);
        return bot.sendMessage(chatId, "The command failed. Check Railway logs for the error.");
      }
    };
  }

  async function sendMenu(chatId, lead = "Tradeify control panel") {
    return bot.sendMessage(chatId, lead, MAIN_MENU);
  }

  async function sendTyping(chatId) {
    if (typeof bot.sendChatAction !== "function") return;
    try {
      await bot.sendChatAction(chatId, "typing");
    } catch (error) {
      console.error("Telegram typing indicator failed:", error.message);
    }
  }

  async function enterDevelopment(chatId) {
    if (!devCompanion) return bot.sendMessage(chatId, "Development companion is not configured on this deployment.");
    await devCompanion.setSessionActive(environment.telegramAllowedUserId, true);
    return bot.sendMessage(
      chatId,
      "OpenAI development mode is ACTIVE. Send normal text to talk with the development companion. Use /devexit to leave, /devreset for a fresh conversation, or /devstatus to check the queue."
    );
  }

  bot.onText(/^\/whoami(?:@\w+)?$/i, async (message) => {
    await bot.sendMessage(message.chat.id, `Your Telegram user ID is: ${message.from.id}`);
  });

  bot.onText(/^\/(start|help)(?:@\w+)?$/i, withAuthorization(async (message) => {
    await bot.sendMessage(message.chat.id, HELP_TEXT);
    await sendMenu(message.chat.id);
  }));

  bot.onText(/^\/status(?:@\w+)?$/i, withAuthorization(async (message) => {
    await bot.sendMessage(message.chat.id, await service.statusText());
  }));

  bot.onText(/^\/health(?:@\w+)?$/i, withAuthorization(async (message) => {
    await bot.sendMessage(message.chat.id, await service.healthText());
  }));

  bot.onText(/^\/levels(?:@\w+)?$/i, withAuthorization(async (message) => {
    await bot.sendMessage(message.chat.id, await service.levelsText());
  }));

  bot.onText(/^\/rings(?:@\w+)?$/i, withAuthorization(async (message) => {
    await bot.sendMessage(message.chat.id, await service.ringsText());
  }));

  bot.onText(/^\/dxpreflight(?:@\w+)?$/i, withAuthorization(async (message) => {
    await bot.sendMessage(message.chat.id, "Running DXtrade validation-only preflight. No order will be placed.");
    await bot.sendMessage(message.chat.id, await service.dxPreflightText());
  }));

  bot.onText(/^\/solcanary(?:@\w+)?$/i, withAuthorization(async (message) => {
    await bot.sendMessage(message.chat.id, "Checking the owner-approved 0.01 SOL lifecycle canary. It can run only while automatic grid execution is OFF.");
    await bot.sendMessage(message.chat.id, await service.canaryText());
  }));

  bot.onText(/^\/kill(?:@\w+)?$/i, withAuthorization(async (message) => {
    await bot.sendMessage(message.chat.id, await service.kill());
  }));

  bot.onText(/^\/resume(?:@\w+)?$/i, withAuthorization(async (message) => {
    const result = await service.requestResume();
    await bot.sendMessage(message.chat.id, result.message);
  }));

  bot.onText(/^\/confirmresume(?:@\w+)?(?:\s+(\S+))?$/i, withAuthorization(async (message, match) => {
    await bot.sendMessage(message.chat.id, await service.confirmResume(match?.[1] ?? ""));
  }));

  bot.onText(/^\/flat(?:@\w+)?$/i, withAuthorization(async (message) => {
    await bot.sendMessage(message.chat.id, service.flatInstructions());
  }));

  bot.onText(/^\/code(?:@\w+)?$/i, withAuthorization(async (message) => {
    await enterDevelopment(message.chat.id);
  }));

  bot.onText(/^\/devstatus(?:@\w+)?$/i, withAuthorization(async (message) => {
    if (!devCompanion) return bot.sendMessage(message.chat.id, "Development companion is not configured on this deployment.");
    await bot.sendMessage(message.chat.id, devStatusText(await devCompanion.status(environment.telegramAllowedUserId)));
  }));

  bot.onText(/^\/devreset(?:@\w+)?$/i, withAuthorization(async (message) => {
    if (!devCompanion) return bot.sendMessage(message.chat.id, "Development companion is not configured on this deployment.");
    await devCompanion.resetSession(environment.telegramAllowedUserId);
    await bot.sendMessage(message.chat.id, "Development conversation reset. OpenAI context is fresh and development mode remains ACTIVE.");
  }));

  bot.onText(/^\/devexit(?:@\w+)?$/i, withAuthorization(async (message) => {
    if (!devCompanion) return bot.sendMessage(message.chat.id, "Development companion is not configured on this deployment.");
    await devCompanion.setSessionActive(environment.telegramAllowedUserId, false);
    await bot.sendMessage(message.chat.id, "OpenAI development mode is OFF. Trading commands continue to work normally.");
  }));

  // Ordinary owner text becomes development conversation only while /code mode is active.
  bot.on("message", async (message) => {
    if (!devCompanion || !isAuthorized(message.from)) return;
    const text = typeof message.text === "string" ? message.text.trim() : "";
    if (!text || text.startsWith("/")) return;
    try {
      if (!(await devCompanion.isSessionActive(environment.telegramAllowedUserId))) return;
      await devCompanion.enqueue(environment.telegramAllowedUserId, text);
      await sendTyping(message.chat.id);
    } catch (error) {
      console.error("Development message routing failed:", error.message);
      await bot.sendMessage(message.chat.id, "The development request could not be queued. Check Railway logs.");
    }
  });

  bot.on("callback_query", async (query) => {
    const chatId = query.message?.chat?.id;
    if (!chatId) return;
    await bot.answerCallbackQuery(query.id);
    if (!isAuthorized(query.from)) return deny(chatId);
    try {
      switch (query.data) {
        case "status":
          await bot.sendMessage(chatId, await service.statusText());
          break;
        case "health":
          await bot.sendMessage(chatId, await service.healthText());
          break;
        case "levels":
          await bot.sendMessage(chatId, await service.levelsText());
          break;
        case "rings":
          await bot.sendMessage(chatId, await service.ringsText());
          break;
        case "kill":
          await bot.sendMessage(chatId, await service.kill());
          break;
        case "resume": {
          const result = await service.requestResume();
          await bot.sendMessage(chatId, result.message);
          break;
        }
        case "flat":
          await bot.sendMessage(chatId, service.flatInstructions());
          break;
        case "code":
          await enterDevelopment(chatId);
          break;
        case "help":
          await bot.sendMessage(chatId, HELP_TEXT);
          break;
        default:
          await bot.sendMessage(chatId, "Unknown button. Send /help.");
      }
    } catch (error) {
      console.error("Telegram button failed:", error.message);
      await bot.sendMessage(chatId, "The button failed. Check Railway logs for the error.");
    }
  });

  bot.on("polling_error", (error) => {
    console.error("Telegram polling error:", error.message);
  });

  let deliveryBusy = false;
  async function deliverDevelopmentReplies() {
    if (!devCompanion || deliveryBusy) return;
    deliveryBusy = true;
    try {
      if (Number.isSafeInteger(environment.telegramAllowedUserId) && environment.telegramAllowedUserId > 0) {
        const snapshot = await devCompanion.status(environment.telegramAllowedUserId);
        if (snapshot.active && (snapshot.pending > 0 || snapshot.processing > 0)) {
          await sendTyping(environment.telegramAllowedUserId);
        }
      }
      const deliveries = await devCompanion.pendingDeliveries(environment.telegramAllowedUserId, 5);
      for (const delivery of deliveries) {
        const text = delivery.status === "COMPLETED"
          ? delivery.outputText
          : "The OpenAI request failed. The trading bot was not affected. Check the companion worker logs.";
        await bot.sendMessage(environment.telegramAllowedUserId, text);
        await devCompanion.markDelivered(delivery.id, environment.telegramAllowedUserId);
      }
    } catch (error) {
      console.error("Development reply delivery failed:", error.message);
    } finally {
      deliveryBusy = false;
    }
  }

  const devDeliveryTimer = devCompanion
    ? setInterval(() => void deliverDevelopmentReplies(), 1500)
    : null;
  devDeliveryTimer?.unref?.();
  if (devCompanion) void deliverDevelopmentReplies();

  await bot.setMyCommands([
    { command: "status", description: "Show bot and risk status" },
    { command: "health", description: "Check worker and database" },
    { command: "levels", description: "Show all SOL grid levels and sizes" },
    { command: "rings", description: "Show live SOL position versus grid rings" },
    { command: "dxpreflight", description: "Inspect active instrument settings" },
    { command: "solcanary", description: "Inspect approved 0.01 SOL lifecycle canary" },
    { command: "kill", description: "Pause the bot" },
    { command: "resume", description: "Request a resume code" },
    { command: "flat", description: "Show flattening instructions" },
    { command: "code", description: "Enter OpenAI development mode" },
    { command: "devstatus", description: "Show development companion status" },
    { command: "devreset", description: "Reset development conversation" },
    { command: "devexit", description: "Leave development mode" },
    { command: "whoami", description: "Show your Telegram user ID" },
    { command: "help", description: "Show commands" }
  ]);

  bot.stopDevCompanionDelivery = () => {
    if (devDeliveryTimer) clearInterval(devDeliveryTimer);
  };

  return bot;
}
