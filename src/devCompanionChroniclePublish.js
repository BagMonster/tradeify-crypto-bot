import { ALLOWED_OWNER, ALLOWED_REPO } from "./devCompanionGithub.js";
import {
  TIMELINE_PATH,
  appendTimeline,
  assertEntryMarkdown,
  assertEntryPath,
  assertNoSecretsOrBinary,
  assertTimelineBytes,
  assertTimelineLine,
  branchNameFor,
  entryPathFor,
  inspectChroniclePullFiles,
  inspectProposedFiles,
  inspectPullMetadata,
  normalizeDate,
  normalizeSlug,
  publicationKey,
  sha256Text
} from "./devCompanionChroniclePolicy.js";

function fail(error) {
  return Object.freeze({ ok: false, error: String(error) });
}

function contentsPath(path) {
  return `/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function decodeFileContent(payload, path) {
  if (payload?.type !== "file" || typeof payload.content !== "string") {
    return fail(`${path} is not a readable file`);
  }
  const content = Buffer.from(payload.content.replace(/\s+/g, ""), "base64").toString("utf8");
  return Object.freeze({ ok: true, missing: false, content, sha: payload.sha });
}

export function createChroniclePublisher({
  token = "",
  fetchImpl = fetch,
  store,
  enabled = false,
  owner = ALLOWED_OWNER,
  repo = ALLOWED_REPO,
  userAgent = "tradeify-dev-companion-chronicle",
  claimOwner = "companion"
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

  async function readFileAtRef(path, ref) {
    const result = await github(
      `/repos/${owner}/${repo}/contents${contentsPath(path)}?ref=${encodeURIComponent(ref)}`,
      { allowStatuses: [404] }
    );
    if (!result.ok) return result;
    if (result.status === 404) return Object.freeze({ ok: true, missing: true, content: "" });
    return decodeFileContent(result.payload, path);
  }

  function canMergePull(files, expectedEntryPath) {
    return inspectChroniclePullFiles(files, { expectedEntryPath });
  }

  async function markFailed(key, error) {
    if (typeof store?.failChroniclePublication === "function") {
      await store.failChroniclePublication(key, error);
    }
    return fail(error);
  }

  async function squashMerge(prNumber, expectedHeadSha) {
    const merged = await github(`/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
      method: "PUT",
      body: {
        merge_method: "squash",
        sha: expectedHeadSha
      }
    });
    if (!merged.ok) return merged;
    if (merged.payload?.merged !== true) {
      return fail("MERGE_NOT_CONFIRMED: GitHub did not report merged=true");
    }
    return Object.freeze({
      ok: true,
      merged: true,
      sha: merged.payload?.sha ?? null
    });
  }

  async function inspectHeadBytes({ headSha, entryPath, entry, nextTimeline }) {
    const liveEntry = await readFileAtRef(entryPath, headSha);
    if (!liveEntry.ok) return liveEntry;
    if (liveEntry.missing) return fail("PR head is missing the chronicle entry");
    const liveTimeline = await readFileAtRef(TIMELINE_PATH, headSha);
    if (!liveTimeline.ok) return liveTimeline;
    if (liveTimeline.missing) return fail("PR head is missing TIMELINE.md");
    try {
      assertEntryMarkdown(liveEntry.content);
      assertTimelineBytes(liveTimeline.content, "head timeline");
      assertNoSecretsOrBinary(liveEntry.content, "head entry");
    } catch (error) {
      return fail(error.message);
    }
    if (sha256Text(liveEntry.content) !== sha256Text(entry)) {
      return fail("HEAD_CONTENT_MISMATCH: entry bytes on the PR head are not the intended content");
    }
    if (sha256Text(liveTimeline.content) !== sha256Text(nextTimeline)) {
      return fail("HEAD_CONTENT_MISMATCH: TIMELINE.md bytes on the PR head are not the intended content");
    }
    return Object.freeze({ ok: true });
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
    const entrySha = sha256Text(entry);
    const branch = branchNameFor(date, slug, entrySha);
    const key = publicationKey({ date, slug, contentSha: entrySha });
    const ownerId = rawArgs.claimOwner || claimOwner;

    if (typeof store?.getChroniclePublication === "function") {
      const existing = await store.getChroniclePublication(key);
      if (existing?.status === "done") {
        return Object.freeze({
          ok: true,
          idempotent: true,
          publicationKey: key,
          branch: existing.branch ?? branch,
          prUrl: existing.prUrl,
          prNumber: existing.prNumber,
          merged: true,
          baseSha: existing.baseSha,
          expectedHeadSha: existing.expectedHeadSha
        });
      }
    }

    const main = await readMainSha();
    if (!main.ok) return main;
    const baseSha = main.sha;

    const timelineFile = await readFileAtRef(TIMELINE_PATH, baseSha);
    if (!timelineFile.ok) return timelineFile;
    let nextTimeline;
    try {
      nextTimeline = appendTimeline(timelineFile.content, timelineLine);
    } catch (error) {
      return fail(error.message);
    }
    const timelineSha = sha256Text(nextTimeline);

    const planned = inspectProposedFiles([
      { filename: entryPath, status: "added" },
      { filename: TIMELINE_PATH, status: timelineFile.missing ? "added" : "modified" }
    ]);
    if (!planned.ok) return planned;

    const binding = {
      publicationKey: key,
      date,
      slug,
      baseSha,
      branch,
      entrySha,
      timelineSha,
      claimOwner: ownerId
    };

    let claimed = null;
    if (typeof store?.claimChroniclePublication === "function") {
      claimed = await store.claimChroniclePublication(binding);
      if (!claimed.ok) return fail(claimed.error);
      if (claimed.alreadyDone) {
        return Object.freeze({
          ok: true,
          idempotent: true,
          publicationKey: key,
          branch,
          prUrl: claimed.publication?.prUrl,
          prNumber: claimed.publication?.prNumber,
          merged: true,
          baseSha
        });
      }
    } else if (typeof store?.beginChroniclePublication === "function") {
      await store.beginChroniclePublication(binding);
    }

    const storedHead = claimed?.publication?.expectedHeadSha ?? null;

    const commit = await github(`/repos/${owner}/${repo}/git/commits/${baseSha}`);
    if (!commit.ok) return markFailed(key, commit.error);
    const baseTreeSha = commit.payload?.tree?.sha;
    if (!baseTreeSha) return markFailed(key, "could not read base tree");

    const existingRef = await github(
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      { allowStatuses: [404] }
    );
    if (!existingRef.ok) return markFailed(key, existingRef.error);

    let headSha;
    if (existingRef.status === 404) {
      const blobs = [];
      for (const item of [
        { path: entryPath, content: entry },
        { path: TIMELINE_PATH, content: nextTimeline }
      ]) {
        const blob = await github(`/repos/${owner}/${repo}/git/blobs`, {
          method: "POST",
          body: { content: item.content, encoding: "utf-8" }
        });
        if (!blob.ok) return markFailed(key, blob.error);
        blobs.push({ path: item.path, mode: "100644", type: "blob", sha: blob.payload.sha });
      }
      const tree = await github(`/repos/${owner}/${repo}/git/trees`, {
        method: "POST",
        body: { base_tree: baseTreeSha, tree: blobs }
      });
      if (!tree.ok) return markFailed(key, tree.error);
      const newCommit = await github(`/repos/${owner}/${repo}/git/commits`, {
        method: "POST",
        body: {
          message: `Docs: chronicle ${date}-${slug}`,
          tree: tree.payload.sha,
          parents: [baseSha]
        }
      });
      if (!newCommit.ok) return markFailed(key, newCommit.error);
      const created = await github(`/repos/${owner}/${repo}/git/refs`, {
        method: "POST",
        body: { ref: `refs/heads/${branch}`, sha: newCommit.payload.sha }
      });
      if (!created.ok) return markFailed(key, created.error);
      headSha = newCommit.payload.sha;
    } else {
      const existingSha = existingRef.payload?.object?.sha;
      if (typeof existingSha !== "string") {
        return markFailed(key, "BRANCH_COLLISION: existing branch has no SHA");
      }
      if (storedHead && storedHead === existingSha) {
        headSha = existingSha;
      } else {
        return markFailed(key, "BRANCH_COLLISION: existing branch does not match the stored publication head");
      }
    }

    if (typeof store?.bindChroniclePublicationHead === "function") {
      await store.bindChroniclePublicationHead(key, headSha);
    }

    let prUrl;
    let prNumber;
    const existingPr = await github(
      `/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=open`
    );
    if (!existingPr.ok) return markFailed(key, existingPr.error);
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
      if (!pull.ok) return markFailed(key, pull.error);
      prUrl = pull.payload.html_url;
      prNumber = pull.payload.number;
    }

    const pullMeta = await github(`/repos/${owner}/${repo}/pulls/${prNumber}`);
    if (!pullMeta.ok) return markFailed(key, pullMeta.error);
    const meta = inspectPullMetadata(pullMeta.payload, {
      baseSha,
      branch,
      headSha,
      owner,
      repo
    });
    if (!meta.ok) return markFailed(key, meta.error);

    const fileList = await github(`/repos/${owner}/${repo}/pulls/${prNumber}/files`);
    if (!fileList.ok) return markFailed(key, fileList.error);
    const files = canMergePull(fileList.payload, entryPath);
    if (!files.ok) return markFailed(key, files.error);

    const headBytes = await inspectHeadBytes({ headSha, entryPath, entry, nextTimeline });
    if (!headBytes.ok) return markFailed(key, headBytes.error);

    if (typeof store?.isChroniclePaused === "function" && await store.isChroniclePaused()) {
      return markFailed(key, "chronicle publishing is paused by the owner kill switch");
    }

    const liveMain = await readMainSha();
    if (!liveMain.ok) return markFailed(key, liveMain.error);
    if (liveMain.sha !== baseSha) {
      return markFailed(key, "BASE_DRIFT: main SHA changed; publication aborted");
    }

    const merge = await squashMerge(prNumber, headSha);
    if (!merge.ok) return markFailed(key, merge.error);
    if (merge.merged !== true) {
      return markFailed(key, "MERGE_NOT_CONFIRMED: GitHub did not report merged=true");
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
      merged: true,
      baseSha,
      expectedHeadSha: headSha,
      entrySha,
      timelineSha
    });
  }

  return Object.freeze({
    readMainSha,
    publishEntry,
    canMergePull,
    squashMerge
  });
}
