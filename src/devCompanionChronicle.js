import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const CHRONICLE_PREFIX = "docs/chronicle/";
export const BRANCH_PREFIX = "docs/bmtb1/";
export const WRITE_DOMAIN = "github-write";
export const MAX_FILE_CHARS = 80000;
export const MAX_TOTAL_CHARS = 200000;
export const MAX_FILES = 8;
export const CODE_TTL_MS = 10 * 60 * 1000;

const BRANCH_TAIL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const BINARY_HINT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const SECRET_PATTERN = new RegExp([
  "BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY",
  "\\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}",
  "\\b(?:sk-|rk-)[A-Za-z0-9]{20,}",
  "(?:postgres|postgresql|mongodb|mysql|redis):\\/\\/[^\\s]+",
  "(?:GITHUB_TOKEN|OPENAI_API_KEY|TELEGRAM_BOT_TOKEN|DXTRADE_PASSWORD|DATABASE_URL)\\s*=\\s*\\S+"
].join("|"), "i");

export function sha256Text(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function hashWriteCode(code, salt, proposalId) {
  return createHash("sha256").update(`${salt}:${WRITE_DOMAIN}:${proposalId}:${code}`).digest("hex");
}

export function safeHexEqual(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function newProposalId() {
  return `cw-${randomBytes(6).toString("hex")}`;
}

export function newWriteCode() {
  return String(randomInt(100000, 1000000));
}

export function newSalt() {
  return randomBytes(16).toString("hex");
}

export function assertChroniclePath(value) {
  const raw = String(value ?? "").trim().replace(/\\/g, "/");
  if (!raw) throw new TypeError("file path is required");
  if (raw.startsWith("/") || raw.includes("\0") || raw.includes("..")) {
    throw new TypeError("chronicle path is not allowed");
  }
  if (raw.includes("//") || raw.endsWith("/") || raw.includes("\\")) {
    throw new TypeError("chronicle path is not allowed");
  }
  if (!raw.startsWith(CHRONICLE_PREFIX)) {
    throw new TypeError("only docs/chronicle/** may be written");
  }
  if (raw === CHRONICLE_PREFIX.slice(0, -1)) {
    throw new TypeError("chronicle path must be a file");
  }
  if (!raw.endsWith(".md")) throw new TypeError("chronicle files must be Markdown (.md)");
  if (/(?:^|\/)(?:\.env(?:\..*)?|credentials|secrets?)(?:\/|$)/i.test(raw)) {
    throw new TypeError("chronicle path is blocked");
  }
  return raw;
}

export function assertChronicleBranch(value) {
  const branch = String(value ?? "").trim();
  if (!branch.startsWith(BRANCH_PREFIX)) {
    throw new TypeError(`branch must start with ${BRANCH_PREFIX}`);
  }
  const tail = branch.slice(BRANCH_PREFIX.length);
  if (!BRANCH_TAIL.test(tail) || tail.includes("..")) {
    throw new TypeError("branch name is not allowed");
  }
  if (branch === "main" || branch.startsWith("main/") || /force|delete/i.test(branch)) {
    throw new TypeError("branch name is not allowed");
  }
  return branch;
}

export function assertMarkdownContent(content) {
  if (typeof content !== "string") throw new TypeError("file content must be text");
  if (BINARY_HINT.test(content)) throw new TypeError("binary content is not allowed");
  if (content.length > MAX_FILE_CHARS) {
    throw new TypeError(`file exceeds ${MAX_FILE_CHARS} characters`);
  }
  if (SECRET_PATTERN.test(content)) {
    throw new TypeError("content looks like a secret and was rejected");
  }
  return content.replace(/\r\n/g, "\n");
}

export function normalizeProposalFiles(rawFiles) {
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw new TypeError("at least one chronicle file is required");
  }
  if (rawFiles.length > MAX_FILES) {
    throw new TypeError(`at most ${MAX_FILES} files per proposal`);
  }
  const seen = new Set();
  const files = rawFiles.map((entry) => {
    const path = assertChroniclePath(entry?.path);
    if (seen.has(path)) throw new TypeError(`duplicate path ${path}`);
    seen.add(path);
    const content = assertMarkdownContent(entry?.content ?? "");
    return Object.freeze({
      path,
      content,
      contentSha256: sha256Text(content)
    });
  });
  const total = files.reduce((sum, file) => sum + file.content.length, 0);
  if (total > MAX_TOTAL_CHARS) throw new TypeError("proposal exceeds total size limit");
  return Object.freeze(files);
}

export function proposalContentHash(files) {
  const canonical = normalizeProposalFiles(files)
    .map((file) => `${file.path}\0${file.contentSha256}`)
    .join("\n");
  return sha256Text(canonical);
}

export function sanitizeProposalInput(raw = {}) {
  const files = normalizeProposalFiles(raw.files);
  const branchName = assertChronicleBranch(
    raw.branchName || raw.branch || `${BRANCH_PREFIX}${new Date().toISOString().slice(0, 10)}-entry`
  );
  const commitMessage = String(raw.commitMessage ?? raw.commit_message ?? "").trim();
  const prTitle = String(raw.prTitle ?? raw.pr_title ?? "").trim();
  const prBody = String(raw.prBody ?? raw.pr_body ?? "").trim();
  if (!commitMessage || commitMessage.length > 200) throw new TypeError("commit message is required and must be short");
  if (!prTitle || prTitle.length > 200) throw new TypeError("PR title is required");
  if (!prBody || prBody.length > 4000) throw new TypeError("PR body is required");
  if (/merge|deploy|force-push|delete branch/i.test(`${commitMessage}\n${prTitle}\n${prBody}`)) {
    throw new TypeError("proposal text may not request merge, deploy, force-push, or branch deletion");
  }
  return Object.freeze({
    branchName,
    files,
    commitMessage,
    prTitle,
    prBody,
    contentHash: proposalContentHash(files)
  });
}

export const FORBIDDEN_TOOL_NAMES = Object.freeze([
  "merge_pull_request",
  "deploy",
  "delete_branch",
  "force_push",
  "write_repo_file",
  "push_to_main"
]);
