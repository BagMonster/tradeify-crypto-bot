export const SNAPSHOT_SLOTS = Object.freeze(["/status", "/levels", "/rings", "/health", "/other"]);

export function snapshotSlot(command) {
  const value = String(command ?? "").trim().toLowerCase();
  if (value === "/status" || value === "status") return "/status";
  if (value === "/levels" || value === "levels") return "/levels";
  if (value === "/rings" || value === "rings") return "/rings";
  if (value === "/health" || value === "health") return "/health";
  return "/other";
}

export function emptySnapshotPack() {
  return {
    "/status": null,
    "/levels": null,
    "/rings": null,
    "/health": null,
    "/other": null
  };
}

export function parseSnapshotPack(raw) {
  const pack = emptySnapshotPack();
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const slot of SNAPSHOT_SLOTS) {
      const item = raw[slot];
      if (item && typeof item.text === "string" && item.text.trim()) {
        pack[slot] = {
          command: typeof item.command === "string" ? item.command : slot,
          text: item.text.trim(),
          at: item.at ?? null
        };
      }
    }
  }
  return pack;
}

export function upsertSnapshotPack(existing, command, text, at = new Date().toISOString()) {
  const pack = parseSnapshotPack(existing);
  const slot = snapshotSlot(command);
  pack[slot] = {
    command: slot === "/other" ? String(command) : slot,
    text: String(text).trim(),
    at
  };
  return pack;
}

export function formatSnapshotPack(pack) {
  const parsed = parseSnapshotPack(pack);
  const present = [];
  const missing = [];
  const blocks = [];
  for (const slot of SNAPSHOT_SLOTS) {
    const item = parsed[slot];
    if (item) {
      present.push(slot);
      blocks.push(`SNAPSHOT ${slot} at ${item.at ?? "unknown time"}:\n${item.text}`);
    } else {
      missing.push(slot);
    }
  }
  return {
    present,
    missing,
    text: blocks.length === 0
      ? ""
      : [
        "OPERATOR SNAPSHOT PACK",
        `Present: ${present.join(", ")}`,
        `Missing: ${missing.join(", ") || "none"}`,
        ...blocks
      ].join("\n\n")
  };
}
