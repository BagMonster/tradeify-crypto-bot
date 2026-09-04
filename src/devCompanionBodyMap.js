import { readFileSync } from "node:fs";
import { join } from "node:path";

const BLOCKED_NAME = /(?:^|\/)(?:\.env(?:\..*)?|credentials|secrets?)(?:\/|$)/i;

const SOURCES = Object.freeze([
  { path: "docs/chronicle/WHO_I_AM.md", maxChars: 2200 },
  { path: "docs/chronicle/AUTHORIAL_CHARTER.md", maxChars: 1800 },
  { path: "docs/chronicle/LIVE_CONTEXT.md", maxChars: 2800 },
  { path: "config/instruments.json", maxChars: 2800 },
  { path: "docs/implementation-decision-log.md", maxChars: 2800, headOnly: true },
  { path: "README.md", maxChars: 2500 },
  { path: "docs/telegram-command-reference.md", maxChars: 1800, headOnly: true }
]);

function clip(text, maxChars) {
  const raw = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars).trimEnd()}\n…[truncated]`;
}

export function readDeployedFile(rootDir, relativePath, { maxChars = 4000, headOnly = false } = {}) {
  if (typeof relativePath !== "string" || relativePath.includes("..") || BLOCKED_NAME.test(relativePath)) {
    throw new TypeError("body-map path is not allowed");
  }
  const absolute = join(rootDir, relativePath);
  const raw = readFileSync(absolute, "utf8");
  const source = headOnly ? raw.split("\n").slice(0, 80).join("\n") : raw;
  return clip(source, maxChars);
}

export function loadBodyMap(rootDir = process.cwd()) {
  const sections = [];
  for (const source of SOURCES) {
    try {
      const text = readDeployedFile(rootDir, source.path, source);
      sections.push(`## ${source.path}\n${text}`);
    } catch {
      sections.push(`## ${source.path}\n[not present in this checkout]`);
    }
  }
  return [
    "BODY MAP from this Railway checkout. Treat as your own deployed body.",
    "Live fills and warnings live in SNAPSHOT /alerts when present. That tape beats this map for 'what just happened'.",
    "config/strategy.json is historical SOL-only. Live books are config/instruments.json: SOL, DOGE, INJ, AAVE, AVAX.",
    "Never quote or request secrets, tokens, database URLs, or DXtrade credentials.",
    sections.join("\n\n")
  ].join("\n\n");
}
