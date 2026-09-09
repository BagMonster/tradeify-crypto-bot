import { createSolanaOwnerService } from "./solanaOwnerService.js";
import { createRuntimeHaltRerunHandlers } from "./state/runtimeHaltRerun.js";
import { accountDayKey } from "./risk/dailyRiskLadder.js";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const SEPARATOR = "\u2014".repeat(28);

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
  instrumentConfigs,
  buildOwnerService = createSolanaOwnerService,
  riskSupervisor = null,
  sharedPause = null,
  database = null,
  haltWarnings = null,
  onRuntimeHaltCleared = async () => {}
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

  function harvestRecoveryHash(code, salt) {
    return createHash("sha256").update(`${salt}:d064-harvest-recovery:${code}`).digest("hex");
  }

  function sameHex(left, right) {
    return Boolean(left && right && left.length === right.length && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex")));
  }

  function rowsText(rows) {
    return rows.map((row) => `  ${row.instrument}: virtual ${Number.isFinite(row.virtualNet) ? row.virtualNet.toFixed(8) : "unavailable"}  broker ${Number.isFinite(row.brokerNet) ? row.brokerNet.toFixed(8) : "unavailable"}  lots ${row.openLots}  ${row.match === true ? "MATCH" : "MISMATCH"}`).join("\n");
  }

  function recoverableD064(harvest) {
    return harvest?.status === "HALTED" && typeof harvest.haltReason === "string" && harvest.haltReason.startsWith("D-064 harvest cannot verify fresh broker account data for ");
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

  function accountSummaryLines() {
    const snapshot = riskSupervisor?.getSnapshot?.() ?? null;
    if (!snapshot) return ["ACCOUNT RISK: supervisor snapshot unavailable"];
    const lines = [
      "ACCOUNT RISK",
      `  instruments enabled: ${books.length} (${books.map((b) => b.instrument).join(", ")})`,
      `  combined day P&L: ${money(snapshot.dayPnlUsd)}`,
      `  combined exposure: ${money(snapshot.exposureUsd)}`,
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

    async statusText(arg) {
      const per = await fanOut("statusText", arg);
      return `${accountSummaryLines().join("\n")}\n\n${per}`;
    },
    async healthText(arg) {
      const per = await fanOut("healthText", arg);
      return `${accountSummaryLines().join("\n")}\n\n${per}`;
    },
    levelsText: (arg) => fanOut("levelsText", arg),
    ringsText: (arg) => fanOut("ringsText", arg),
    targetsText: (arg) => fanOut("targetsText", arg),
    dxPreflightText: (arg) => fanOut("dxPreflightText", arg),
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
      if (!recoverableD064(snapshot.harvest)) return { code: null, message: "D-064 recovery is refused: the current harvest halt is not the recoverable fresh-data startup halt." };
      const [botState, rows] = await Promise.all([database.getState(), inspectBooks()]);
      if (botState.safety_halt === true && botState.halt_reason !== snapshot.harvest.haltReason) {
        return { code: null, message: "D-064 recovery is refused: a different safety halt is active. It was not changed." };
      }
      if (rows.some((row) => row.ok !== true) || rows.some((row) => row.match !== true)) {
        return { code: null, message: ["D-064 RECOVERY REFUSED — BOOKS NOT RECONCILED", "", rowsText(rows), "", "Reconcile every broker-flat book first. Recovery will not alter virtual lots or place a DXtrade order."].join("\n") };
      }
      const code = String(randomInt(100000, 1000000));
      const salt = randomBytes(16).toString("hex");
      await database.setResumeChallenge(harvestRecoveryHash(code, salt), salt, new Date(Date.now() + 10 * 60 * 1000));
      await database.addEvent("WARN", "D064_HARVEST_RECOVERY_REQUESTED", { source: "telegram", dayKey: snapshot.dayKey, haltReason: snapshot.harvest.haltReason, books: rows });
      return { code, message: ["D-064 HARVEST RECOVERY", "", rowsText(rows), "", "This rechecks fresh account data and clears only the matching false fresh-data halt.", "It will not change virtual lots, place a DXtrade order, or lift an operator pause.", "", `To apply, send /confirmharvestrecover ${code} within 10 minutes.`].join("\n") };
    },
    // This is deliberately narrower than the owner-command recovery above.  It
    // runs once during a deploy only to retire the known false D-064
    // fresh-account-data halt after the account monitor has obtained a fresh
    // snapshot.  It cannot clear an operator pause, a different safety halt,
    // or a D-064 halt caused by an unconfirmed flatten.
    async recoverVerifiedD064AtStartup() {
      if (!riskSupervisor || !database) return Object.freeze({ action: "NOT_CONFIGURED" });
      const snapshot = riskSupervisor.getSnapshot();
      if (!recoverableD064(snapshot.harvest)) return Object.freeze({ action: "NOT_D064_FRESHNESS_HALT" });
      const [botState, rows] = await Promise.all([database.getState(), inspectBooks()]);
      if (botState.safety_halt !== true || botState.halt_reason !== snapshot.harvest.haltReason) {
        return Object.freeze({ action: "DIFFERENT_SAFETY_HALT", rows: Object.freeze(rows) });
      }
      if (rows.some((row) => row.ok !== true) || rows.some((row) => row.match !== true)) {
        return Object.freeze({ action: "BOOKS_NOT_RECONCILED", rows: Object.freeze(rows) });
      }
      const result = await riskSupervisor.recoverHarvest({ dayKey: accountDayKey(Date.now()), booksVerified: true });
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
      if (!sameHex(harvestRecoveryHash(code, botState.resume_code_salt), botState.resume_code_hash)) return "The D-064 recovery code is incorrect. A resume, reconcile, rematch, or re-run code will not work here.";
      const snapshot = riskSupervisor.getSnapshot();
      const rows = await inspectBooks();
      if (!recoverableD064(snapshot.harvest) || (botState.safety_halt === true && botState.halt_reason !== snapshot.harvest.haltReason)) {
        await database.clearResumeChallenge();
        return "D-064 recovery aborted: the harvest or safety-halt state changed. No halt was cleared.";
      }
      if (rows.some((row) => row.ok !== true) || rows.some((row) => row.match !== true)) {
        await database.clearResumeChallenge();
        return ["D-064 RECOVERY ABORTED — BOOKS NOT RECONCILED", "", rowsText(rows), "", "No halt was cleared."].join("\n");
      }
      const result = await riskSupervisor.recoverHarvest({ dayKey: accountDayKey(Date.now()), booksVerified: true });
      await database.clearResumeChallenge();
      if (result.action === "HARVEST_RECOVERY_REFUSED" || result.action === "ACCOUNT_DATA_UNAVAILABLE") return "D-064 recovery refused because fresh broker account data could not be verified. No halt was cleared.";
      await database.addEvent("WARN", "D064_HARVEST_RECOVERY_APPLIED", { source: "telegram", dayKey: accountDayKey(Date.now()), action: result.action, books: rows });
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
    confirmRerun: (code) => rerun.confirmRerun(code)
  });
}
