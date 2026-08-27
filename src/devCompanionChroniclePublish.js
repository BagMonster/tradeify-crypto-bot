import { ALLOWED_OWNER, ALLOWED_REPO } from "./devCompanionGithub.js";
import {
  TIMELINE_PATH,
  appendTimeline,
  assertEntryMarkdown,
  assertEntryPath,
  assertTimelineLine,
  branchNameFor,
  entryPathFor,
  failPolicy,
  inspectProposedFiles,
  normalizeDate,
  normalizeSlug,
  publicationKey,
  sha256Text
} from "./devCompanionChroniclePolicy.js";

function fail(error) {
  return Object.freeze({ ok: false, error: String(error) });
}

export function createChroniclePublisher({
  token = "",
  fetchImpl = fetch,
  store,
  enabled = false,
  owner = ALLOWED_OWNER,
  repo = ALLOWED_REPO,
  userAgent = "tradeify-dev-companion-chronicle"
} = {}) {
  if (owner !== ALLOWED_OWNER || repo !== ALLOWED_REPO) {
    throw new TypeError("chronicle publisher is locked to BagMonster/tradeify-crypto-bot");
  }

  async function github(path, { method = "GET", body, allowStatuses = [] } = {}) {
    if (typeof token !== "string" || token.trim() === "") {
      return fail("GITHUB_TOKEN is not configured on the companion worker");
    }
    const response = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        Accept: "application/vnd.github+json",
        "User-Agent": userAgent,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000)
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok && !allowStatuses.includes(response.status)) {
      const message = payload?.message ? String(payload.message) : `GitHub HTTP ${response.status}`;
      return fail(message);
    }
    return Object.freeze({ ok: true, status: response.status, payload });
  }

  async function readMainSha() {
    const result = await github(`/repos/${owner}/${repo}/commits/main`);
    if (!result.ok) return result;
    const sha = result.payload?.sha;
    if (typeof sha !== "string" || sha.length < 7) return fail("could not read main SHA");
    return Object.freeze({ ok: true, sha });
  }

  async function readFileOnMain(path) {
    const suffix = `/${path.split("/").map(encodeURIComponent).join("/")}`;
    const result = await github(
      `/repos/${owner}/${repo}/contents${suffix}?ref=main`,
      { allowStatuses: [404] }
    );
    if (!result.ok) return result;
    if (result.status === 404) return Object.freeze({ ok: true, missing: true, content: "" });
    if (result.payload?.type !== "file" || typeof result.payload.content !== "string") {
      return fail(`${path} is not a readable file`);
    }
    const content = Buffer.from(result.payload.content.replace(/\s+/g, ""), "base64").toString("utf8");
    return Object.freeze({ ok: true, missing: false, content, sha: result.payload.sha });
  }

  function canMergePull(files) {
    return inspectProposedFiles(files);
  }

  async function squashMerge(prNumber, files) {
    const policy = canMergePull(files);
    if (!policy.ok) return policy;
    const merged = await github(`/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
      method: "PUT",
      body: { merge_method: "squash" }
    });
    if (!merged.ok) return merged;
    return Object.freeze({
      ok: true,
      merged: merged.payload?.merged === true,
      sha: merged.payload?.sha ?? null
    });
  }

  async function publishEntry(rawArgs = {}) {
    if (enabled !== true) {
      return fail("autonomous chronicle publish is not enabled on this companion");
    }
    if (typeof store?.isChroniclePaused === "function" && await store.isChroniclePaused()) {
      return fail("chronicle publishing is paused by the owner kill switch");
    }

    let date;
    let slug;
    let entry;
    let timelineLine;
    try {
      date = normalizeDate(rawArgs.date);
      slug = normalizeSlug(rawArgs.slug || rawArgs.title);
      entry = assertEntryMarkdown(rawArgs.content ?? rawArgs.entry);
      timelineLine = assertTimelineLine(rawArgs.timelineLine);
    } catch (error) {
      return fail(error.message);
    }

    const entryPath = assertEntryPath(entryPathFor(date, slug), date, slug);
    const branch = branchNameFor(date, slug);
    const contentSha = sha256Text(entry);
    const key = publicationKey({ date, slug, contentSha });

    if (typeof store?.getChroniclePublication === "function") {
      const existing = await store.getChroniclePublication(key);
      if (existing?.status === "done") {
        return Object.freeze({
          ok: true,
          idempotent: true,
          publicationKey: key,
          branch,
          prUrl: existing.prUrl,
          merged: true
        });
      }
    }

    const main = await readMainSha();
    if (!main.ok) return main;

    const timelineFile = await readFileOnMain(TIMELINE_PATH);
    if (!timelineFile.ok) return timelineFile;
    let nextTimeline;
    try {
      nextTimeline = appendTimeline(timelineFile.content, timelineLine);
    } catch (error) {
      return fail(error.message);
    }

    const planned = inspectProposedFiles([
      { filename: entryPath, status: "added" },
      { filename: TIMELINE_PATH, status: timelineFile.missing ? "added" : "modified" }
    ]);
    if (!planned.ok) return planned;

    if (typeof store?.beginChroniclePublication === "function") {
      await store.beginChroniclePublication({
        publicationKey: key,
        date,
        slug,
        baseSha: main.sha,
        branch
      });
    }

    const commit = await github(`/repos/${owner}/${repo}/git/commits/${main.sha}`);
    if (!commit.ok) {
      if (typeof store?.failChroniclePublication === "function") await store.failChroniclePublication(key, commit.error);
      return commit;
    }
    const baseTreeSha = commit.payload?.tree?.sha;
    if (!baseTreeSha) return fail("could not read base tree");

    const blobs = [];
    for (const item of [
      { path: entryPath, content: entry },
      { path: TIMELINE_PATH, content: nextTimeline }
    ]) {
      const blob = await github(`/repos/${owner}/${repo}/git/blobs`, {
        method: "POST",
        body: { content: item.content, encoding: "utf-8" }
      });
      if (!blob.ok) {
        if (typeof store?.failChroniclePublication === "function") await store.failChroniclePublication(key, blob.error);
        return blob;
      }
      blobs.push({ path: item.path, mode: "100644", type: "blob", sha: blob.payload.sha });
    }

    const existingRef = await github(
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      { allowStatuses: [404] }
    );
    if (!existingRef.ok) return existingRef;

    let headSha;
    if (existingRef.status === 404) {
      const tree = await github(`/repos/${owner}/${repo}/git/trees`, {
        method: "POST",
        body: { base_tree: baseTreeSha, tree: blobs }
      });
      if (!tree.ok) return tree;
      const newCommit = await github(`/repos/${owner}/${repo}/git/commits`, {
        method: "POST",
        body: {
          message: `Docs: chronicle ${date}-${slug}`,
          tree: tree.payload.sha,
          parents: [main.sha]
        }
      });
      if (!newCommit.ok) return newCommit;
      const created = await github(`/repos/${owner}/${repo}/git/refs`, {
        method: "POST",
        body: { ref: `refs/heads/${branch}`, sha: newCommit.payload.sha }
      });
      if (!created.ok) return created;
      headSha = newCommit.payload.sha;
    } else {
      headSha = existingRef.payload?.object?.sha;
    }

    let prUrl;
    let prNumber;
    const existingPr = await github(
      `/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=open`
    );
    if (!existingPr.ok) return existingPr;
    const found = Array.isArray(existingPr.payload) ? existingPr.payload[0] : null;
    if (found) {
      prUrl = found.html_url;
      prNumber = found.number;
    } else {
      const pull = await github(`/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        body: {
          title: `Docs: chronicle ${date}-${slug}`,
          head: branch,
          base: "main",
          body: "Autonomous BMTB1 chronicle entry. Mechanical scope checks only. No production change."
        }
      });
      if (!pull.ok) return pull;
      prUrl = pull.payload.html_url;
      prNumber = pull.payload.number;
    }

    const liveMain = await readMainSha();
    if (!liveMain.ok) return liveMain;
    if (liveMain.sha !== main.sha) {
      const drift = failPolicy("BASE_DRIFT: main SHA changed; publication aborted");
      if (typeof store?.failChroniclePublication === "function") await store.failChroniclePublication(key, drift.error);
      return drift;
    }

    const fileList = await github(`/repos/${owner}/${repo}/pulls/${prNumber}/files`);
    if (!fileList.ok) return fileList;
    const merge = await squashMerge(prNumber, fileList.payload);
    if (!merge.ok) {
      if (typeof store?.failChroniclePublication === "function") await store.failChroniclePublication(key, merge.error);
      return merge;
    }

    if (typeof store?.completeChroniclePublication === "function") {
      await store.completeChroniclePublication(key, { prUrl, prNumber, commitSha: merge.sha, headSha });
    }

    return Object.freeze({
      ok: true,
      idempotent: existingRef.status !== 404,
      publicationKey: key,
      branch,
      prUrl,
      prNumber,
      merged: merge.merged === true,
      baseSha: main.sha
    });
  }

  return Object.freeze({
    readMainSha,
    publishEntry,
    canMergePull,
    squashMerge
  });
}
