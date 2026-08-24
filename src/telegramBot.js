import TelegramBot from "node-telegram-bot-api";

const MAIN_MENU = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "Status", callback_data: "status" },
        { text: "Health", callback_data: "health" }
      ],
      [
        { text: "Pause Bot", callback_data: "kill" },
        { text: "Resume", callback_data: "resume" }
      ],
      [
        { text: "Flat Instructions", callback_data: "flat" },
        { text: "Help", callback_data: "help" }
      ]
    ]
  }
};

const HELP_TEXT = [
  "TRADEIFY BOT COMMANDS",
  "",
  "/status - show account, floors, risk, and readiness",
  "/health - confirm the worker and PostgreSQL are reachable",
  "/dxpreflight - inspect active-instrument order settings without placing an order",
  "/kill - pause the bot and persist the pause",
  "/resume - request a 6-digit resume code",
  "/confirmresume CODE - confirm the restart",
  "/flat - show Stage A manual flattening instructions",
  "/whoami - show your Telegram numeric user ID",
  "/help - show this list",
  "",
  "There are no /long or /short commands in Stage A."
].join("\n");

export async function startTelegramBot({ environment, service }) {
  const bot = new TelegramBot(environment.telegramToken, { polling: true });

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

  bot.onText(/^\/dxpreflight(?:@\w+)?$/i, withAuthorization(async (message) => {
    await bot.sendMessage(message.chat.id, "Running DXtrade validation-only preflight. No order will be placed.");
    await bot.sendMessage(message.chat.id, await service.dxPreflightText());
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

  await bot.setMyCommands([
    { command: "status", description: "Show bot and risk status" },
    { command: "health", description: "Check worker and database" },
    { command: "dxpreflight", description: "Inspect active instrument settings" },
    { command: "kill", description: "Pause the bot" },
    { command: "resume", description: "Request a resume code" },
    { command: "flat", description: "Show flattening instructions" },
    { command: "whoami", description: "Show your Telegram user ID" },
    { command: "help", description: "Show commands" }
  ]);

  return bot;
}
