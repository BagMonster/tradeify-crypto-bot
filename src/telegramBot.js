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
