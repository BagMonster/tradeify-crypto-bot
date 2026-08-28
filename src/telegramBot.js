import TelegramBot from "node-telegram-bot-api";
import {
  attachChronicleCommands,
  CHRONICLE_COMMANDS,
  CHRONICLE_DEV_BLURB,
  CHRONICLE_HELP_LINES
} from "./devCompanionChronicleTelegram.js";

// Every button maps to exactly one action id. Buttons are a shortcut for the
// slash commands, never a replacement: each slash command below still works.
//
// SAFETY RULE: the three confirm* commands are deliberately NOT on this panel.
// /confirmresume, /confirmreconcile and /confirmrematch each require a one-time
// code typed by hand. That friction IS the safety gate. A tap-to-confirm button
// would erase a two-step control down to one thumb press. Buttons may REQUEST a
// code; only the owner typing it can confirm.
const CONFIRM_ONLY_COMMANDS = Object.freeze([
  "confirmresume",
  "confirmreconcile",
  "confirmrematch"
]);

const MENU_LAYOUT = Object.freeze([
  { header: "\u2014 Monitor \u2014" },
  [
    { text: "Status", action: "status" },
    { text: "Health", action: "health" }
  ],
  [
    { text: "Grid Levels", action: "levels" },
    { text: "Ring Position", action: "rings" }
  ],
  { header: "\u2014 Control \u2014" },
  [
    { text: "Pause Bot", action: "kill" },
    { text: "Request Resume", action: "resume" }
  ],
  [
    { text: "Request Reconcile", action: "reconcile" },
    { text: "Request Rematch", action: "rematch" }
  ],
  { header: "\u2014 Diagnostics \u2014" },
  [
    { text: "DX Preflight", action: "dxpreflight" },
    { text: "SOL Canary", action: "solcanary" }
  ],
  [
    { text: "Flat Instructions", action: "flat" },
    { text: "Who Am I", action: "whoami" }
  ],
  { header: "\u2014 Chronicle \u2014" },
  [
    { text: "Chronicle Status", action: "chroniclestatus" },
    { text: "Chronicle Pause", action: "chroniclepause" }
  ],
  [
    { text: "Chronicle Resume", action: "chronicleresume" }
  ],
  { header: "\u2014 Development \u2014" },
  [
    { text: "Enter Dev Mode", action: "code" },
    { text: "Dev Status", action: "devstatus" }
  ],
  [
    { text: "Dev Reset", action: "devreset" },
    { text: "Dev Exit", action: "devexit" }
  ],
  [
    { text: "Help", action: "help" },
    { text: "Refresh Panel", action: "menu" }
  ]
]);

export function buildMenuKeyboard(layout = MENU_LAYOUT) {
  return layout.map((row) => (
    Array.isArray(row)
      ? row.map((b) => ({ text: b.text, callback_data: b.action }))
      : [{ text: row.header, callback_data: "noop" }]
  ));
}

export function menuActionIds(layout = MENU_LAYOUT) {
  return layout
    .filter((row) => Array.isArray(row))
    .flat()
    .map((b) => b.action);
}

const MAIN_MENU = {
  reply_markup: { inline_keyboard: buildMenuKeyboard() }
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
  "/reconcile - request a 6-digit code to flatten stale virtual lots when DXtrade is flat",
  "/confirmreconcile CODE - apply the audited virtual flatten and clear the reconciliation halt",
  "/rematch - request a 6-digit code to keep current lots when DXtrade and the notebook already agree",
  "/confirmrematch CODE - clear the reconciliation halt, keep the live lot, and lift the operator pause",
  "/flat - show manual SOL/USD flattening instructions",
  ...CHRONICLE_HELP_LINES,
  "/code - enter the owner-only OpenAI development conversation",
  "/devstatus - show development companion queue/session status",
  "/devreset - reset OpenAI conversation context and remain in development mode",
  "/devexit - leave development mode",
  "/whoami - show your Telegram numeric user ID",
  "/b - show every command as tappable buttons (/buttons, /menu do the same)",
  "/help - show this list",
  "",
  "There are no /long or /short commands. /levels and /rings are read-only. The frozen SOL grid trades automatically only when both live execution controls are ON and every safety gate passes.",
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
    await bot.sendMessage(chatId, text);
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

  // /b is the shortcut the owner asked for: show every button at once.
  // It ADDS to the slash commands; it does not replace any of them.
  bot.onText(/^\/(b|buttons|menu)(?:@\w+)?$/i, withAuthorization(async (message) => {
    await sendMenu(message.chat.id, "Tap a command. Every slash command still works.");
  }));

  bot.onText(/^\/(start|help)(?:@\w+)?$/i, withAuthorization(async (message) => {
    await bot.sendMessage(message.chat.id, HELP_TEXT);
    await sendMenu(message.chat.id);
  }));

  bot.onText(/^\/status(?:@\w+)?$/i, withAuthorization(async (message) => {
    await sendLatched(message.chat.id, "/status", await service.statusText());
  }));

  bot.onText(/^\/health(?:@\w+)?$/i, withAuthorization(async (message) => {
    await sendLatched(message.chat.id, "/health", await service.healthText());
  }));

  bot.onText(/^\/levels(?:@\w+)?$/i, withAuthorization(async (message) => {
    await sendLatched(message.chat.id, "/levels", await service.levelsText());
  }));

  bot.onText(/^\/rings(?:@\w+)?$/i, withAuthorization(async (message) => {
    await sendLatched(message.chat.id, "/rings", await service.ringsText());
  }));

  bot.onText(/^\/dxpreflight(?:@\w+)?$/i, withAuthorization(async (message) => {
    await bot.sendMessage(message.chat.id, "Running DXtrade validation-only preflight. No order will be placed.");
    await sendLatched(message.chat.id, "/dxpreflight", await service.dxPreflightText());
  }));

  bot.onText(/^\/solcanary(?:@\w+)?$/i, withAuthorization(async (message) => {
    await bot.sendMessage(message.chat.id, "Checking the owner-approved 0.01 SOL lifecycle canary. It can run only while automatic execution is OFF.");
    await sendLatched(message.chat.id, "/solcanary", await service.canaryText());
  }));

  bot.onText(/^\/kill(?:@\w+)?$/i, withAuthorization(async (message) => {
    await sendLatched(message.chat.id, "/kill", await service.kill());
  }));

  bot.onText(/^\/resume(?:@\w+)?$/i, withAuthorization(async (message) => {
    const result = await service.requestResume();
    await sendLatched(message.chat.id, "/resume", result.message);
  }));

  bot.onText(/^\/confirmresume(?:@\w+)?(?:\s+(\S+))?$/i, withAuthorization(async (message, match) => {
    await sendLatched(message.chat.id, "/confirmresume", await service.confirmResume(match?.[1] ?? ""));
  }));

  bot.onText(/^\/reconcile(?:@\w+)?$/i, withAuthorization(async (message) => {
    const result = await service.requestReconcile();
    await sendLatched(message.chat.id, "/reconcile", result.message);
  }));

  bot.onText(/^\/confirmreconcile(?:@\w+)?(?:\s+(\S+))?$/i, withAuthorization(async (message, match) => {
    await sendLatched(message.chat.id, "/confirmreconcile", await service.confirmReconcile(match?.[1] ?? ""));
  }));

  bot.onText(/^\/rematch(?:@\w+)?$/i, withAuthorization(async (message) => {
    const result = await service.requestRematch();
    await sendLatched(message.chat.id, "/rematch", result.message);
  }));

  bot.onText(/^\/confirmrematch(?:@\w+)?(?:\s+(\S+))?$/i, withAuthorization(async (message, match) => {
    await sendLatched(message.chat.id, "/confirmrematch", await service.confirmRematch(match?.[1] ?? ""));
  }));

  attachChronicleCommands({ bot, devCompanion, withAuthorization, sendLatched });

  bot.onText(/^\/flat(?:@\w+)?$/i, withAuthorization(async (message) => {
    await sendLatched(message.chat.id, "/flat", service.flatInstructions());
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

  // Single source of truth. Both the button panel and the slash commands route
  // through this table, so a button can never do something different from the
  // command it is labelled with.
  const MENU_ACTIONS = {
    status: (chatId) => runLatched(chatId, "/status", () => service.statusText()),
    health: (chatId) => runLatched(chatId, "/health", () => service.healthText()),
    levels: (chatId) => runLatched(chatId, "/levels", () => service.levelsText()),
    rings: (chatId) => runLatched(chatId, "/rings", () => service.ringsText()),
    flat: (chatId) => sendLatched(chatId, "/flat", service.flatInstructions()),
    kill: (chatId) => runLatched(chatId, "/kill", () => service.kill()),
    resume: async (chatId) => {
      const result = await service.requestResume();
      await sendLatched(chatId, "/resume", result.message);
    },
    reconcile: async (chatId) => {
      const result = await service.requestReconcile();
      await sendLatched(chatId, "/reconcile", result.message);
    },
    rematch: async (chatId) => {
      const result = await service.requestRematch();
      await sendLatched(chatId, "/rematch", result.message);
    },
    dxpreflight: async (chatId) => {
      await bot.sendMessage(chatId, "Running DXtrade validation-only preflight. No order will be placed.");
      await sendLatched(chatId, "/dxpreflight", await service.dxPreflightText());
    },
    solcanary: async (chatId) => {
      await bot.sendMessage(chatId, "Checking the owner-approved 0.01 SOL lifecycle canary. It can run only while automatic execution is OFF.");
      await sendLatched(chatId, "/solcanary", await service.canaryText());
    },
    chroniclestatus: (chatId) => runChronicle(chatId, "chronicleStatus", "/chroniclestatus"),
    chroniclepause: (chatId) => runChronicle(chatId, "chroniclePause", "/chroniclepause"),
    chronicleresume: (chatId) => runChronicle(chatId, "chronicleResume", "/chronicleresume"),
    code: (chatId) => enterDevelopment(chatId),
    devstatus: async (chatId) => {
      if (!devCompanion) return bot.sendMessage(chatId, "Development companion is not configured on this deployment.");
      await bot.sendMessage(chatId, devStatusText(await devCompanion.status(environment.telegramAllowedUserId)));
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
    help: (chatId) => bot.sendMessage(chatId, HELP_TEXT),
    menu: (chatId) => sendMenu(chatId, "Tap a command. Every slash command still works."),
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
    const action = typeof query.data === "string" ? query.data : "";

    // A confirm* action must never be reachable from a tap, even if a stale or
    // forged payload names one. Confirmation requires a typed one-time code.
    if (CONFIRM_ONLY_COMMANDS.includes(action)) {
      await bot.answerCallbackQuery(query.id, { text: "Type the code to confirm.", show_alert: true });
      if (!isAuthorized(query.from)) return deny(chatId);
      return bot.sendMessage(
        chatId,
        `Confirmation cannot be done with a button. Send /${action} CODE using the code from the request above.`
      );
    }

    await bot.answerCallbackQuery(query.id);
    if (!isAuthorized(query.from)) return deny(chatId);

    const handler = MENU_ACTIONS[action];
    if (!handler) return bot.sendMessage(chatId, "Unknown button. Send /help or /b.");
    try {
      await handler(chatId, query);
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
    { command: "reconcile", description: "Request a virtual flatten code" },
    { command: "rematch", description: "Rematch broker and virtual books" },
    { command: "flat", description: "Show flattening instructions" },
    ...CHRONICLE_COMMANDS,
    { command: "code", description: "Enter OpenAI development mode" },
    { command: "devstatus", description: "Show development companion status" },
    { command: "devreset", description: "Reset development conversation" },
    { command: "devexit", description: "Leave development mode" },
    { command: "whoami", description: "Show your Telegram user ID" },
    { command: "b", description: "Show every command as buttons" },
    { command: "help", description: "Show commands" }
  ]);

  bot.stopDevCompanionDelivery = () => {
    if (devDeliveryTimer) clearInterval(devDeliveryTimer);
  };

  return bot;
}
