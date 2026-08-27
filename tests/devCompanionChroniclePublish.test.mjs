import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectProposedFiles,
  inspectChroniclePullFiles,
  assertEntryMarkdown,
  branchNameFor,
  entryPathFor,
  publicationKey,
  sha256Text,
  TIMELINE_PATH
} from "../src/devCompanionChroniclePolicy.js";
import { createChroniclePublisher } from "../src/devCompanionChroniclePublish.js";
import { createChronicleControl } from "../src/devCompanionChronicleControl.js";
import { COMPANION_REPO_TOOLS } from "../src/devCompanionTools.js";

const MAIN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD = "commit1111111111111111111111111111111111";
const ENTRY = `# Note\n\n**Fact:** the grid is live.\n**Opinion:** restraint matters.\n`;
const LINE = "| 2026-08-26 | Founding voice | Opinion | this entry |";
const ENTRY_PATH = entryPathFor("2026-08-26", "founding");
const ENTRY_SHA = sha256Text(ENTRY);
const BRANCH = branchNameFor("2026-08-26", "founding", ENTRY_SHA);
const KEY = publicationKey({ date: "2026-08-26", slug: "founding", contentSha: ENTRY_SHA });
const DEFAULT_TIMELINE = [
  "# Timeline",
  "",
  "| When | What | Kind | Source |",
  "|---|---|---|---|",
  LINE,
  ""
].join("\n");
const TIMELINE_SHA = sha256Text(DEFAULT_TIMELINE);

function b64(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

function memoryStore() {
  const publications = new Map();
  let paused = false;
  return {
    publications,
    async isChroniclePaused() { return paused; },
    async setChroniclePaused(value) { paused = value === true; },
    async getChroniclePublication(key) { return publications.get(key) ?? null; },
    async claimChroniclePublication(row) {
      const existing = publications.get(row.publicationKey);
      if (!existing) {
        const created = { ...row, status: "executing" };
        publications.set(row.publicationKey, created);
        return { ok: true, claimed: true, publication: created };
      }
      if (existing.status === "done") {
        return { ok: true, claimed: false, alreadyDone: true, publication: existing };
      }
      const same = existing.baseSha === row.baseSha
        && existing.branch === row.branch
        && existing.entrySha === row.entrySha
        && existing.timelineSha === row.timelineSha;
      if (!same) return { ok: false, error: "PUBLICATION_BINDING_MISMATCH", publication: existing };
      if (existing.status === "failed" || !existing.claimOwner || existing.claimOwner === row.claimOwner) {
        const resumed = { ...existing, ...row, status: "executing" };
        publications.set(row.publicationKey, resumed);
        return { ok: true, claimed: true, resumed: true, publication: resumed };
      }
      return { ok: false, error: "PUBLICATION_IN_FLIGHT", publication: existing };
    },
    async bindChroniclePublicationHead(key, expectedHeadSha) {
      const current = publications.get(key);
      if (!current || current.status !== "executing") return null;
      const next = { ...current, expectedHeadSha };
      publications.set(key, next);
      return next;
    },
    async beginChroniclePublication(row) {
      return this.claimChroniclePublication(row);
    },
    async completeChroniclePublication(key, result) {
      const current = publications.get(key);
      if (current?.status !== "executing") return;
      publications.set(key, { ...current, status: "done", ...result });
    },
    async failChroniclePublication(key, errorCode) {
      const current = publications.get(key);
      if (current?.status === "done") return;
      publications.set(key, { ...(current ?? {}), status: "failed", errorCode, claimOwner: null });
    }
  };
}

function fakeGithub({
  mainSha = MAIN,
  laterMainSha = null,
  prFiles = null,
  failMerge = false,
  mergedFalse = false,
  existingBranchSha = null,
  headEntry = ENTRY,
  headTimeline = DEFAULT_TIMELINE,
  pullOverrides = {},
  timelineByRef = null,
  pauseStoreOnPull = null
} = {}) {
  const calls = [];
  let mainReads = 0;
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || "GET";
    const href = String(url);
    calls.push({ method, href, body: options.body ?? null });
    const json = (payload, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      async text() { return JSON.stringify(payload); }
    });

    if (href.endsWith("/commits/main") && method === "GET") {
      mainReads += 1;
      const sha = laterMainSha && mainReads > 1 ? laterMainSha : mainSha;
      return json({ sha });
    }
    if (href.includes("/contents/docs/chronicle/TIMELINE.md") && method === "GET") {
      const ref = new URL(href).searchParams.get("ref");
      if (ref === "main") {
        throw new Error("TIMELINE.md must be read at the captured base SHA, not moving main");
      }
      if (timelineByRef && Object.prototype.hasOwnProperty.call(timelineByRef, ref)) {
        const text = timelineByRef[ref];
        if (text == null) return json({ message: "Not Found" }, 404);
        if (text === "") return json({ message: "Not Found" }, 404);
        return json({ type: "file", content: b64(text), sha: "tlblob" });
      }
      if (ref === HEAD || ref === existingBranchSha) {
        return json({ type: "file", content: b64(headTimeline), sha: "tlhead" });
      }
      return json({ message: "Not Found" }, 404);
    }
    if (href.includes(`/contents/${ENTRY_PATH}`) && method === "GET") {
      return json({ type: "file", content: b64(headEntry), sha: "entryblob" });
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
      return json({ sha: HEAD });
    }
    if (href.includes("/git/ref/heads/") && method === "GET") {
      if (existingBranchSha) {
        return json({ object: { sha: existingBranchSha } });
      }
      return json({ message: "Not Found" }, 404);
    }
    if (href.endsWith("/git/refs") && method === "POST") {
      return json({ ref: `refs/heads/${BRANCH}`, object: { sha: HEAD } });
    }
    if (href.includes("/pulls?") && method === "GET") return json([]);
    if (href.endsWith("/pulls") && method === "POST") {
      if (pauseStoreOnPull) await pauseStoreOnPull.setChroniclePaused(true);
      return json({ html_url: "https://github.com/BagMonster/tradeify-crypto-bot/pull/77", number: 77 });
    }
    if (href.endsWith("/pulls/77") && method === "GET") {
      return json({
        number: 77,
        html_url: "https://github.com/BagMonster/tradeify-crypto-bot/pull/77",
        changed_files: 2,
        base: { ref: "main", sha: mainSha },
        head: {
          ref: BRANCH,
          sha: HEAD,
          repo: { full_name: "BagMonster/tradeify-crypto-bot", name: "tradeify-crypto-bot", owner: { login: "BagMonster" } }
        },
        ...pullOverrides
      });
    }
    if (href.includes("/pulls/77/files") && method === "GET") {
      return json(prFiles ?? [
        { filename: ENTRY_PATH, status: "added" },
        { filename: TIMELINE_PATH, status: "added" }
      ]);
    }
    if (href.endsWith("/pulls/77/merge") && method === "PUT") {
      if (failMerge) return json({ message: "merge failed" }, 405);
      if (mergedFalse) return json({ merged: false, message: "not merged" });
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
    { filename: ENTRY_PATH, status: "removed" },
    { filename: TIMELINE_PATH, status: "modified" }
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
  assert.equal(result.branch, BRANCH);
  assert.match(result.branch, /[a-f0-9]{12}$/);
  assert.ok(calls.some((call) => call.method === "PUT" && call.href.endsWith("/merge")));
  const mergeCall = calls.find((call) => call.method === "PUT" && call.href.endsWith("/merge"));
  assert.match(String(mergeCall.body), new RegExp(HEAD));
  const again = await publisher.publishEntry(validArgs);
  assert.equal(again.ok, true);
  assert.equal(again.idempotent, true);
  assert.equal(store.publications.get(KEY).status, "done");
});

test("will not merge a PR that contains a non-chronicle path", async () => {
  const publisher = createChroniclePublisher({ token: "ghs_test", enabled: true, store: memoryStore() });
  const blocked = publisher.canMergePull([
    { filename: ENTRY_PATH, status: "added" },
    { filename: TIMELINE_PATH, status: "modified" },
    { filename: "src/telegramBot.js", status: "modified" }
  ], ENTRY_PATH);
  assert.equal(blocked.ok, false);
  const { fetchImpl, calls } = fakeGithub({
    prFiles: [
      { filename: ENTRY_PATH, status: "added" },
      { filename: "README.md", status: "modified" }
    ]
  });
  const live = createChroniclePublisher({ token: "ghs_test", fetchImpl, store: memoryStore(), enabled: true });
  const result = await live.publishEntry(validArgs);
  assert.equal(result.ok, false);
  assert.equal(calls.some((call) => call.method === "PUT" && call.href.endsWith("/merge")), false);
});

test("third file is refused before merge", async () => {
  const { fetchImpl, calls } = fakeGithub({
    prFiles: [
      { filename: ENTRY_PATH, status: "added" },
      { filename: TIMELINE_PATH, status: "modified" },
      { filename: "docs/chronicle/README.md", status: "added" }
    ]
  });
  const publisher = createChroniclePublisher({ token: "ghs_test", fetchImpl, store: memoryStore(), enabled: true });
  const result = await publisher.publishEntry(validArgs);
  assert.equal(result.ok, false);
  assert.match(result.error, /exactly two files|too many|README|not allowed/);
  assert.equal(calls.some((call) => call.method === "PUT" && call.href.endsWith("/merge")), false);
});

test("modified existing entry is refused", async () => {
  const files = inspectChroniclePullFiles([
    { filename: ENTRY_PATH, status: "modified" },
    { filename: TIMELINE_PATH, status: "modified" }
  ], { expectedEntryPath: ENTRY_PATH });
  assert.equal(files.ok, false);
  assert.match(files.error, /newly added/);
  const { fetchImpl, calls } = fakeGithub({
    prFiles: [
      { filename: ENTRY_PATH, status: "modified" },
      { filename: TIMELINE_PATH, status: "modified" }
    ]
  });
  const publisher = createChroniclePublisher({ token: "ghs_test", fetchImpl, store: memoryStore(), enabled: true });
  const result = await publisher.publishEntry(validArgs);
  assert.equal(result.ok, false);
  assert.match(result.error, /newly added/);
  assert.equal(calls.some((call) => call.method === "PUT" && call.href.endsWith("/merge")), false);
});

test("altered allowed-path content is refused after re-read", async () => {
  const { fetchImpl, calls } = fakeGithub({
    headEntry: `${ENTRY}\nextra paragraph that was not intended.\n`
  });
  const store = memoryStore();
  const publisher = createChroniclePublisher({ token: "ghs_test", fetchImpl, store, enabled: true });
  const result = await publisher.publishEntry(validArgs);
  assert.equal(result.ok, false);
  assert.match(result.error, /HEAD_CONTENT_MISMATCH/);
  assert.equal(calls.some((call) => call.method === "PUT" && call.href.endsWith("/merge")), false);
  assert.equal(store.publications.get(KEY).status, "failed");
});

test("existing branch without matching stored head is a collision", async () => {
  const { fetchImpl, calls } = fakeGithub({
    existingBranchSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
  });
  const store = memoryStore();
  const publisher = createChroniclePublisher({ token: "ghs_test", fetchImpl, store, enabled: true });
  const result = await publisher.publishEntry(validArgs);
  assert.equal(result.ok, false);
  assert.match(result.error, /BRANCH_COLLISION/);
  assert.equal(calls.some((call) => call.method === "POST" && call.href.endsWith("/git/refs")), false);
  assert.equal(calls.some((call) => call.method === "PUT" && call.href.endsWith("/merge")), false);
});

test("resume is allowed only when the stored head exactly matches the branch", async () => {
  const store = memoryStore();
  store.publications.set(KEY, {
    publicationKey: KEY,
    date: "2026-08-26",
    slug: "founding",
    status: "failed",
    baseSha: MAIN,
    branch: BRANCH,
    entrySha: ENTRY_SHA,
    timelineSha: TIMELINE_SHA,
    expectedHeadSha: HEAD,
    claimOwner: null
  });
  const { fetchImpl, calls } = fakeGithub({ existingBranchSha: HEAD });
  const publisher = createChroniclePublisher({
    token: "ghs_test",
    fetchImpl,
    store,
    enabled: true,
    claimOwner: "companion-retry"
  });
  const result = await publisher.publishEntry(validArgs);
  assert.equal(result.ok, true);
  assert.equal(result.merged, true);
  assert.equal(calls.some((call) => call.method === "POST" && call.href.endsWith("/git/refs")), false);
});

test("pause during publication aborts before merge", async () => {
  const store = memoryStore();
  const { fetchImpl, calls } = fakeGithub({ pauseStoreOnPull: store });
  const publisher = createChroniclePublisher({ token: "ghs_test", fetchImpl, store, enabled: true });
  const result = await publisher.publishEntry(validArgs);
  assert.equal(result.ok, false);
  assert.match(result.error, /paused/);
  assert.equal(calls.some((call) => call.method === "PUT" && call.href.endsWith("/merge")), false);
  assert.equal(store.publications.get(KEY).status, "failed");
});

test("merged !== true is failure and is never marked done", async () => {
  const store = memoryStore();
  const { fetchImpl } = fakeGithub({ mergedFalse: true });
  const publisher = createChroniclePublisher({ token: "ghs_test", fetchImpl, store, enabled: true });
  const result = await publisher.publishEntry(validArgs);
  assert.equal(result.ok, false);
  assert.match(result.error, /MERGE_NOT_CONFIRMED/);
  assert.notEqual(store.publications.get(KEY)?.status, "done");
  assert.equal(store.publications.get(KEY).status, "failed");
});

test("TIMELINE.md is read from the captured base SHA, not moving main", async () => {
  const later = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const laterTimeline = "# Timeline\n\n| When | What | Kind | Source |\n|---|---|---|---|\n| 2026-08-26 | later | Fact | other |\n";
  const { fetchImpl, calls } = fakeGithub({
    mainSha: MAIN,
    laterMainSha: later,
    timelineByRef: {
      [MAIN]: "",
      [later]: laterTimeline,
      main: laterTimeline
    }
  });
  const publisher = createChroniclePublisher({ token: "ghs_test", fetchImpl, store: memoryStore(), enabled: true });
  const result = await publisher.publishEntry(validArgs);
  assert.equal(result.ok, false);
  assert.match(result.error, /BASE_DRIFT/);
  const timelineReads = calls.filter((call) => call.href.includes("/contents/docs/chronicle/TIMELINE.md"));
  assert.ok(timelineReads.some((call) => call.href.includes(`ref=${MAIN}`)));
  assert.equal(timelineReads.some((call) => /ref=main(?:&|$)/.test(call.href)), false);
});

test("base drift and GitHub merge failure fail closed", async () => {
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

test("concurrent duplicate execution is owned by one worker", async () => {
  const store = memoryStore();
  const first = await store.claimChroniclePublication({
    publicationKey: KEY,
    date: "2026-08-26",
    slug: "founding",
    baseSha: MAIN,
    branch: BRANCH,
    entrySha: ENTRY_SHA,
    timelineSha: TIMELINE_SHA,
    claimOwner: "worker-a"
  });
  assert.equal(first.claimed, true);
  const second = await store.claimChroniclePublication({
    publicationKey: KEY,
    date: "2026-08-26",
    slug: "founding",
    baseSha: MAIN,
    branch: BRANCH,
    entrySha: ENTRY_SHA,
    timelineSha: TIMELINE_SHA,
    claimOwner: "worker-b"
  });
  assert.equal(second.ok, false);
  assert.equal(second.error, "PUBLICATION_IN_FLIGHT");

  const { fetchImpl, calls } = fakeGithub();
  const publisher = createChroniclePublisher({
    token: "ghs_test",
    fetchImpl,
    store,
    enabled: true,
    claimOwner: "worker-b"
  });
  const result = await publisher.publishEntry(validArgs);
  assert.equal(result.ok, false);
  assert.match(result.error, /PUBLICATION_IN_FLIGHT/);
  assert.equal(calls.some((call) => call.method === "PUT" && call.href.endsWith("/merge")), false);
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
