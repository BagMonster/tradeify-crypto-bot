/**
 * Telegram /b panel for the five live books.
 *
 * Home is the map. Each book is its own screen so Resume / Reconcile / Rematch
 * always name one instrument. Confirm* commands are never buttons.
 */

export const DEFAULT_BOOKS = Object.freeze(["SOL", "DOGE", "INJ", "AAVE", "AVAX"]);

export const CONFIRM_ONLY_COMMANDS = Object.freeze([
  "confirmresume",
  "confirmreconcile",
  "confirmrematch",
  "confirmrerun"
]);

const BOOK_PATTERN = /^[A-Z0-9]{2,8}$/;

function btn(text, action) {
  return { text, callback_data: action };
}

function header(label) {
  return [btn(label, "noop")];
}

function pair(left, right) {
  return right ? [left, right] : [left];
}

export function bookSymbolsFrom(service) {
  const list = Array.isArray(service?.instruments) ? service.instruments : [];
  const symbols = list
    .map((value) => String(value ?? "").trim().toUpperCase().split("/")[0])
    .filter((value) => BOOK_PATTERN.test(value));
  return symbols.length > 0 ? Object.freeze(symbols) : DEFAULT_BOOKS;
}

export function instrumentArg(symbol) {
  if (typeof symbol !== "string" || !BOOK_PATTERN.test(symbol)) return null;
  return `${symbol}/USD`;
}

export function parseMenuCallback(data) {
  if (typeof data !== "string" || data.trim() === "") {
    return Object.freeze({ kind: "unknown", raw: "" });
  }
  const raw = data.trim();
  if (CONFIRM_ONLY_COMMANDS.includes(raw) || CONFIRM_ONLY_COMMANDS.includes(raw.split(":")[0])) {
    return Object.freeze({ kind: "confirm", raw, action: raw.split(":")[0] });
  }
  if (raw === "noop") return Object.freeze({ kind: "noop", raw });
  if (raw === "menu" || raw === "view:home") return Object.freeze({ kind: "view", view: "home", raw });
  if (raw === "view:diag") return Object.freeze({ kind: "view", view: "diag", raw });
  if (raw === "view:chronicle") return Object.freeze({ kind: "view", view: "chronicle", raw });
  if (raw === "view:dev") return Object.freeze({ kind: "view", view: "dev", raw });
  if (raw.startsWith("book:")) {
    const symbol = raw.slice(5);
    if (!BOOK_PATTERN.test(symbol)) return Object.freeze({ kind: "unknown", raw });
    return Object.freeze({ kind: "view", view: "book", symbol, raw });
  }
  const cut = raw.indexOf(":");
  if (cut > 0) {
    const action = raw.slice(0, cut);
    const symbol = raw.slice(cut + 1);
    if (!BOOK_PATTERN.test(symbol)) return Object.freeze({ kind: "unknown", raw });
    return Object.freeze({ kind: "command", action, symbol, raw });
  }
  return Object.freeze({ kind: "command", action: raw, symbol: null, raw });
}

export function buildHomeKeyboard(books = DEFAULT_BOOKS) {
  const bookRows = [];
  for (let i = 0; i < books.length; i += 2) {
    const a = btn(books[i], `book:${books[i]}`);
    const b = books[i + 1] ? btn(books[i + 1], `book:${books[i + 1]}`) : null;
    bookRows.push(pair(a, b));
  }
  return [
    header("\u2014 Account \u2014"),
    pair(btn("All Status", "status"), btn("All Health", "health")),
    pair(btn("All Rings", "rings"), btn("All Levels", "levels")),
    pair(btn("Pause Bot", "kill"), btn("Re-run Halt", "rerun")),
    pair(btn("Flatten Info", "flat"), btn("Help", "help")),
    header("\u2014 Open a book \u2014"),
    ...bookRows,
    header("\u2014 More \u2014"),
    pair(btn("Diagnostics", "view:diag"), btn("Chronicle", "view:chronicle")),
    pair(btn("Development", "view:dev"), btn("Help", "help"))
  ];
}

export function buildBookKeyboard(symbol) {
  const tag = String(symbol ?? "").toUpperCase();
  if (!BOOK_PATTERN.test(tag)) throw new TypeError("book symbol is invalid");
  return [
    header(`\u2014 ${tag}/USD \u2014`),
    pair(btn("Status", `status:${tag}`), btn("Health", `health:${tag}`)),
    pair(btn("Rings", `rings:${tag}`), btn("Levels", `levels:${tag}`)),
    pair(btn("Request Resume", `resume:${tag}`), btn("Request Reconcile", `reconcile:${tag}`)),
    pair(btn("Request Rematch", `rematch:${tag}`), btn("Flatten Info", `flat:${tag}`)),
    pair(btn("\u00ab All books", "menu"), btn("Help", "help"))
  ];
}

export function buildDiagKeyboard() {
  return [
    header("\u2014 Diagnostics \u2014"),
    pair(btn("DX Preflight", "dxpreflight"), btn("Canary", "solcanary")),
    pair(btn("Who Am I", "whoami"), btn("Refresh", "menu")),
    [btn("\u00ab All books", "menu")]
  ];
}

export function buildChronicleKeyboard() {
  return [
    header("\u2014 Chronicle \u2014"),
    pair(btn("Chronicle Status", "chroniclestatus"), btn("Chronicle Pause", "chroniclepause")),
    pair(btn("Chronicle Resume", "chronicleresume"), btn("\u00ab All books", "menu"))
  ];
}

export function buildDevKeyboard() {
  return [
    header("\u2014 Development \u2014"),
    pair(btn("Enter Dev Mode", "code"), btn("Dev Status", "devstatus")),
    pair(btn("Dev Reset", "devreset"), btn("Dev Exit", "devexit")),
    [btn("\u00ab All books", "menu")]
  ];
}

export function buildMenuKeyboard(books = DEFAULT_BOOKS) {
  return buildHomeKeyboard(books);
}

export function keyboardForView(view, { symbol, books = DEFAULT_BOOKS } = {}) {
  if (view === "book") return buildBookKeyboard(symbol);
  if (view === "diag") return buildDiagKeyboard();
  if (view === "chronicle") return buildChronicleKeyboard();
  if (view === "dev") return buildDevKeyboard();
  return buildHomeKeyboard(books);
}

export function panelLead(view, symbol) {
  if (view === "book") {
    return `${symbol}/USD \u2014 tap a command. Resume / reconcile / rematch send a code. Type the code to confirm; there is no confirm button.`;
  }
  if (view === "diag") return "Diagnostics \u2014 preflight and canary do not place a live grid order.";
  if (view === "chronicle") return "Chronicle controls.";
  if (view === "dev") return "Development companion. This does not place trades.";
  return "Tradeify \u2014 5 live books. Open a coin for that book\u2019s controls.";
}

export function menuActionIds(books = DEFAULT_BOOKS) {
  const ids = new Set(["noop", "menu", "view:home", "view:diag", "view:chronicle", "view:dev"]);
  for (const rows of [
    buildHomeKeyboard(books),
    buildDiagKeyboard(),
    buildChronicleKeyboard(),
    buildDevKeyboard(),
    ...books.map((symbol) => buildBookKeyboard(symbol))
  ]) {
    for (const row of rows) {
      for (const button of row) ids.add(button.callback_data);
    }
  }
  return [...ids];
}
