import { createHash } from "node:crypto";

export const CHRONICLE_PREFIX = "docs/chronicle/";
export const ENTRIES_PREFIX = "docs/chronicle/entries/";
export const TIMELINE_PATH = "docs/chronicle/TIMELINE.md";
export const BRANCH_PREFIX = "docs/bmtb1/";
export const MAX_ENTRY_CHARS = 80000;
export const MAX_TIMELINE_CHARS = 200000;

const BINARY_HINT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const SECRET_PATTERN = new RegExp([
  "BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY",
  "\\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}",
  "\\b(?:sk-|rk-)[A-Za-z0-9]{20,}",
  "(?:postgres|postgresql|mongodb|mysql|redis):\\/\\/[^\\s]+",
  "(?:GITHUB_TOKEN|OPENAI_API_KEY|TELEGRAM_BOT_TOKEN|DXTRADE_PASSWORD|DATABASE_URL)\\s*=\\s*\\S+"
].join("|"), "i");
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY_NAME = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

export function sha256Text(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function contentHashSuffix(contentSha) {
  const hex = String(contentSha ?? "");
  if (!/^[a-f0-9]{12,}$/i.test(hex)) throw new TypeError("content hash is required for the branch name");
  return hex.slice(0, 12).toLowerCase();
}

export function failPolicy(error) {
  return Object.freeze({ ok: false, error: String(error) });
}

export function assertNoSecretsOrBinary(text, label = "content") {
  if (typeof text !== "string") throw new TypeError(`${label} must be text`);
  if (BINARY_HINT.test(text)) throw new TypeError(`${label} looks binary`);
  if (SECRET_PATTERN.test(text)) throw new TypeError(`${label} looks like a secret and was rejected`);
}

export function normalizeSlug(value) {
  const slug = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!SLUG.test(slug) || slug.length > 60) throw new TypeError("slug is not allowed");
  return slug;
}

export function normalizeDate(value, now = new Date()) {
  if (value == null || String(value).trim() === "") {
    return now.toISOString().slice(0, 10);
  }
  const date = String(value).trim();
  if (!DATE.test(date)) throw new TypeError("date must be YYYY-MM-DD");
  return date;
}

export function entryPathFor(date, slug) {
  return `${ENTRIES_PREFIX}${date}-${slug}.md`;
}

export function branchNameFor(date, slug, contentSha) {
  return `${BRANCH_PREFIX}${date}-${slug}-${contentHashSuffix(contentSha)}`;
}

export function assertChronicleWritePath(path) {
  const raw = String(path ?? "").trim().replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || raw.includes("\0") || raw.includes("..") || raw.includes("//")) {
    throw new TypeError("chronicle path is not allowed");
  }
  if (!raw.startsWith(CHRONICLE_PREFIX) || raw === "docs/chronicle") {
    throw new TypeError("only docs/chronicle/** may change");
  }
  if (!raw.endsWith(".md")) throw new TypeError("chronicle files must be Markdown");
  return raw;
}

export function assertEntryPath(path, expectedDate, expectedSlug) {
  const raw = assertChronicleWritePath(path);
  if (!raw.startsWith(ENTRIES_PREFIX)) throw new TypeError("entry must live under docs/chronicle/entries/");
  const name = raw.slice(ENTRIES_PREFIX.length);
  const match = name.match(ENTRY_NAME);
  if (!match) throw new TypeError("entry filename must be YYYY-MM-DD-slug.md");
  if (expectedDate && match[1] !== expectedDate) throw new TypeError("entry date does not match");
  if (expectedSlug && match[2] !== expectedSlug) throw new TypeError("entry slug does not match");
  return raw;
}

export function assertEntryMarkdown(content) {
  assertNoSecretsOrBinary(content, "entry");
  if (content.length > MAX_ENTRY_CHARS) throw new TypeError("entry exceeds size limit");
  if (!content.includes("#")) throw new TypeError("entry must be valid Markdown with a heading");
  if (!/\b(Fact|Inference|Uncertainty|Opinion)\b/i.test(content)) {
    throw new TypeError("entry must label Fact, Inference, Uncertainty, or Opinion");
  }
  return content.replace(/\r\n/g, "\n");
}

export function assertTimelineBytes(content, label = "timeline") {
  assertNoSecretsOrBinary(content, label);
  if (content.length > MAX_TIMELINE_CHARS) throw new TypeError("timeline exceeds size limit");
  return content.replace(/\r\n/g, "\n");
}

export function assertTimelineLine(line) {
  const text = String(line ?? "").trim();
  if (!text.startsWith("|") || !text.endsWith("|") || text.split("|").length < 5) {
    throw new TypeError("timeline line must be one sourced Markdown table row");
  }
  assertNoSecretsOrBinary(text, "timeline line");
  if (text.length > 500) throw new TypeError("timeline line is too long");
  return text;
}

export function appendTimeline(existing, line) {
  const row = assertTimelineLine(line);
  if (existing == null || String(existing).trim() === "") {
    return [
      "# Timeline",
      "",
      "| When | What | Kind | Source |",
      "|---|---|---|---|",
      row,
      ""
    ].join("\n");
  }
  const body = assertTimelineBytes(existing).replace(/\s*$/, "");
  if (body.split("\n").includes(row)) return `${body}\n`;
  return `${body}\n${row}\n`;
}

export function inspectProposedFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return failPolicy("publication has no files");
  if (files.length !== 2) return failPolicy("publication must change exactly two files");
  const paths = new Set();
  for (const file of files) {
    const status = String(file?.status ?? "added").toLowerCase();
    if (status === "removed" || status === "renamed" || status === "deleted") {
      return failPolicy("deletes and renames are not allowed");
    }
    let path;
    try {
      path = assertChronicleWritePath(file?.filename ?? file?.path);
    } catch (error) {
      return failPolicy(error.message);
    }
    if (path === "README.md" || path.startsWith("src/") || path.startsWith(".github/") || path === "index.mjs") {
      return failPolicy("non-chronicle path is not allowed");
    }
    if (paths.has(path)) return failPolicy(`duplicate path ${path}`);
    paths.add(path);
    if (file?.previous_filename) return failPolicy("renames are not allowed");
  }
  const entryPaths = [...paths].filter((path) => path.startsWith(ENTRIES_PREFIX));
  const hasTimeline = paths.has(TIMELINE_PATH);
  if (entryPaths.length !== 1 || !hasTimeline) return failPolicy("publication must include one entry and TIMELINE.md");
  return Object.freeze({ ok: true, paths: [...paths] });
}

export function inspectChroniclePullFiles(files, { expectedEntryPath } = {}) {
  const scoped = inspectProposedFiles(files);
  if (!scoped.ok) return scoped;
  const entryFile = files.find((file) => String(file?.filename ?? file?.path ?? "").startsWith(ENTRIES_PREFIX));
  const timelineFile = files.find((file) => String(file?.filename ?? file?.path ?? "") === TIMELINE_PATH);
  if (!entryFile || !timelineFile) return failPolicy("publication must include one entry and TIMELINE.md");
  if (String(entryFile.status ?? "").toLowerCase() !== "added") {
    return failPolicy("entry must be a newly added file");
  }
  const entryPath = entryFile.filename ?? entryFile.path;
  if (expectedEntryPath && entryPath !== expectedEntryPath) {
    return failPolicy("entry path does not match publication");
  }
  const timelineStatus = String(timelineFile.status ?? "").toLowerCase();
  if (timelineStatus !== "added" && timelineStatus !== "modified") {
    return failPolicy("TIMELINE.md must be added or modified");
  }
  return Object.freeze({ ok: true, paths: scoped.paths, entryPath, timelineStatus });
}

export function inspectPullMetadata(pull, expected) {
  if (!pull || typeof pull !== "object") return failPolicy("missing pull metadata");
  if (pull.base?.ref !== "main") return failPolicy("PR base must be main");
  if (pull.base?.sha !== expected.baseSha) return failPolicy("PR base SHA is not the captured main SHA");
  const headOwner = pull.head?.repo?.owner?.login ?? pull.head?.user?.login;
  const headName = pull.head?.repo?.name;
  const headFull = pull.head?.repo?.full_name ?? (headOwner && headName ? `${headOwner}/${headName}` : null);
  if (headFull && headFull !== `${expected.owner}/${expected.repo}`) {
    return failPolicy("PR head repo is not the allowed repository");
  }
  if (pull.head?.ref !== expected.branch) return failPolicy("PR head branch is not the expected branch");
  if (pull.head?.sha !== expected.headSha) return failPolicy("PR head SHA is not the expected commit");
  if (typeof pull.changed_files === "number" && pull.changed_files !== 2) {
    return failPolicy("PR must change exactly two files");
  }
  return Object.freeze({ ok: true });
}

export function samePublicationBinding(left, right) {
  return left?.baseSha === right?.baseSha
    && left?.branch === right?.branch
    && left?.entrySha === right?.entrySha
    && left?.timelineSha === right?.timelineSha
    && (right?.expectedHeadSha == null || left?.expectedHeadSha == null || left.expectedHeadSha === right.expectedHeadSha);
}

export function publicationKey({ date, slug, contentSha }) {
  return sha256Text(`${date}:${slug}:${contentSha}`);
}
