import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildMenuKeyboard, menuActionIds } from "../src/telegramBot.js";
import {
  buildBookKeyboard,
  buildHomeKeyboard,
  instrumentArg,
  parseMenuCallback
} from "../src/telegramMenu.js";

const SOURCE = readFileSync(new URL("../src/telegramBot.js", import.meta.url), "utf8");
const TABLE = SOURCE.slice(SOURCE.indexOf("const MENU_ACTIONS = {"), SOURCE.indexOf("async function runLatched"));

test("home panel lists every live book and account reads", () => {
  const rows = buildHomeKeyboard();
  const labels = rows.flat().map((b) => b.text);
  for (const book of ["SOL", "DOGE", "ZEC", "AAVE", "AVAX"]) {
    assert.ok(labels.includes(book), `${book} missing from home panel`);
  }
  assert.ok(labels.includes("All Status"));
  assert.ok(labels.includes("Pause Bot"));
  assert.equal(rows.find((row) => row[0]?.callback_data === "resume"), undefined, "home must not resume without a book");
});

test("book panel scopes resume/reconcile/rematch to that coin", () => {
  const rows = buildBookKeyboard("AAVE");
  const data = rows.flat().map((b) => b.callback_data);
  assert.ok(data.includes("status:AAVE"));
  assert.ok(data.includes("resume:AAVE"));
  assert.ok(data.includes("reconcile:AAVE"));
  assert.ok(data.includes("rematch:AAVE"));
  assert.ok(data.includes("menu"));
  assert.ok(!data.some((id) => id.startsWith("confirm")));
});

test("command buttons resolve to a MENU_ACTIONS handler", () => {
  for (const raw of menuActionIds()) {
    const parsed = parseMenuCallback(raw);
    if (parsed.kind === "noop" || parsed.kind === "view") continue;
    assert.equal(parsed.kind, "command", raw);
    assert.ok(new RegExp(`(^|[\\s{,])${parsed.action}:`, "m").test(TABLE), `menu action "${parsed.action}" from ${raw} has no handler`);
  }
});

test("no confirmation command is reachable from a button", () => {
  for (const raw of menuActionIds()) {
    const parsed = parseMenuCallback(raw);
    assert.notEqual(parsed.kind, "confirm", raw);
    assert.ok(!String(raw).startsWith("confirm"), raw);
  }
  assert.match(SOURCE, /parsed\.kind === "confirm"/);
  assert.match(SOURCE, /Confirmation cannot be done with a button/);
});

test("button callbacks are owner-authorized before any action runs", () => {
  const handler = SOURCE.slice(SOURCE.indexOf('bot.on("callback_query"'), SOURCE.indexOf('bot.on("polling_error"'));
  assert.ok(handler.indexOf("isAuthorized(query.from)") < handler.indexOf("MENU_ACTIONS[parsed.action]"),
    "authorization must be checked before dispatching an action");
});

test("header rows are inert and every keyboard row is well formed", () => {
  const boards = [buildMenuKeyboard(), buildBookKeyboard("SOL"), buildBookKeyboard("DOGE")];
  for (const rows of boards) {
    const headers = rows.filter((r) => r.length === 1 && r[0].callback_data === "noop");
    assert.ok(headers.length >= 1, "expected a section header");
    for (const row of rows) {
      assert.ok(row.length >= 1 && row.length <= 2, "rows stay phone-friendly");
      for (const b of row) {
        assert.equal(typeof b.text, "string");
        assert.ok(b.text.length > 0 && b.text.length <= 24, b.text);
        assert.equal(typeof b.callback_data, "string");
        assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
      }
    }
  }
});

test("instrument callback maps to the live book name", () => {
  assert.equal(instrumentArg("SOL"), "SOL/USD");
  assert.equal(instrumentArg("AAVE"), "AAVE/USD");
  assert.equal(parseMenuCallback("resume:ZEC").action, "resume");
  assert.equal(parseMenuCallback("resume:ZEC").symbol, "ZEC");
  assert.equal(parseMenuCallback("book:AVAX").view, "book");
});

test("every slash command still registered after adding buttons", () => {
  for (const cmd of ["status", "health", "levels", "rings", "dxpreflight", "solcanary", "kill", "resume",
                     "confirmresume", "reconcile", "confirmreconcile", "rematch", "confirmrematch",
                     "flat", "code", "devstatus", "devreset", "devexit", "whoami"]) {
    assert.match(SOURCE, new RegExp(`\\\\/${cmd}\\b`), `slash command /${cmd} disappeared`);
  }
  assert.match(SOURCE, /\(b\|buttons\|menu\)/, "/b alias missing");
});
