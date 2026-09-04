import TelegramBot from "node-telegram-bot-api";
import {
  attachChronicleCommands,
  CHRONICLE_COMMANDS,
  CHRONICLE_DEV_BLURB,
  CHRONICLE_HELP_LINES
} from "./devCompanionChronicleTelegram.js";
import { splitTelegramText } from "./telegramMessageSplit.js";
import {
  CONFIRM_ONLY_COMMANDS,
  bookSymbolsFrom,
  buildMenuKeyboard,
  instrumentArg,
  keyboardForView,
  menuActionIds,
  panelLead,
  parseMenuCallback
} from "./telegramMenu.js";

export { buildMenuKeyboard, menuActionIds, CONFIRM_ONLY_COMMANDS };

const HELP_TEXT = [
  "TRADEIFY BOT COMMANDS",
  "",
  "/status [INSTRUMENT] - account risk, then every book; add SOL or AAVE for one book",
  "/health [INSTRUMENT] - worker, PostgreSQL, MA, execution",
  "/levels [INSTRUMENT] - ring ladder; omit for all five",
  "/rings [INSTRUMENT] - where price sits versus each book",
  "/dxpreflight - inspect order settings without placing an order",
  "/canary - inspect the lifecycle canary; only while automatic execution is OFF",
  "/kill - pause every book",
  "/resume INSTRUMENT - request a 6-digit resume code for one book",
  "/confirmresume CODE INSTRUMENT - type the code; not a button",
  "/reconcile INSTRUMENT - request a flatten-virtual-lots code for one book",
  "/confirmreconcile CODE INSTRUMENT - type the code; not a button",
  "/rematch INSTRUMENT - request a keep-lots rematch code for one book",
  "/confirmrematch CODE INSTRUMENT - type the code; not a button",
  "/flat [INSTRUMENT] - manual flattening instructions",
  ...CHRONICLE_HELP_LINES,
  "/code - enter the owner-only OpenAI development conversation",
  "/devstatus - development companion queue",
  "/devreset - reset companion context",
  "/devexit - leave development mode",
  "/whoami - your Telegram numeric user ID",
  "/b - five-book button panel (/buttons, /menu do the same)",
  "/help - this list",
  "",
  "Reads can cover all five books. Resume, reconcile and rematch always name one book. Confirm codes are typed. There is no confirm button.",
  CHRONICLE_DEV_BLURB
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
    "Phase 2c: read-only GitHub inspection on this repo"
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
  const books = bookSymbolsFrom(service);

  async function sendText(chatId, text, options) {
    const chunks = splitTelegramText(text);
    let last = null;
    for (const chunk of chunks) {
      last = options === undefined
        ? await bot.sendMessage(chatId, chunk)
        : await bot.sendMessage(chatId, chunk, options);
    }
    return last;
  }

  if (notifications !== null) {
    if (typeof notifications?.setSender !== "function") throw new TypeError("notifications.setSender must be a function");
    notifications.setSender(async (text) => {
      if (!Number.isSafeInteger(environment.telegramAllowedUserId) || environment.telegramAllowedUserId <= 0) {
        throw new Error("Owner Telegram destination is unavailable");
      }
      await sendText(environment.telegramAllowedUserId, text);
      if (typeof devCompanion?.appendOperatorAlert === "function") {
        try {
          await devCompanion.appendOperatorAlert(environment.telegramAllowedUserId, text);
        } catch (error) {
          console.error("Live alert latch failed:", error.message);
        }
      }
    });
  }

  if (devCompanion !== null) {
    const required = [
      "setSessionActive",
      "isSessionActive",
      "resetSession",
      "enqueue",
      "pendingDeliveries",
      "markDelivered",
      "status",
      "saveOperatorSnapshot",
      "latestOperatorSnapshot"
    ];
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

  async function showPanel(chatId, view, symbol = null, query = null) {
    const text = panelLead(view, symbol);
    const markup = {
      reply_markup: { inline_keyboard: keyboardForView(view, { symbol, books }) }
    };
    if (query?.message?.message_id) {
      try {
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: query.message.message_id,
          ...markup
        });
        return;
      } catch {
      }
    }
    return bot.sendMessage(chatId, text, markup);
  }

  async function sendMenu(chatId, _lead) {
    return showPanel(chatId, "home");
  }

  async function sendTyping(chatId) {
    if (typeof bot.sendChatAction !== "function") return;
    try {
      await bot.sendChatAction(chatId, "typing");
    } catch (error) {
      console.error("Telegram typing indicator failed:", error.message);
    }
  }

  async function latchOperatorOutput(command, text) {
    if (!devCompanion) return;
    try {
      if (!(await devCompanion.isSessionActive(environment.telegramAllowedUserId))) return;
      await devCompanion.saveOperatorSnapshot(environment.telegramAllowedUserId, command, text);
    } catch (error) {
      console.error("Operator snapshot latch failed:", error.message);
    }
  }

  async function sendLatched(chatId, command, text) {
    await sendText(chatId, text);
    await latchOperatorOutput(command, text);
  }

  async function queueDevelopmentMessage(chatId, text) {
    const snapshot = await devCompanion.latestOperatorSnapshot(environment.telegramAllowedUserId);
    const payload = snapshot?.text
      ? [snapshot.text, "---", "Owner message:", text].join("\n\n")
      : text;
    await devCompanion.enqueue(environment.telegramAllowedUserId, payload);
    await sendTyping(chatId);
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

  bot.onText(/^\/(b|buttons|menu)(?:@\w+)?$/i, withAuthorization(async (message) => {
    await showPanel(message.chat.id, "home");
  }));

  bot.onText(/^\/(start|help)(?:@\w+)?$/i, withAuthorization(async (message) => {
    await sendText(message.chat.id, HELP_TEXT);
    await showPanel(message.chat.id, "home");
  }));

  bot.onText(/^\/status(?:@\w+)?(?:\s+(\S+))?$/i, withAuthorization(async (message, match) => {
    await sendLatched(message.chat.id, "/status", await service.statusText(match?.[1]));
  }));

  bot.onText(/^\/health(?:@\w+)?(?:\s+(\S+))?$/i, withAuthorization(async (message, match) => {
    await sendLatched(message.chat.id, "/health", await service.healthText(match?.[1]));
  }));

  bot.onText(/^\/levels(?:@\w+)?(?:\s+(\S+))?$/i, withAuthorization(async (message, match) => {
    await sendLatched(message.chat.id, "/levels", await service.levelsText(match?.[1]));
  }));

  bot.onText(/^\/rings(?:@\w+)?(?:\s+(\S+))?$/i, withAuthorization(async (message, match) => {
    await sendLatched(message.chat.id, "/rings", await service.ringsText(match?.[1]));
  }));

  bot.onText(/^\/dxpreflight(?:@\w+)?$/i, withAuthorization(async (message) => {
    await bot.sendMessage(message.chat.id, "Running DXtrade validation-only preflight. No order will be placed.");
    await sendLatched(message.chat.id, "/dxpreflight", await service.dxPreflightText());
  }));

  bot.onText(/^\/solcanary(?:@\w+)?$/i, withAuthorization(async (message) => {
    await bot.sendMessage(message.chat.id, "Checking the owner-approved 0.01-lot lifecycle canary. It can run only while automatic execution is OFF.");
    await sendLatched(message.chat.id, "/solcanary", await service.canaryText());
  }));

  bot.onText(/^\/kill(?:@\w+)?$/i, withAuthorization(async (message) => {
    await sendLatched(message.chat.id, "/kill", await service.kill());
  }));

  bot.onText(/^\/resume(?:@\w+)?(?:\s+(\S+))?$/i, withAuthorization(async (message, match) => {
    const result = await service.requestResume(match?.[1]);
    await sendLatched(message.chat.id, "/resume", result.message);
  }));

  bot.onText(/^\/confirmresume(?:@\w+)?(?:\s+(\S+))?(?:\s+(\S+))?$/i, withAuthorization(async (message, match) => {
    await sendLatched(message.chat.id, "/confirmresume", await service.confirmResume(match?.[1] ?? "", match?.[2]));
  }));

  bot.onText(/^\/reconcile(?:@\w+)?(?:\s+(\S+))?$/i, withAuthorization(async (message, match) => {
    const result = await service.requestReconcile(match?.[1]);
    await sendLatched(message.chat.id, "/reconcile", result.message);
  }));

  bot.onText(/^\/confirmreconcile(?:@\w+)?(?:\s+(\S+))?(?:\s+(\S+))?$/i, withAuthorization(async (message, match) => {
    await sendLatched(message.chat.id, "/confirmreconcile", await service.confirmReconcile(match?.[1] ?? "", match?.[2]));
  }));

  bot.onText(/^\/rematch(?:@\w+)?(?:\s+(\S+))?$/i, withAuthorization(async (message, match) => {
    const result = await service.requestRematch(match?.[1]);
    await sendLatched(message.chat.id, "/rematch", result.message);
  }));

  bot.onText(/^\/confirmrematch(?:@\w+)?(?:\s+(\S+))?(?:\s+(\S+))?$/i, withAuthorization(async (message, match) => {
    await sendLatched(message.chat.id, "/confirmrematch", await service.confirmRematch(match?.[1] ?? "", match?.[2]));
  }));

  attachChronicleCommands({ bot, devCompanion, withAuthorization, sendLatched });

  bot.onText(/^\/flat(?:@\w+)?(?:\s+(\S+))?$/i, withAuthorization(async (message, match) => {
    await sendLatched(message.chat.id, "/flat", await service.flatInstructions(match?.[1]));
  }));

  bot.onText(/^\/code(?:@\w+)?$/i, withAuthorization(async (message) => {
    await enterDevelopment(message.chat.id);
  }));

  bot.onText(/^\/devstatus(?:@\w+)?$/i, withAuthorization(async (message) => {
    if (!devCompanion) return bot.sendMessage(message.chat.id, "Development companion is not configured on this deployment.");
    await sendText(message.chat.id, devStatusText(await devCompanion.status(environment.telegramAllowedUserId)));
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

  bot.on("message", async (message) => {
    if (!devCompanion || !isAuthorized(message.from)) return;
    const text = typeof message.text === "string" ? message.text.trim() : "";
    if (!text || text.startsWith("/")) return;
    try {
      if (!(await devCompanion.isSessionActive(environment.telegramAllowedUserId))) return;
      await queueDevelopmentMessage(message.chat.id, text);
    } catch (error) {
      console.error("Development message routing failed:", error.message);
      await bot.sendMessage(message.chat.id, "The development request could not be queued. Check Railway logs.");
    }
  });

  const MENU_ACTIONS = {
    status: (chatId, _query, symbol) => runLatched(chatId, "/status", () => service.statusText(instrumentArg(symbol))),
    health: (chatId, _query, symbol) => runLatched(chatId, "/health", () => service.healthText(instrumentArg(symbol))),
    levels: (chatId, _query, symbol) => runLatched(chatId, "/levels", () => service.levelsText(instrumentArg(symbol))),
    rings: (chatId, _query, symbol) => runLatched(chatId, "/rings", () => service.ringsText(instrumentArg(symbol))),
    flat: (chatId, _query, symbol) => runLatched(chatId, "/flat", () => service.flatInstructions(instrumentArg(symbol))),
    kill: (chatId) => runLatched(chatId, "/kill", () => service.kill()),
    resume: async (chatId, _query, symbol) => {
      const result = await service.requestResume(instrumentArg(symbol));
      await sendLatched(chatId, "/resume", result.message);
    },
    reconcile: async (chatId, _query, symbol) => {
      const result = await service.requestReconcile(instrumentArg(symbol));
      await sendLatched(chatId, "/reconcile", result.message);
    },
    rematch: async (chatId, _query, symbol) => {
      const result = await service.requestRematch(instrumentArg(symbol));
      await sendLatched(chatId, "/rematch", result.message);
    },
    dxpreflight: async (chatId) => {
      await bot.sendMessage(chatId, "Running DXtrade validation-only preflight. No order will be placed.");
      await sendLatched(chatId, "/dxpreflight", await service.dxPreflightText());
    },
    solcanary: async (chatId) => {
      await bot.sendMessage(chatId, "Checking the owner-approved 0.01-lot lifecycle canary. It can run only while automatic execution is OFF.");
      await sendLatched(chatId, "/solcanary", await service.canaryText());
    },
    chroniclestatus: (chatId) => runChronicle(chatId, "chronicleStatus", "/chroniclestatus"),
    chroniclepause: (chatId) => runChronicle(chatId, "chroniclePause", "/chroniclepause"),
    chronicleresume: (chatId) => runChronicle(chatId, "chronicleResume", "/chronicleresume"),
    code: (chatId) => enterDevelopment(chatId),
    devstatus: async (chatId) => {
      if (!devCompanion) return bot.sendMessage(chatId, "Development companion is not configured on this deployment.");
      await sendText(chatId, devStatusText(await devCompanion.status(environment.telegramAllowedUserId)));
    },
    devreset: async (chatId) => {
      if (!devCompanion) return bot.sendMessage(chatId, "Development companion is not configured on this deployment.");
      await devCompanion.resetSession(environment.telegramAllowedUserId);
      await bot.sendMessage(chatId, "Development conversation reset. OpenAI context is fresh and development mode remains ACTIVE.");
    },
    devexit: async (chatId) => {
      if (!devCompanion) return bot.sendMessage(chatId, "Development companion is not configured on this deployment.");
      await devCompanion.setSessionActive(environment.telegramAllowedUserId, false);
      await bot.sendMessage(chatId, "OpenAI development mode is OFF. Trading commands continue to work normally.");
    },
    whoami: (chatId, query) => bot.sendMessage(chatId, `Your Telegram user ID is: ${query?.from?.id ?? "unknown"}`),
    help: (chatId) => sendText(chatId, HELP_TEXT),
    menu: (chatId, query) => showPanel(chatId, "home", null, query),
    noop: async () => {}
  };

  async function runLatched(chatId, command, produce) {
    await sendLatched(chatId, command, await produce());
  }

  async function runChronicle(chatId, method, command) {
    if (typeof devCompanion?.[method] !== "function") {
      return bot.sendMessage(chatId, "Chronicle control is not configured on this deployment.");
    }
    const result = await devCompanion[method]();
    await sendLatched(chatId, command, result?.message ?? String(result));
  }

  bot.on("callback_query", async (query) => {
    const chatId = query.message?.chat?.id;
    if (!chatId) return;
    const parsed = parseMenuCallback(typeof query.data === "string" ? query.data : "");

    if (parsed.kind === "confirm") {
      await bot.answerCallbackQuery(query.id, { text: "Type the code to confirm.", show_alert: true });
      if (!isAuthorized(query.from)) return deny(chatId);
      return bot.sendMessage(
        chatId,
        `Confirmation cannot be done with a button. Send /${parsed.action} CODE INSTRUMENT using the code from the request above.`
      );
    }

    if (!isAuthorized(query.from)) {
      try { await bot.answerCallbackQuery(query.id); } catch { /* already answered or stale */ }
      return deny(chatId);
    }

    try { await bot.answerCallbackQuery(query.id); } catch { /* stale query */ }

    if (parsed.kind === "noop") return;
    if (parsed.kind === "view") {
      try {
        await showPanel(chatId, parsed.view, parsed.symbol ?? null, query);
      } catch (error) {
        console.error("Telegram panel failed:", error.message);
        await bot.sendMessage(chatId, "The panel failed. Send /b again.");
      }
      return;
    }
    if (parsed.kind !== "command") {
      return bot.sendMessage(chatId, "Unknown button. Send /help or /b.");
    }

    const handler = MENU_ACTIONS[parsed.action];
    if (!handler) return bot.sendMessage(chatId, "Unknown button. Send /help or /b.");
    try {
      await handler(chatId, query, parsed.symbol);
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
        await sendText(environment.telegramAllowedUserId, text);
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
    { command: "levels", description: "Show ring levels" },
    { command: "rings", description: "Show live position versus rings" },
    { command: "dxpreflight", description: "Inspect instrument settings" },
    { command: "solcanary", description: "Inspect approved lifecycle canary" },
    { command: "kill", description: "Pause every book" },
    { command: "resume", description: "Request a resume code for one book" },
    { command: "reconcile", description: "Request a virtual flatten code" },
    { command: "rematch", description: "Rematch one book" },
    { command: "flat", description: "Show flattening instructions" },
    ...CHRONICLE_COMMANDS,
    { command: "code", description: "Enter OpenAI development mode" },
    { command: "devstatus", description: "Show development companion status" },
    { command: "devreset", description: "Reset development conversation" },
    { command: "devexit", description: "Leave development mode" },
    { command: "whoami", description: "Show your Telegram user ID" },
    { command: "b", description: "Five-book button panel" },
    { command: "help", description: "Show commands" }
  ]);

  bot.stopDevCompanionDelivery = () => {
    if (devDeliveryTimer) clearInterval(devDeliveryTimer);
  };

  return bot;
}
