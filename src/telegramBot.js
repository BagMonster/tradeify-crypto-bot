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
