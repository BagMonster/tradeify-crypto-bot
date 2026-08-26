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
  "/reconcile - request a 6-digit code to flatten stale virtual lots when DXtrade is flat",
  "/confirmreconcile CODE - apply the audited virtual flatten and clear the reconciliation halt",
  "/flat - show manual SOL/USD flattening instructions",
  "/code - enter the owner-only OpenAI development conversation",
  "/devstatus - show development companion queue/session status",
  "/devreset - reset OpenAI conversation context and remain in development mode",
  "/devexit - leave development mode",
  "/whoami - show your Telegram numeric user ID",
  "/help - show this list",
  "",
  "There are no /long or /short commands. /levels and /rings are read-only. The frozen SOL grid trades automatically only when both live execution controls are ON and every safety gate passes.",
  "Development mode can inspect BagMonster/tradeify-crypto-bot through /code. It cannot place trades, write GitHub, merge, or deploy."
].join("\n");
