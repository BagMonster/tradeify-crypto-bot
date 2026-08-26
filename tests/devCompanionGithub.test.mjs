import test from "node:test";
import assert from "node:assert/strict";
import {
  assertReadablePath,
  createGithubInspector,
  normalizeRef,
  pinSearchQuery
} from "../src/devCompanionGithub.js";

test("blocks secret paths and parent traversal", () => {
  assert.throws(() => assertReadablePath("../package.json"), /not allowed/);
  assert.throws(() => assertReadablePath(".env"), /blocked/);
  assert.throws(() => assertReadablePath("config/.env.local"), /blocked/);
  assert.throws(() => assertReadablePath("secrets/token.txt"), /blocked/);
  assert.throws(() => assertReadablePath("certs/prod.pem"), /blocked/);
  assert.equal(assertReadablePath("src/telegramBot.js"), "src/telegramBot.js");
});

test("pins search queries to this repository", () => {
  assert.equal(
    pinSearchQuery("confirmReconcile repo:evil/other org:someone"),
    "confirmReconcile repo:BagMonster/tradeify-crypto-bot"
  );
  assert.throws(() => pinSearchQuery("   "), /required/);
  assert.throws(() => normalizeRef("main;rm -rf"), /not allowed/);
  assert.equal(normalizeRef(""), "main");
});

test("lists and reads through a fake GitHub API without leaving the allowlisted repo", async () => {
  const calls = [];
  const inspector = createGithubInspector({
    token: "ghs_test",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), auth: options.headers.Authorization });
      if (String(url).includes("/contents/src?")) {
        return {
          ok: true,
          async text() {
            return JSON.stringify([
              { type: "file", path: "src/telegramBot.js", name: "telegramBot.js", size: 100 },
              { type: "dir", path: "src/state", name: "state", size: 0 },
              { type: "file", path: "src/.env", name: ".env", size: 12 }
            ]);
          }
        };
      }
      if (String(url).includes("/contents/src/telegramBot.js")) {
        return {
          ok: true,
          async text() {
            return JSON.stringify({
              type: "file",
              path: "src/telegramBot.js",
              sha: "abc",
              encoding: "base64",
              content: Buffer.from("export function startTelegramBot() {}").toString("base64")
            });
          }
        };
      }
      throw new Error(`unexpected url ${url}`);
    }
  });

  const listed = await inspector.listFiles({ path: "src" });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.entries.map((entry) => entry.path), ["src/telegramBot.js", "src/state"]);

  const file = await inspector.readFile({ path: "src/telegramBot.js" });
  assert.equal(file.ok, true);
  assert.match(file.content, /startTelegramBot/);
  assert.ok(calls.every((call) => call.url.includes("BagMonster/tradeify-crypto-bot")));
});

test("search strips foreign repo qualifiers and drops foreign hits", async () => {
  const inspector = createGithubInspector({
    token: "ghs_test",
    fetchImpl: async (url) => {
      assert.match(String(url), /repo%3ABagMonster%2Ftradeify-crypto-bot/);
      assert.doesNotMatch(String(url), /evil/);
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            total_count: 2,
            items: [
              {
                path: "src/solanaTradeifyService.js",
                repository: { full_name: "BagMonster/tradeify-crypto-bot" },
                text_matches: [{ fragment: "async confirmReconcile" }]
              },
              {
                path: "README.md",
                repository: { full_name: "evil/other" },
                text_matches: [{ fragment: "should not appear" }]
              }
            ]
          });
        }
      };
    }
  });

  const result = await inspector.searchCode({ query: "confirmReconcile repo:evil/other" });
  assert.equal(result.ok, true);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].path, "src/solanaTradeifyService.js");
});

test("refuses to start when pointed at another repository", () => {
  assert.throws(
    () => createGithubInspector({ token: "x", owner: "evil", repo: "other" }),
    /locked/
  );
});

test("missing token fails closed without calling fetch", async () => {
  const inspector = createGithubInspector({
    token: "",
    fetchImpl: async () => {
      throw new Error("fetch should not run");
    }
  });
  const result = await inspector.executeTool("list_repo_files", { path: "src" });
  assert.equal(result.ok, false);
  assert.match(result.error, /GITHUB_TOKEN/);
});
