import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildMenuKeyboard, menuActionIds } from "../src/telegramBot.js";

const SOURCE = readFileSync(new URL("../src/telegramBot.js", import.meta.url), "utf8");

test("every menu button maps to a handler in the shared action table", () => {
  const table = SOURCE.slice(SOURCE.indexOf("const MENU_ACTIONS = {"), SOURCE.indexOf("async function runLatched"));
  for (const action of menuActionIds()) {
    assert.ok(new RegExp(`(^|[\\s{,])${action}:`, "m").test(table), `menu action "${action}" has no handler`);
  }
});

test("no confirmation command is reachable from a button", () => {
  const actions = new Set([...menuActionIds(), "noop"]);
  for (const forbidden of ["confirmresume", "confirmreconcile", "confirmrematch"]) {
    assert.ok(!actions.has(forbidden), `${forbidden} must never appear on the button panel`);
  }
  // and the handler must actively refuse one, not merely omit it
  assert.match(SOURCE, /CONFIRM_ONLY_COMMANDS\.includes\(action\)/);
  assert.match(SOURCE, /Confirmation cannot be done with a button/);
});

test("button callbacks are owner-authorized before any action runs", () => {
  const handler = SOURCE.slice(SOURCE.indexOf('bot.on("callback_query"'), SOURCE.indexOf('bot.on("polling_error"'));
  assert.ok(handler.indexOf("isAuthorized(query.from)") < handler.indexOf("MENU_ACTIONS[action]"),
    "authorization must be checked before dispatching an action");
});

test("header rows are inert and every keyboard row is well formed", () => {
  const rows = buildMenuKeyboard();
  const headers = rows.filter((r) => r.length === 1 && r[0].callback_data === "noop");
  assert.ok(headers.length >= 4, "expected section headers");
  for (const row of rows) {
    assert.ok(row.length >= 1 && row.length <= 2, "rows stay phone-friendly");
    for (const b of row) {
      assert.equal(typeof b.text, "string");
      assert.ok(b.text.length > 0 && b.text.length <= 24);
      assert.equal(typeof b.callback_data, "string");
      assert.ok(Buffer.byteLength(b.callback_data) <= 64, "Telegram caps callback_data at 64 bytes");
    }
  }
});

test("every slash command still registered after adding buttons", () => {
  for (const cmd of ["status","health","levels","rings","dxpreflight","solcanary","kill","resume",
                     "confirmresume","reconcile","confirmreconcile","rematch","confirmrematch",
                     "flat","code","devstatus","devreset","devexit","whoami"]) {
    assert.match(SOURCE, new RegExp(`\\\\/${cmd}\\b`), `slash command /${cmd} disappeared`);
  }
  assert.match(SOURCE, /\(b\|buttons\|menu\)/, "/b alias missing");
});
