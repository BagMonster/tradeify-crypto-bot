import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLiveTelegramNotifications,
  formatLiveTelegramNotification as format
} from "../src/notifications/liveTelegramNotifications.js";

// On 2026-09-20 PROTECTION_FAILED, PROTECTION_RECOVERED and SESSION_ROTATION_FAILED
// were enqueued by production code but missing from the formatter's allowlist.
// notify() swallows formatter errors, so every one of those alerts was dropped with
// only a TELEGRAM_NOTIFICATION_REJECTED row in Postgres. These tests exist so an
// alert kind can never again be added on one side without the other.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function sourceFiles() {
  const out = [path.join(ROOT, "index.mjs")];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) out.push(full);
    }
  }
  await walk(path.join(ROOT, "src"));
  return out;
}

// An alert object literal always carries both a kind and an eventKey. Matching on
// the pair keeps unrelated `kind:` fields (signal payloads, companion state) out.
async function enqueuedKinds() {
  const kinds = new Map();
  for (const file of await sourceFiles()) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/kind:\s*"([A-Z0-9_]+)"/g)) {
      const window = text.slice(Math.max(0, match.index - 200), match.index + 300);
      if (!/eventKey\s*:/.test(window)) continue;
      if (!kinds.has(match[1])) kinds.set(match[1], path.relative(ROOT, file));
    }
  }
  return kinds;
}

test("every alert kind enqueued anywhere in production code is accepted by the formatter", async () => {
  const kinds = await enqueuedKinds();
  assert.ok(kinds.size >= 10, `expected to discover the alert call sites, found ${kinds.size}`);
  for (const mustFind of ["PROTECTION_FAILED", "PROTECTION_RECOVERED", "SESSION_ROTATION_FAILED", "SAFETY_HALT"]) {
    assert.ok(kinds.has(mustFind), `scanner did not find ${mustFind}; the discovery heuristic has drifted`);
  }
  for (const [kind, file] of kinds) {
    let error = null;
    try { format({ kind, eventKey: "COVERAGE:1" }); } catch (e) { error = e; }
    assert.ok(
      error === null || !/kind is unsupported/.test(error.message),
      `${kind} (enqueued in ${file}) is not registered in the formatter — it would be silently dropped`
    );
  }
});

// Payloads below are copied from the real call sites, not invented.

test("PROTECTION_FAILED formats with the riskSupervisor payload", () => {
  const { message } = format({
    kind: "PROTECTION_FAILED",
    eventKey: "PROT-FAIL:1758300000000:1",
    consecutiveFailedCuts: 1,
    failureStatus: "ACCOUNT_DATA_UNAVAILABLE",
    outageMs: 0,
    totalUnrealisedUsd: -187.4,
    combinedDayPnlUsd: -212.15
  });
  assert.match(message, /^🚨 PROTECTIVE CUT FAILED/m);
  assert.match(message, /Broker result: ACCOUNT_DATA_UNAVAILABLE/);
  assert.match(message, /Account-day P&L: −\$212\.15/);
  assert.match(message, /\/relogin/);
  assert.match(message, /DXtrade platform directly/);
});

test("PROTECTION_FAILED still delivers when optional fields are missing", () => {
  const { message } = format({ kind: "PROTECTION_FAILED", eventKey: "PROT-FAIL:1:3", failureStatus: null, outageMs: null });
  assert.match(message, /Broker result: UNKNOWN/);
  assert.match(message, /Outage so far: unknown/);
});

test("PROTECTION_RECOVERED formats, including a null outage", () => {
  const recovered = format({
    kind: "PROTECTION_RECOVERED",
    eventKey: "PROT-OK:1758304800000",
    outageMs: 4_800_000,
    totalUnrealisedUsd: -90,
    combinedDayPnlUsd: -140
  });
  assert.match(recovered.message, /Outage lasted: 1h 20m/);
  assert.match(format({ kind: "PROTECTION_RECOVERED", eventKey: "PROT-OK:2", outageMs: null }).message, /unknown/);
});

test("SESSION_ROTATION_FAILED names sessions and never echoes broker error text", () => {
  const { message } = format({
    kind: "SESSION_ROTATION_FAILED",
    eventKey: "SESSION-ROT-FAIL:2026-09-20",
    failed: [
      { name: "account-monitor", error: "HTTP 401 token=do-not-echo" },
      { name: "INJ/USD execution", error: "HTTP 429 Too many requests" }
    ]
  });
  assert.match(message, /account-monitor, INJ\/USD execution/);
  assert.doesNotMatch(message, /do-not-echo|401|429/);
});

test("execution-block and inert-cut alerts format and validate", () => {
  const blocked = format({
    kind: "EXECUTION_BLOCKED",
    eventKey: "EXEC-BLOCKED:INJGRID:1758300000000",
    instrument: "INJ/USD",
    path: "EXIT",
    reasonCode: "ACCOUNT_DATA_UNAVAILABLE"
  });
  assert.match(blocked.message, /INJ\/USD EXIT BLOCKED/);
  assert.match(blocked.message, /cannot close anything/);

  const recovered = format({
    kind: "EXECUTION_RECOVERED",
    eventKey: "EXEC-RECOVERED:INJGRID:1758300000000",
    instrument: "INJ/USD",
    outageMs: 95_000,
    blockedCount: 18
  });
  assert.match(recovered.message, /Outage lasted: 1m 35s/);
  assert.match(recovered.message, /blocked during the outage: 18/);

  const inert = format({ kind: "CUT_TIER_INERT", eventKey: "CUT-INERT:20260920:100:1", combinedDayPnlUsd: -118.2, thresholdUsd: 100 });
  assert.match(inert.message, /NOTHING TO CUT/);

  assert.throws(() => format({
    kind: "EXECUTION_BLOCKED",
    eventKey: "EXEC-BLOCKED:bad",
    instrument: "INJ/USD\nSESSION_TOKEN=secret",
    path: "EXIT"
  }), /instrument is invalid/);
});

// Halt warnings: every reason string as the callers actually build it.

function warning(overrides) {
  return {
    kind: "HALT_WARNING",
    eventKey: "HALT-WARNING:TEST:1:20260920120000",
    warningNumber: 1,
    warningCount: 5,
    haltAt: "2026-09-20T12:25:00.000Z",
    correction: "Inspect /status and DXtrade.",
    ...overrides
  };
}

test("D060 full-flatten warning is delivered despite the ampersand in P&L", () => {
  const { message } = format(warning({
    reasonCode: "D060_ACCOUNT_FULL_FLATTEN",
    reason: "Account-day P&L is -251.20, at or below the -250.00 full-flatten threshold.",
    correction: "Inspect /status and DXtrade. Send /pausehalt to defer the account flatten for another 25-minute warning cycle."
  }));
  assert.match(message, /Account-day P&L is -251\.20/);
  assert.match(message, /\/pausehalt/);
});

test("runtime-error warning is delivered with its exception detail stripped", () => {
  const { message } = format(warning({
    reasonCode: "RUNTIME_ERROR",
    instrument: "INJ/USD",
    reason: "INJ/USD [Cannot read properties of undefined (reading 'x')] production runtime error; owner review required"
  }));
  assert.match(message, /INJ\/USD production runtime error; owner review required/);
  assert.doesNotMatch(message, /Cannot read properties/);
});

test("hybrid reconciliation warning and halt are both delivered", () => {
  const warned = format(warning({
    reasonCode: "HYBRID_UNEXPLAINED_NET",
    instrument: "INJ/USD",
    reason: "INJ/USD diverged from the DXtrade book and no manual fill explains it: book reported a null net; production runtime error; owner review required",
    correction: "Inspect /status and /rawhistory, then reconcile in DXtrade. /pausehalt defers this for a fresh 25-minute warning cycle, and /rerun clears it once every book matches."
  }));
  assert.match(warned.message, /HYBRID_UNEXPLAINED_NET/);
  const halted = format({ kind: "SAFETY_HALT", eventKey: "HALT-FIRED:hybrid:1", reasonCode: "HYBRID_UNEXPLAINED_NET", instrument: "INJ/USD" });
  assert.match(halted.message, /SAFETY HALT — HYBRID_UNEXPLAINED_NET/);
  assert.match(halted.message, /\/rerun/);
});

test("unsafe reason text is withheld, never echoed, and never drops the warning", () => {
  for (const reason of ["Blocked\nOrder result: ORDER PLACED", "Blocked‮PASS", "token=abc123"]) {
    const { message } = format(warning({ reasonCode: "RUNTIME_ERROR", reason }));
    assert.match(message, /Reason text withheld/);
    assert.doesNotMatch(message, /ORDER PLACED|PASS|abc123/);
  }
});

test("a new kind reaches the sender end-to-end instead of being rejected", async () => {
  const rows = new Map();
  const sent = [];
  const notifications = createLiveTelegramNotifications({
    persistence: {
      async claimTelegramNotification({ eventKey }) {
        if (rows.has(eventKey)) return { claimed: false, status: rows.get(eventKey) };
        rows.set(eventKey, "CLAIMED");
        return { claimed: true };
      },
      async markTelegramNotificationSent(eventKey) { rows.set(eventKey, "SENT"); },
      async markTelegramNotificationFailed(eventKey) { rows.set(eventKey, "FAILED"); }
    }
  });
  notifications.setSender(async (message) => { sent.push(message); });
  const result = await notifications.notify({
    kind: "PROTECTION_FAILED",
    eventKey: "PROT-FAIL:1758300000000:1",
    consecutiveFailedCuts: 1,
    failureStatus: "ACCOUNT_DATA_UNAVAILABLE",
    outageMs: 0
  });
  assert.equal(result.status, "SENT");
  assert.equal(sent.length, 1);
});
