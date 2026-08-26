export const ALLOWED_OWNER = "BagMonster";
export const ALLOWED_REPO = "tradeify-crypto-bot";
export const DEFAULT_REF = "main";
export const MAX_FILE_CHARS = 12000;
export const MAX_LIST_ENTRIES = 80;
export const MAX_SEARCH_RESULTS = 8;
export const MAX_SEARCH_QUERY_CHARS = 180;

const BLOCKED_PATH = /(?:^|\/)(?:\.env(?:\..*)?|credentials|secrets?)(?:\/|$)/i;
const BLOCKED_FILE = /(?:^|\/)(?:id_rsa|id_ed25519|.+\.(?:pem|p12|pfx|key))$/i;
const REF_PATTERN = /^[A-Za-z0-9._/-]{1,128}$/;
const BINARY_HINT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

export function clipText(text, maxChars = MAX_FILE_CHARS) {
  const raw = String(text ?? "").replace(/\r\n/g, "\n");
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars).trimEnd()}\n…[truncated]`;
}

export function normalizeRepoPath(value) {
  if (value == null || value === "" || value === "." || value === "./") return "";
  let path = String(value).trim().replace(/\\/g, "/");
  if (path.startsWith("/")) path = path.slice(1);
  if (path.endsWith("/") && path.length > 1) path = path.slice(0, -1);
  if (path.includes("\0") || path.includes("..") || path.startsWith(".git/") || path === ".git") {
    throw new TypeError("repository path is not allowed");
  }
  return path;
}

export function assertReadablePath(value) {
  const path = normalizeRepoPath(value);
  if (BLOCKED_PATH.test(path) || BLOCKED_FILE.test(path)) {
    throw new TypeError("repository path is blocked");
  }
  return path;
}

export function normalizeRef(value) {
  if (value == null || String(value).trim() === "") return DEFAULT_REF;
  const ref = String(value).trim();
  if (ref.includes("..") || !REF_PATTERN.test(ref)) {
    throw new TypeError("repository ref is not allowed");
  }
  return ref;
}

export function pinSearchQuery(raw) {
  const stripped = String(raw ?? "")
    .replace(/\b(?:repo|org|user|from|owner):[^\s]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) throw new TypeError("search query is required");
  if (stripped.length > MAX_SEARCH_QUERY_CHARS) {
    throw new TypeError(`search query must be at most ${MAX_SEARCH_QUERY_CHARS} characters`);
  }
  return `${stripped} repo:${ALLOWED_OWNER}/${ALLOWED_REPO}`;
}

function fail(error) {
  return Object.freeze({ ok: false, error: String(error) });
}

function decodeFileContent(payload) {
  if (typeof payload.content !== "string") return "";
  const encoded = payload.content.replace(/\s+/g, "");
  const raw = Buffer.from(encoded, payload.encoding === "base64" ? "base64" : "utf8").toString("utf8");
  if (BINARY_HINT.test(raw)) {
    throw new TypeError("file looks binary and will not be returned");
  }
  return raw;
}

export function createGithubInspector({
  token = "",
  fetchImpl = fetch,
  owner = ALLOWED_OWNER,
  repo = ALLOWED_REPO,
  userAgent = "tradeify-dev-companion"
} = {}) {
  if (owner !== ALLOWED_OWNER || repo !== ALLOWED_REPO) {
    throw new TypeError("companion GitHub tools are locked to BagMonster/tradeify-crypto-bot");
  }

  async function githubJson(url, { accept } = {}) {
    if (typeof token !== "string" || token.trim() === "") {
      return fail("GITHUB_TOKEN is not configured on the companion worker");
    }
    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        Accept: accept || "application/vnd.github+json",
        "User-Agent": userAgent,
        "X-GitHub-Api-Version": "2022-11-28"
      },
      signal: AbortSignal.timeout(20000)
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message = payload?.message ? String(payload.message) : `GitHub HTTP ${response.status}`;
      return fail(message);
    }
    return Object.freeze({ ok: true, payload });
  }

  async function listFiles({ path, ref } = {}) {
    let normalizedPath;
    let normalizedRef;
    try {
      normalizedPath = assertReadablePath(path);
      normalizedRef = normalizeRef(ref);
    } catch (error) {
      return fail(error.message);
    }
    const suffix = normalizedPath ? `/${normalizedPath.split("/").map(encodeURIComponent).join("/")}` : "";
    const url = `https://api.github.com/repos/${owner}/${repo}/contents${suffix}?ref=${encodeURIComponent(normalizedRef)}`;
    const result = await githubJson(url);
    if (!result.ok) return result;
    if (Array.isArray(result.payload)) {
      const entries = result.payload
        .map((entry) => ({
          type: entry?.type === "dir" ? "dir" : "file",
          path: String(entry?.path ?? entry?.name ?? ""),
          size: Number.isFinite(entry?.size) ? Number(entry.size) : null
        }))
        .filter((entry) => entry.path && !BLOCKED_PATH.test(entry.path) && !BLOCKED_FILE.test(entry.path))
        .slice(0, MAX_LIST_ENTRIES);
      return Object.freeze({
        ok: true,
        repo: `${owner}/${repo}`,
        ref: normalizedRef,
        path: normalizedPath || ".",
        truncated: result.payload.length > MAX_LIST_ENTRIES,
        entries
      });
    }
    if (result.payload?.type === "file") {
      return Object.freeze({
        ok: true,
        repo: `${owner}/${repo}`,
        ref: normalizedRef,
        path: String(result.payload.path ?? normalizedPath),
        truncated: false,
        entries: [{ type: "file", path: String(result.payload.path ?? normalizedPath), size: Number(result.payload.size ?? 0) }]
      });
    }
    return fail("unexpected GitHub contents response");
  }

  async function readFile({ path, ref } = {}) {
    let normalizedPath;
    let normalizedRef;
    try {
      normalizedPath = assertReadablePath(path);
      normalizedRef = normalizeRef(ref);
    } catch (error) {
      return fail(error.message);
    }
    if (!normalizedPath) return fail("read_repo_file requires a file path");
    const suffix = `/${normalizedPath.split("/").map(encodeURIComponent).join("/")}`;
    const url = `https://api.github.com/repos/${owner}/${repo}/contents${suffix}?ref=${encodeURIComponent(normalizedRef)}`;
    const result = await githubJson(url);
    if (!result.ok) return result;
    if (Array.isArray(result.payload)) {
      return fail(`${normalizedPath} is a directory; use list_repo_files`);
    }
    if (result.payload?.type !== "file") return fail("path is not a readable file");
    try {
      const content = clipText(decodeFileContent(result.payload));
      return Object.freeze({
        ok: true,
        repo: `${owner}/${repo}`,
        ref: normalizedRef,
        path: String(result.payload.path ?? normalizedPath),
        sha: typeof result.payload.sha === "string" ? result.payload.sha : null,
        truncated: content.includes("…[truncated]"),
        content
      });
    } catch (error) {
      return fail(error.message);
    }
  }

  async function searchCode({ query } = {}) {
    let pinned;
    try {
      pinned = pinSearchQuery(query);
    } catch (error) {
      return fail(error.message);
    }
    const url = `https://api.github.com/search/code?q=${encodeURIComponent(pinned)}&per_page=${MAX_SEARCH_RESULTS}`;
    const result = await githubJson(url, { accept: "application/vnd.github.text-match+json" });
    if (!result.ok) return result;
    const items = Array.isArray(result.payload?.items) ? result.payload.items : [];
    const matches = items
      .filter((item) => String(item?.repository?.full_name ?? "") === `${owner}/${repo}`)
      .filter((item) => !BLOCKED_PATH.test(String(item?.path ?? "")) && !BLOCKED_FILE.test(String(item?.path ?? "")))
      .slice(0, MAX_SEARCH_RESULTS)
      .map((item) => {
        const fragments = Array.isArray(item.text_matches)
          ? item.text_matches
            .flatMap((match) => (typeof match?.fragment === "string" ? [clipText(match.fragment, 400)] : []))
            .slice(0, 2)
          : [];
        return Object.freeze({
          path: String(item.path ?? ""),
          sha: typeof item.sha === "string" ? item.sha : null,
          fragments
        });
      });
    return Object.freeze({
      ok: true,
      repo: `${owner}/${repo}`,
      query: pinned,
      total: Number(result.payload?.total_count ?? matches.length),
      matches
    });
  }

  async function executeTool(name, rawArgs = {}) {
    const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
    if (name === "list_repo_files") return listFiles(args);
    if (name === "read_repo_file") return readFile(args);
    if (name === "search_repo_code") return searchCode(args);
    return fail(`unknown tool ${name}`);
  }

  return Object.freeze({
    listFiles,
    readFile,
    searchCode,
    executeTool
  });
}
