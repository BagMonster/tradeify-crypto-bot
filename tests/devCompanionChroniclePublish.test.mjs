import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectProposedFiles,
  assertEntryMarkdown
} from "../src/devCompanionChroniclePolicy.js";
import { createChroniclePublisher } from "../src/devCompanionChroniclePublish.js";
import { createChronicleControl } from "../src/devCompanionChronicleControl.js";
import { COMPANION_REPO_TOOLS } from "../src/devCompanionTools.js";

const MAIN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ENTRY = `# Note\n\n**Fact:** the grid is live.\n**Opinion:** restraint matters.\n`;
const LINE = "| 2026-08-26 | Founding voice | Opinion | this entry |";

function memoryStore() {
  const publications = new Map();
  let paused = false;
  return {
    publications,
    async isChroniclePaused() { return paused; },
    async setChroniclePaused(value) { paused = value === true; },
    async getChroniclePublication(key) { return publications.get(key) ?? null; },
    async beginChroniclePublication(row) {
      publications.set(row.publicationKey, { ...row, status: "executing" });
    },
    async completeChroniclePublication(key, result) {
      publications.set(key, { ...(publications.get(key) ?? {}), status: "done", ...result });
    },
    async failChroniclePublication(key, errorCode) {
      const current = publications.get(key);
      if (current?.status === "done") return;
      publications.set(key, { ...(current ?? {}), status: "failed", errorCode });
    }
  };
}

function fakeGithub({ mainSha = MAIN, prFiles = null, failMerge = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || "GET";
    const href = String(url);
    calls.push({ method, href });
    const json = (payload, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      async text() { return JSON.stringify(payload); }
    });

    if (href.endsWith("/commits/main") && method === "GET") return json({ sha: mainSha });
    if (href.includes("/contents/docs/chronicle/TIMELINE.md") && method === "GET") {
      return json({ message: "Not Found" }, 404);
    }
    if (href.includes("/git/commits/") && method === "GET") {
      return json({ sha: mainSha, tree: { sha: "treebase11111111111111111111111111111111" } });
    }
    if (href.endsWith("/git/blobs") && method === "POST") {
      return json({ sha: `blob${String(calls.length).padStart(36, "0")}` });
    }
    if (href.endsWith("/git/trees") && method === "POST") {
      return json({ sha: "treenew111111111111111111111111111111111" });
    }
    if (href.endsWith("/git/commits") && method === "POST") {
      return json({ sha: "commit1111111111111111111111111111111111" });
    }
    if (href.includes("/git/ref/heads/") && method === "GET") {
      return json({ message: "Not Found" }, 404);
    }
    if (href.endsWith("/git/refs") && method === "POST") {
      return json({ ref: "refs/heads/docs/bmtb1/2026-08-26-founding" });
    }
    if (href.includes("/pulls?") && method === "GET") return json([]);
    if (href.endsWith("/pulls") && method === "POST") {
      return json({ html_url: "https://github.com/BagMonster/tradeify-crypto-bot/pull/77", number: 77 });
    }
    if (href.includes("/pulls/77/files") && method === "GET") {
      return json(prFiles ?? [
        { filename: "docs/chronicle/entries/2026-08-26-founding.md", status: "added" },
        { filename: "docs/chronicle/TIMELINE.md", status: "added" }
      ]);
    }
    if (href.endsWith("/pulls/77/merge") && method === "PUT") {
      if (failMerge) return json({ message: "merge failed" }, 405);
      return json({ merged: true, sha: "merged111111111111111111111111111111111" });
    }
    throw new Error(`unexpected ${method} ${href}`);
  };
  return { fetchImpl, calls };
}

const validArgs = {
  date: "2026-08-26",
  slug: "founding",
  content: ENTRY,
  timelineLine: LINE
};

test("rejects secret-like content and non-chronicle PR files", () => {
  assert.throws(() => assertEntryMarkdown("# x\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuv\nFact: no"), /secret/);
  const bad = inspectProposedFiles([
    { filename: "src/index.mjs", status: "modified" },
    { filename: "docs/chronicle/TIMELINE.md", status: "modified" }
  ]);
  assert.equal(bad.ok, false);
  const deleted = inspectProposedFiles([
    { filename: "docs/chronicle/entries/2026-08-26-founding.md", status: "removed" }
  ]);
  assert.equal(deleted.ok, false);
});

test("disabled publisher never calls GitHub", async () => {
  const { fetchImpl, calls } = fakeGithub();
  const publisher = createChroniclePublisher({
    token: "ghs_test",
    fetchImpl,
    store: memoryStore(),
    enabled: false
  });
  const result = await publisher.publishEntry(validArgs);
  assert.equal(result.ok, false);
  assert.match(result.error, /not enabled/);
  assert.equal(calls.length, 0);
});

test("paused kill switch fails closed before GitHub writes", async () => {
  const store = memoryStore();
  await store.setChroniclePaused(true);
  const { fetchImpl, calls } = fakeGithub();
  const publisher = createChroniclePublisher({
    token: "ghs_test",
    fetchImpl,
    store,
    enabled: true
  });
  const result = await publisher.publishEntry(validArgs);
  assert.equal(result.ok, false);
  assert.match(result.error, /paused/);
  assert.equal(calls.length, 0);
});

test("valid entry opens a PR and squash-merges without owner confirmation", async () => {
  const store = memoryStore();
  const { fetchImpl, calls } = fakeGithub();
  const publisher = createChroniclePublisher({
    token: "ghs_test",
    fetchImpl,
    store,
    enabled: true
  });
  const result = await publisher.publishEntry(validArgs);
  assert.equal(result.ok, true);
  assert.equal(result.merged, true);
  assert.equal(result.prNumber, 77);
  assert.equal(result.branch, "docs/bmtb1/2026-08-26-founding");
  assert.ok(calls.some((call) => call.method === "PUT" && call.href.endsWith("/merge")));
  const again = await publisher.publishEntry(validArgs);
  assert.equal(again.ok, true);
  assert.equal(again.idempotent, true);
});

test("will not merge a PR that contains a non-chronicle path", async () => {
  const publisher = createChroniclePublisher({ token: "ghs_test", enabled: true, store: memoryStore() });
  const blocked = publisher.canMergePull([
    { filename: "docs/chronicle/entries/2026-08-26-founding.md", status: "added" },
    { filename: "docs/chronicle/TIMELINE.md", status: "modified" },
    { filename: "src/telegramBot.js", status: "modified" }
  ]);
  assert.equal(blocked.ok, false);
  const { fetchImpl, calls } = fakeGithub({
    prFiles: [
      { filename: "docs/chronicle/entries/2026-08-26-founding.md", status: "added" },
      { filename: "README.md", status: "modified" }
    ]
  });
  const live = createChroniclePublisher({ token: "ghs_test", fetchImpl, store: memoryStore(), enabled: true });
  const result = await live.publishEntry(validArgs);
  assert.equal(result.ok, false);
  assert.equal(calls.some((call) => call.method === "PUT" && call.href.endsWith("/merge")), false);
});

test("base drift and GitHub merge failure fail closed", async () => {
  let reads = 0;
  const { fetchImpl } = fakeGithub();
  const drifting = async (url, options) => {
    if (String(url).endsWith("/commits/main")) {
      reads += 1;
      const sha = reads === 1 ? MAIN : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      return { ok: true, status: 200, async text() { return JSON.stringify({ sha }); } };
    }
    return fetchImpl(url, options);
  };
  const driftPublisher = createChroniclePublisher({
    token: "ghs_test",
    fetchImpl: drifting,
    store: memoryStore(),
    enabled: true
  });
  const drifted = await driftPublisher.publishEntry(validArgs);
  assert.equal(drifted.ok, false);
  assert.match(drifted.error, /BASE_DRIFT/);

  const { fetchImpl: failFetch } = fakeGithub({ failMerge: true });
  const failPublisher = createChroniclePublisher({
    token: "ghs_test",
    fetchImpl: failFetch,
    store: memoryStore(),
    enabled: true
  });
  const failed = await failPublisher.publishEntry(validArgs);
  assert.equal(failed.ok, false);
});

test("publisher has no trading, deploy, or halt interface", () => {
  const publisher = createChroniclePublisher({ token: "x", enabled: false, store: memoryStore() });
  assert.equal(typeof publisher.deploy, "undefined");
  assert.equal(typeof publisher.placeOrder, "undefined");
  assert.equal(typeof publisher.clearHalt, "undefined");
  assert.equal(COMPANION_REPO_TOOLS.some((tool) => tool.name === "publish_chronicle_entry"), true);
  assert.equal(COMPANION_REPO_TOOLS.some((tool) => /deploy|kill|reconcile|rematch/i.test(tool.name)), false);
});

test("kill switch commands do not review prose", async () => {
  const store = memoryStore();
  const control = createChronicleControl({ store });
  const paused = await control.chroniclePause();
  assert.equal(paused.paused, true);
  assert.equal(await store.isChroniclePaused(), true);
  const status = await control.chronicleStatus();
  assert.match(status.message, /PAUSED/);
  const resumed = await control.chronicleResume();
  assert.equal(resumed.paused, false);
});
