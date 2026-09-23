import { createSolanaOwnerService } from "./solanaOwnerService.js";
import { createRuntimeHaltRerunHandlers } from "./state/runtimeHaltRerun.js";
import { accountDayKey } from "./risk/dailyRiskLadder.js";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const SEPARATOR = "\u2014".repeat(28);
const D064_FLAT_CONFIRMATION_HALT = "D-064 harvest could not confirm every book flat; owner review required";
const FLAT_EPSILON = 1e-8;

function normaliseInstrument(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const key = raw.trim().toUpperCase();
  return key.includes("/") ? key : `${key}/USD`;
}

function money(value) {
  if (!Number.isFinite(value)) return "unavailable";
  return `${value < 0 ? "-$" : "$"}${Math.abs(value).toFixed(2)}`;
}

function pct(fraction) {
  const n = Number(fraction);
  if (!Number.isFinite(n)) return "?";
  return `${Math.round(n * 100)}%`;
}

export function formatRiskLadderLine(snapshot) {
  const brake = money(-Math.abs(snapshot?.entryBrakeUsd ?? 300));
  const flatten = money(-Math.abs(snapshot?.fullFlattenUsd ?? 1250));
  const rawTiers = Array.isArray(snapshot?.cutTiers) && snapshot.cutTiers.length > 0
    ? snapshot.cutTiers
    : [{ thresholdUsd: snapshot?.partialCutUsd ?? 1000, fraction: snapshot?.partialCutFraction ?? 0.5 }];
  const cuts = [...rawTiers]
    .filter((tier) => Number.isFinite(Number(tier?.thresholdUsd)) && Number(tier.thresholdUsd) > 0)
    .sort((a, b) => a.thresholdUsd - b.thresholdUsd)
    .map((tier) => `${pct(tier.fraction)} at ${money(-Math.abs(tier.thresholdUsd))}`)
    .join(", ");
  return `  ladder: brake ${brake} per instrument | cuts ${cuts || money(-Math.abs(snapshot?.partialCutUsd ?? 1000))} | flatten ${flatten} account-wide`;
}

export function createMultiInstrumentOwnerService({
  brokerAccountLine = null,
  // Account-wide exposure pool line for /status (supplied by index.mjs).
  exposurePoolLine = null,
  instrumentConfigs,
  buildOwnerService = createSolanaOwnerService,
  riskSupervisor = null,
  sharedPause = null,
  database = null,
  haltWarnings = null,
  onRuntimeHaltCleared = async () => {},
  // Supplied by index.mjs, which owns the DXtrade clients and the runtimes.
  // Routing these through callbacks keeps the per-book owner services out of
  // it entirely - none of them need to know about sessions or flattening.
  reloginAll = null,
  flattenAll = null,
  executionHealth = null
}) {
  if (!Array.isArray(instrumentConfigs) || instrumentConfigs.length === 0) {
    throw new TypeError("instrumentConfigs must be a non-empty array");
  }

  const enabled = instrumentConfigs.filter((cfg) => cfg.enabled === true);
  if (enabled.length === 0) throw new TypeError("at least one instrument must be enabled");

  const books = enabled.map((cfg) => Object.freeze({
    instrument: cfg.instrument,
    prefix: cfg.orderPrefix,
    service: buildOwnerService(cfg)
  }));
  const byInstrument = new Map(books.map((b) => [b.instrument, b]));

  async function inspectBooks() {
    const rows = [];
    for (const book of books) {
      if (typeof book.service.inspectForRerun !== "function") {
        rows.push(Object.freeze({ instrument: book.instrument, ok: false, match: false, virtualNet: null, brokerNet: null, openLots: 0, error: "inspectForRerun is not available" }));
        continue;
      }
      rows.push(await book.service.inspectForRerun());
    }
    return rows;
  }

  function harvestRecoveryHash(code, salt, recoveryKind) {
    return createHash("sha256").update(`${salt}:d064-harvest-recovery:${recoveryKind}:${code}`).digest("hex");
  }

  function sameHex(left, right) {
    return Boolean(left && right && left.length === right.length && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex")));
  }

  function rowsText(rows) {
    return rows.map((row) => `  ${row.instrument}: virtual ${Number.isFinite(row.virtualNet) ? row.virtualNet.toFixed(8) : "unavailable"}  broker ${Number.isFinite(row.brokerNet) ? row.brokerNet.toFixed(8) : "unavailable"}  lots ${row.openLots}  ${row.match === true ? "MATCH" : "MISMATCH"}`).join("\n");
  }

  function d064RecoveryKind(harvest) {
    if (harvest?.status !== "HALTED" || typeof harvest.haltReason !== "string") return null;
    if (harvest.haltReason.startsWith("D-064 harvest cannot verify fresh broker account data for ")) return "FRESH_DATA";
    if (harvest.haltReason === D064_FLAT_CONFIRMATION_HALT) return "VERIFIED_FLAT";
    return null;
  }

  function rowsAreReconciled(rows) {
    return rows.every((row) => row.ok === true && row.match === true);
  }

  function rowsAreConfirmedFlat(rows) {
    return rowsAreReconciled(rows) && rows.every((row) => {
      const virtualNet = Number(row.virtualNet);
      const brokerNet = Number(row.brokerNet);
      const openLots = Number(row.openLots);
      return Number.isFinite(virtualNet) && Math.abs(virtualNet) <= FLAT_EPSILON &&
        Number.isFinite(brokerNet) && Math.abs(brokerNet) <= FLAT_EPSILON &&
        Number.isInteger(openLots) && openLots === 0;
    });
  }

  function recoveryRowsAreSafe(rows, recoveryKind) {
    return recoveryKind === "VERIFIED_FLAT" ? rowsAreConfirmedFlat(rows) : rowsAreReconciled(rows);
  }

  function recoveryRowsFailureText(rows, recoveryKind, phase) {
    const heading = recoveryKind === "VERIFIED_FLAT"
      ? `D-064 RECOVERY ${phase} — BOOKS NOT CONFIRMED FLAT`
      : `D-064 RECOVERY ${phase} — BOOKS NOT RECONCILED`;
    const instruction = recoveryKind === "VERIFIED_FLAT"
      ? "Every book must have fresh data, virtual net 0, broker net 0, and 0 open virtual lots. Recovery will not alter virtual lots or place a DXtrade order."
      : "Reconcile every broker-visible book first. Recovery will not alter virtual lots or place a DXtrade order.";
    return [heading, "", rowsText(rows), "", instruction].join("\n");
  }

  const rerun = database
    ? createRuntimeHaltRerunHandlers({
      database,
      onRuntimeHaltCleared,
      inspectBooks
    })
    : {
      requestRerun: async () => ({ message: "Re-run is not configured on this deployment." }),
      confirmRerun: async () => "Re-run is not configured on this deployment."
    };

  function resolve(arg) {
    const key = normaliseInstrument(arg);
    if (key === null) return { all: true, books };
    const book = byInstrument.get(key);
    if (!book) {
      const known = books.map((b) => b.instrument).join(", ");
      return { all: false, books: [], error: `Unknown instrument "${arg}". Enabled: ${known}` };
    }
    return { all: false, books: [book] };
  }

  async function fanOut(method, arg, args = []) {
    const target = resolve(arg);
    if (target.error) return target.error;
    const blocks = [];
    for (const book of target.books) {
      let body;
      try {
        body = typeof book.service[method] === "function"
          ? await book.service[method](...args)
          : `(${method} is not available for this instrument)`;
      } catch (error) {
        body = `ERROR: ${error?.message ?? "command failed"}`;
      }
      blocks.push(target.all ? `${SEPARATOR}\n${book.instrument}\n${SEPARATOR}\n${body}` : body);
    }
    return blocks.join("\n\n");
  }

  function safePoolLine() {
    try {
      return exposurePoolLine() || "  exposure pool: unavailable";
    } catch {
      return "  exposure pool: unavailable";
    }
  }

  function accountSummaryLines() {
    const snapshot = riskSupervisor?.getSnapshot?.() ?? null;
    if (!snapshot) return ["ACCOUNT RISK: supervisor snapshot unavailable"];
    const lines = [
      "ACCOUNT RISK",
      `  instruments enabled: ${books.length} (${books.map((b) => b.instrument).join(", ")})`,
      `  combined day P&L: ${money(snapshot.dayPnlUsd)}`,
      `  combined exposure: ${money(snapshot.exposureUsd)}`,
      ...(typeof exposurePoolLine === "function" ? [safePoolLine()] : []),
      `  daily loss limit: ${money(-Math.abs(snapshot.dailyLossLimitUsd ?? 1500))}   margin: ${money(snapshot.marginToLimitUsd)}`,
      formatRiskLadderLine(snapshot)
    ];
    const braked = Array.isArray(snapshot.brakedInstruments) ? snapshot.brakedInstruments : [];
    lines.push(`  braked today: ${braked.length === 0 ? "none" : braked.join(", ")}`);

    const per = Array.isArray(snapshot.perInstrument) ? snapshot.perInstrument : [];
    const unread = per.filter((entry) => entry.readFailed === true).map((entry) => entry.instrument);
    if (unread.length > 0) {
      lines.push(`  *** RISK DATA UNREADABLE on ${unread.length}/${per.length}: ${unread.join(", ")} ***`);
      lines.push("  Combined figures above are NOT reliable. The ladder cannot act on an unread book.");
    } else if (per.length > 0) {
      lines.push(`  risk reads: ${per.length}/${per.length} OK`);
    }
    lines.push(`  supervisor day: ${snapshot.dayKey ?? "not yet evaluated (no price tick processed since start)"}`);

    if (typeof brokerAccountLine === "function") {
      const raw = brokerAccountLine();
      if (raw) lines.push(raw);
    }
    if (snapshot.lastError) lines.push(`  supervisor note: ${snapshot.lastError}`);
    if (snapshot.freshDataGrace) {
      lines.push(`  D-064 fresh-data grace: normal grid actions blocked; ${Math.ceil(snapshot.freshDataGrace.remainingMs / 1000)}s before durable halt`);
    }
    const pendingHalt = haltWarnings?.snapshot ? haltWarnings.snapshot() : null;
    if (pendingHalt && typeof pendingHalt.then !== "function") {
      lines.push(`  pending owner-warning halt: ${pendingHalt.reasonCode} · warning ${pendingHalt.warningNumber}/5 · eligible ${pendingHalt.haltAt}`);
    }
    if (snapshot.flattenedToday === true) {
      lines.push("  *** ACCOUNT FLATTENED TODAY - all entries blocked until 22:00 UTC rollover ***");
    }
    const harvestUsd = Number(snapshot.sessionHarvestUsd);
    if (snapshot.sessionHarvestEnabled === true && Number.isFinite(harvestUsd)) {
      const harvest = snapshot.harvest ?? { status: snapshot.harvestedToday === true ? "CONFIRMED" : "READY" };
      const exits = snapshot.trancheExitsPaused === true ? "OFF" : "ON";
      lines.push(`  harvest: +${harvestUsd.toFixed(2)} · ${harvest.status} · tranche exits ${exits}`);
      if (Number.isFinite(Number(harvest.triggerPnlUsd))) lines.push(`  harvest trigger P&L: ${money(Number(harvest.triggerPnlUsd))}`);
      if (harvest.confirmedAt) lines.push(`  harvest confirmed: ${harvest.confirmedAt}`);
      if (harvest.haltReason) lines.push(`  harvest halt: ${harvest.haltReason}`);
    } else {
      lines.push("  harvest: OFF");
    }
    if (Number.isFinite(snapshot.cutsToday) && snapshot.cutsToday > 0) {
      lines.push(`  partial cuts today: ${snapshot.cutsToday}`);
    }
    return lines;
  }

  return Object.freeze({
    instruments: Object.freeze(books.map((b) => b.instrument)),
    inspectBooks,

    async statusText(arg) {
      const per = await fanOut("statusText", arg);
      return `${accountSummaryLines().join("\n")}\n\n${per}`;
    },
    async healthText(arg) {
      // The execution probe goes FIRST and on its own line. On 2026-09-19
      // /status and /health both reported 5/5 OK while every protective cut
      // was failing, because they read the account monitor's session and the
      // orders go out on a different one. A health check that does not
      // exercise the client that places orders is not a health check.
      const probe = await executionProbeLine();
      const per = await fanOut("healthText", arg);
      return `${accountSummaryLines().join("\n")}\n${probe}\n\n${per}`;
    },
    levelsText: (arg) => fanOut("levelsText", arg),
    ringsText: (arg) => fanOut("ringsText", arg),
    targetsText: (arg) => fanOut("targetsText", arg),
    dxPreflightText: (arg) => fanOut("dxPreflightText", arg),
    hybridBooks: () => {
      const out = {};
      for (const book of books) {
        if (typeof book.service.hybridBook !== "function") continue;
        out[book.instrument] = book.service.hybridBook();
      }
      return out;
    },
    recentOrderHistory: async (limit = 10) => {
      const client = books[0]?.service;
      if (typeof client?.rawOrderHistory !== "function") return [];
      const payload = await client.rawOrderHistory(limit);
      return Array.isArray(payload?.orders) ? payload.orders : [];
    },
    rawHistoryText: async (arg) => {
      const book = books[0];
      if (typeof book?.service?.rawHistoryText !== "function") {
        return "Raw order history is unavailable in this worker.";
      }
      return book.service.rawHistoryText(arg);
    },
    canaryText: (arg) => fanOut("canaryText", arg),

    flatText: (arg) => fanOut("flatText", arg),
    flatInstructions: (arg) => fanOut("flatInstructions", arg),

    async kill() {
      const results = [];
      for (const book of books) {
        try {
          results.push(`${book.instrument}: ${await book.service.kill()}`);
        } catch (error) {
          results.push(`${book.instrument}: ERROR ${error?.message ?? "kill failed"}`);
        }
      }
      if (sharedPause?.set) await sharedPause.set(true);
      return ["BOT PAUSED - every instrument", ...results].join("\n");
    },

    async requestResume(arg) {
      const target = resolve(arg);
      if (target.error) return { message: target.error };
      if (target.all) {
        return { message: `Specify an instrument: /resume <INSTRUMENT>\nEnabled: ${books.map((b) => b.instrument).join(", ")}` };
      }
      return target.books[0].service.requestResume();
    },
    confirmResume: (code, arg) => {
      const target = resolve(arg);
      if (target.error) return Promise.resolve(target.error);
      if (target.all) return Promise.resolve("Specify an instrument: /confirmresume CODE <INSTRUMENT>");
      return target.books[0].service.confirmResume(code);
    },
    async requestReconcile(arg) {
      const target = resolve(arg);
      if (target.error) return { message: target.error };
      if (target.all) {
        return { message: `Specify an instrument: /reconcile <INSTRUMENT>\nEnabled: ${books.map((b) => b.instrument).join(", ")}` };
      }
      return target.books[0].service.requestReconcile();
    },
    confirmReconcile: (code, arg) => {
      const target = resolve(arg);
      if (target.error) return Promise.resolve(target.error);
      if (target.all) return Promise.resolve("Specify an instrument: /confirmreconcile CODE <INSTRUMENT>");
      return target.books[0].service.confirmReconcile(code);
    },
    async requestRematch(arg) {
      const target = resolve(arg);
      if (target.error) return { message: target.error };
      if (target.all) {
        return { message: `Specify an instrument: /rematch <INSTRUMENT>\nEnabled: ${books.map((b) => b.instrument).join(", ")}` };
      }
      return target.books[0].service.requestRematch();
    },
    confirmRematch: (code, arg) => {
      const target = resolve(arg);
      if (target.error) return Promise.resolve(target.error);
      if (target.all) return Promise.resolve("Specify an instrument: /confirmrematch CODE <INSTRUMENT>");
      return target.books[0].service.confirmRematch(code);
    },
    async requestHarvestRecovery() {
      if (!riskSupervisor || !database) return { code: null, message: "D-064 recovery is not configured on this deployment." };
      const snapshot = riskSupervisor.getSnapshot();
      const recoveryKind = d064RecoveryKind(snapshot.harvest);
      if (!recoveryKind) return { code: null, message: "D-064 recovery is refused: the current halt is not a recoverable D-064 fresh-data or flat-confirmation halt." };
      const [botState, rows] = await Promise.all([database.getState(), inspectBooks()]);
      if (botState.safety_halt === true && botState.halt_reason !== snapshot.harvest.haltReason) {
        return { code: null, message: "D-064 recovery is refused: a different safety halt is active. It was not changed." };
      }
      if (!recoveryRowsAreSafe(rows, recoveryKind)) {
        return { code: null, message: recoveryRowsFailureText(rows, recoveryKind, "REFUSED") };
      }
      const code = String(randomInt(100000, 1000000));
      const salt = randomBytes(16).toString("hex");
      await database.setResumeChallenge(harvestRecoveryHash(code, salt, recoveryKind), salt, new Date(Date.now() + 10 * 60 * 1000));
      await database.addEvent("WARN", "D064_HARVEST_RECOVERY_REQUESTED", { source: "telegram", dayKey: snapshot.dayKey, haltReason: snapshot.harvest.haltReason, recoveryKind, books: rows });
      const purpose = recoveryKind === "VERIFIED_FLAT"
        ? "This confirms the already-completed harvest, retains its original trigger, reopens new entries, and keeps ordinary tranche exits paused until 22:00 UTC."
        : "This rechecks fresh account data and clears only the matching fresh-data halt.";
      return { code, message: ["D-064 HARVEST RECOVERY", "", rowsText(rows), "", purpose, "It will not change virtual lots, place a DXtrade order, or lift an operator pause.", "", `To apply, send /confirmharvestrecover ${code} within 10 minutes.`].join("\n") };
    },
    // This is deliberately narrower than the owner-command recovery above.  It
    // runs once during a deploy only to retire the known false D-064
    // fresh-account-data halt after the account monitor has obtained a fresh
    // snapshot.  It cannot clear an operator pause, a different safety halt,
    // or a D-064 halt caused by an unconfirmed flatten.
    async recoverVerifiedD064AtStartup() {
      if (!riskSupervisor || !database) return Object.freeze({ action: "NOT_CONFIGURED" });
      const snapshot = riskSupervisor.getSnapshot();
      if (d064RecoveryKind(snapshot.harvest) !== "FRESH_DATA") return Object.freeze({ action: "NOT_D064_FRESHNESS_HALT" });
      const [botState, rows] = await Promise.all([database.getState(), inspectBooks()]);
      if (botState.safety_halt !== true || botState.halt_reason !== snapshot.harvest.haltReason) {
        return Object.freeze({ action: "DIFFERENT_SAFETY_HALT", rows: Object.freeze(rows) });
      }
      if (!rowsAreReconciled(rows)) {
        return Object.freeze({ action: "BOOKS_NOT_RECONCILED", rows: Object.freeze(rows) });
      }
      const result = await riskSupervisor.recoverHarvest({ dayKey: accountDayKey(Date.now()), booksVerified: true, recoveryKind: "FRESH_DATA" });
      await database.addEvent("WARN", "D064_VERIFIED_STARTUP_RECOVERY", {
        dayKey: accountDayKey(Date.now()),
        action: result.action,
        books: rows
      });
      return Object.freeze({ ...result, rows: Object.freeze(rows) });
    },
    async confirmHarvestRecovery(code) {
      if (!riskSupervisor || !database) return "D-064 recovery is not configured on this deployment.";
      const botState = await database.getState();
      if (!/^\d{6}$/.test(code ?? "")) return "Use /confirmharvestrecover followed by the 6-digit code from /harvestrecover.";
      if (!botState.resume_code_hash || !botState.resume_code_salt || !botState.resume_code_expires_at) return "No D-064 recovery request is pending. Send /harvestrecover first.";
      if (new Date(botState.resume_code_expires_at).getTime() < Date.now()) {
        await database.clearResumeChallenge();
        return "That D-064 recovery code expired. Send /harvestrecover for a new code.";
      }
      const snapshot = riskSupervisor.getSnapshot();
      const recoveryKind = d064RecoveryKind(snapshot.harvest);
      const rows = await inspectBooks();
      if (!recoveryKind || !sameHex(harvestRecoveryHash(code, botState.resume_code_salt, recoveryKind), botState.resume_code_hash) || (botState.safety_halt === true && botState.halt_reason !== snapshot.harvest.haltReason)) {
        await database.clearResumeChallenge();
        return "D-064 recovery aborted: the harvest or safety-halt state changed. No halt was cleared.";
      }
      if (!recoveryRowsAreSafe(rows, recoveryKind)) {
        await database.clearResumeChallenge();
        return recoveryRowsFailureText(rows, recoveryKind, "ABORTED");
      }
      const result = await riskSupervisor.recoverHarvest({ dayKey: accountDayKey(Date.now()), booksVerified: true, recoveryKind });
      await database.clearResumeChallenge();
      if (result.action === "HARVEST_RECOVERY_REFUSED" || result.action === "ACCOUNT_DATA_UNAVAILABLE") return "D-064 recovery refused because fresh broker account data could not be verified. No halt was cleared.";
      await database.addEvent("WARN", "D064_HARVEST_RECOVERY_APPLIED", { source: "telegram", dayKey: accountDayKey(Date.now()), action: result.action, recoveryKind, books: rows });
      return `D-064 recovery applied: ${result.action}. The account-day harvest gate is now ${riskSupervisor.getSnapshot().harvest?.status ?? "unavailable"}. Operator pause is unchanged.`;
    },
    async pauseHalt() {
      if (!haltWarnings || typeof haltWarnings.defer !== "function") return "Owner halt-warning deferral is not configured on this deployment.";
      const result = await haltWarnings.defer();
      if (result.action === "NO_PENDING_HALT") return "There is no pending owner-warning halt to defer.";
      const cycle = result.cycle;
      return [
        "PENDING HALT DEFERRED",
        `${cycle.reasonCode}${cycle.instrument ? ` · ${cycle.instrument}` : ""}`,
        "Warning cycle restarted at 1/5. Trading remains running.",
        `The halt is now eligible no earlier than ${cycle.haltAt}.`,
        "You will receive the next warning in 5 minutes."
      ].join("\n");
    },
    requestRerun: () => rerun.requestRerun(),
    confirmRerun: (code) => rerun.confirmRerun(code),

    /**
     * Force a fresh DXtrade session on every client.
     *
     * Recovery for the failure that killed the funded account on 2026-09-19:
     * the execution session was rejected with 401 for eighty minutes and a
     * Railway restart was the only way back. This is that restart, without
     * the restart - which matters, because restarting also re-baselines the
     * day-open balance and zeroes the cut counter.
     */
    async reloginText() {
      if (typeof reloginAll !== "function") {
        return "Re-login is not configured on this deployment.";
      }
      const started = Date.now();
      try {
        const results = await reloginAll();
        const lines = Array.isArray(results)
          ? results.map((r) => `  ${r.name}: ${r.ok ? "OK" : `FAILED - ${r.error}`}`)
          : ["  (no client detail reported)"];
        const failed = Array.isArray(results) && results.some((r) => !r.ok);
        return [
          failed ? "DXTRADE RE-LOGIN PARTIALLY FAILED" : "DXTRADE RE-LOGIN COMPLETE",
          ...lines,
          `Took ${Date.now() - started}ms.`,
          failed
            ? "At least one session is still dead. Check the credentials before resuming."
            : "Send /health to confirm the execution client can read positions."
        ].join("\n");
      } catch (error) {
        return `DXTRADE RE-LOGIN FAILED\n${error?.message ?? "unknown error"}`;
      }
    },

    /**
     * Close every open position now.
     *
     * Requires the literal argument CONFIRM. This is the most destructive
     * command in the bot and a mistyped message should not be able to fire
     * it, but a second /confirmflatall round-trip would be one more pause
     * path in a system that already has too many.
     */
    async flatAllText(arg) {
      if (typeof flattenAll !== "function") {
        return "Automatic flatten is not configured on this deployment.";
      }
      if (String(arg ?? "").trim().toUpperCase() !== "CONFIRM") {
        return [
          "FLATTEN EVERY POSITION",
          "This closes all open positions on every instrument at market.",
          "",
          "Send: /flatall CONFIRM"
        ].join("\n");
      }
      try {
        const results = await flattenAll();
        const lines = (Array.isArray(results) ? results : []).map((r) =>
          `  ${r.instrument}: ${r.status}${r.reason ? ` - ${r.reason}` : ""}`);
        const bad = (Array.isArray(results) ? results : [])
          .filter((r) => r.status !== "FILLED" && r.status !== "ALREADY_FLAT");
        return [
          bad.length === 0 ? "FLATTEN COMPLETE - every instrument" : "FLATTEN INCOMPLETE",
          ...lines,
          bad.length === 0
            ? "Send /status and confirm exposure reads $0.00."
            : "Some books did not confirm flat. Inspect DXtrade directly before trusting /status."
        ].join("\n");
      } catch (error) {
        return `FLATTEN FAILED\n${error?.message ?? "unknown error"}`;
      }
    }
  });

  async function executionProbeLine() {
    if (typeof executionHealth !== "function") {
      return "  execution client: not wired on this deployment (cannot verify order path)";
    }
    const started = Date.now();
    try {
      const result = await executionHealth();
      const ms = Date.now() - started;
      if (result?.ok === true) {
        return `  execution client: OK (${ms}ms, ${result.positionCount ?? "?"} open positions, reauths today ${result.reauthCount ?? 0})`;
      }
      return `  execution client: *** FAILING *** ${result?.error ?? "unknown error"} - protective cuts cannot execute`;
    } catch (error) {
      return `  execution client: *** FAILING *** ${error?.message ?? "probe threw"} - protective cuts cannot execute`;
    }
  }
}
