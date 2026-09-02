import test from "node:test";
import assert from "node:assert/strict";
import { splitTelegramText, TELEGRAM_TEXT_LIMIT } from "../src/telegramMessageSplit.js";

test("short text stays a single unprefixed message", () => {
  assert.deepEqual(splitTelegramText("STATUS ok"), ["STATUS ok"]);
});

test("empty input yields one empty chunk so sendMessage still fires", () => {
  assert.deepEqual(splitTelegramText(""), [""]);
  assert.deepEqual(splitTelegramText(null), [""]);
});

test("five-instrument fan-out splits on the D-060 separator and stays under the cap", () => {
  const rule = "\u2014".repeat(28);
  const block = (name) => `${rule}\n${name}\n${rule}\n${"line\n".repeat(80)}${name} footer`;
  const text = [
    "ACCOUNT RISK\n  instruments enabled: 5",
    block("SOL/USD"),
    block("DOGE/USD"),
    block("ZEC/USD"),
    block("AAVE/USD"),
    block("AVAX/USD")
  ].join("\n\n");

  assert.ok(text.length > TELEGRAM_TEXT_LIMIT, `fixture must overflow (${text.length})`);
  const pages = splitTelegramText(text);
  assert.ok(pages.length >= 2);
  for (const page of pages) {
    assert.ok(page.length <= TELEGRAM_TEXT_LIMIT, `page length ${page.length}`);
  }
  assert.match(pages[0], /^\[1\/\d+\]\n/);
  assert.match(pages.at(-1), new RegExp(`^\\[${pages.length}/${pages.length}\\]\\n`));
  const rejoined = pages.map((p) => p.replace(/^\[\d+\/\d+\]\n/, "")).join("");
  assert.equal(rejoined, text);
});

test("a single oversize line is hard-cut rather than dropped", () => {
  const line = "X".repeat(TELEGRAM_TEXT_LIMIT + 50);
  const pages = splitTelegramText(line);
  assert.ok(pages.length >= 2);
  for (const page of pages) assert.ok(page.length <= TELEGRAM_TEXT_LIMIT);
  const body = pages.map((p) => p.replace(/^\[\d+\/\d+\]\n/, "")).join("");
  assert.equal(body.slice(0, TELEGRAM_TEXT_LIMIT - 16), line.slice(0, TELEGRAM_TEXT_LIMIT - 16));
});
