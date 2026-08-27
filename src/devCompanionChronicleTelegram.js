export const CHRONICLE_HELP_LINES = Object.freeze([
  "/chroniclestatus - show the chronicle publishing kill switch",
  "/chroniclepause - emergency-stop autonomous chronicle publishing",
  "/chronicleresume - re-arm the chronicle publishing kill switch"
]);

export const CHRONICLE_COMMANDS = Object.freeze([
  { command: "chroniclestatus", description: "Show chronicle publish kill switch" },
  { command: "chroniclepause", description: "Pause autonomous chronicle publishing" },
  { command: "chronicleresume", description: "Re-arm chronicle publishing kill switch" }
]);

export const CHRONICLE_DEV_BLURB =
  "Development mode can inspect this repo and, when enabled, publish chronicle Markdown only. /chroniclepause is an emergency stop, not editorial review. Nothing here deploys Railway or places trades.";

export function attachChronicleCommands({ bot, devCompanion, withAuthorization, sendLatched }) {
  bot.onText(/^\/chroniclestatus(?:@\w+)?$/i, withAuthorization(async (message) => {
    if (typeof devCompanion?.chronicleStatus !== "function") {
      return bot.sendMessage(message.chat.id, "Chronicle control is not configured on this deployment.");
    }
    const result = await devCompanion.chronicleStatus();
    await sendLatched(message.chat.id, "/chroniclestatus", result.message);
  }));

  bot.onText(/^\/chroniclepause(?:@\w+)?$/i, withAuthorization(async (message) => {
    if (typeof devCompanion?.chroniclePause !== "function") {
      return bot.sendMessage(message.chat.id, "Chronicle control is not configured on this deployment.");
    }
    const result = await devCompanion.chroniclePause();
    await sendLatched(message.chat.id, "/chroniclepause", result.message);
  }));

  bot.onText(/^\/chronicleresume(?:@\w+)?$/i, withAuthorization(async (message) => {
    if (typeof devCompanion?.chronicleResume !== "function") {
      return bot.sendMessage(message.chat.id, "Chronicle control is not configured on this deployment.");
    }
    const result = await devCompanion.chronicleResume();
    await sendLatched(message.chat.id, "/chronicleresume", result.message);
  }));
}
