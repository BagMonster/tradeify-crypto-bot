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
  "/re-run - clear a production runtime-error halt when every book already matches",
  "/confirmrerun CODE - type the code; not a button",
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
  "Reads can cover all five books. Resume, reconcile and rematch always name one book. /re-run is account-wide. Confirm codes are typed. There is no confirm button.",
  CHRONICLE_DEV_BLURB
].join("\n");
