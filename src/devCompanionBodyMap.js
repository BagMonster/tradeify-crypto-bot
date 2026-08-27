import { readFileSync } from "node:fs";
import { join } from "node:path";

const BLOCKED_NAME = /(?:^|\/)(?:\.env(?:\..*)?|credentials|secrets?)(?:\/|$)/i;

const SOURCES = Object.freeze([
  { path: "docs/chronicle/WHO_I_AM.md", maxChars: 2200 },
  { path: "docs/chronicle/AUTHORIAL_CHARTER.md", maxChars: 2200 },
  { path: "config/strategy.json", maxChars: 2500 },
  { path: "README.md", maxChars: 3500 },
  { path: "docs/decisions/D-049-sol-risk-ladder-and-resize.md", maxChars: 4000 },
  { path: "src/strategies/solanaGrid.js", maxChars: 2200, headOnly: true },
  { path: "docs/telegram-command-reference.md", maxChars: 2200, headOnly: true }
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
    "BODY MAP from this Railway checkout. Treat as your own deployed body, not live account telemetry.",
    "Never quote or request secrets, tokens, database URLs, or DXtrade credentials.",
    sections.join("\n\n")
  ].join("\n\n");
}
