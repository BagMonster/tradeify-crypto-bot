import { createSolanaOwnerService } from "./solanaOwnerService.js";
import { createRuntimeHaltRerunHandlers, virtualInventoryRecoveryPlan } from "./state/runtimeHaltRerun.js";
import { accountDayKey } from "./risk/dailyRiskLadder.js";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const SEPARATOR = "\u2014".repeat(28);
const D064_FLAT_CONFIRMATION_HALT = "D-064 harvest could not confirm every book flat; owner review required";
const D068_ROLLOVER_CONFIRMATION_HALT = "D-068 rollover harvest could not confirm its planned profit closes; owner review required";
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
  getRiskDataStatus = null,
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
  executionHealth = null,
  getAnchorRecoveryStatus = null,
  recoverAnchors = null
}) {
  if (!Array.isArray(instrumentConfigs) || instrumentConfigs.length === 0) {
    throw new TypeError("instrumentConfigs must be a non-empty array");
  }

  const enabled = instrumentConfigs.filter((cfg) => cfg.enabled === true);
  if (enabled.length === 0) throw new TypeError("at least one instrument must be enabled");
  if (recoverAnchors !== null && typeof recoverAnchors !== "function") throw new TypeError("recoverAnchors must be a function");

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
      try {
        rows.push(await book.service.inspectForRerun());
      } catch (error) {
        rows.push(Object.freeze({
          instrument: book.instrument,
          ok: false,
          match: false,
          virtualNet: null,
          brokerNet: null,
          openLots: 0,
          error: error?.message ?? "book inspection failed"
        }));
      }
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
    if (harvest?.status === "CONFIRMED" && harvest?.mode === "ROLLOVER_PARTIAL" && harvest?.plan?.confirmation?.source !== "BROKER_CONFIRMED") return "ROLLOVER_UNVERIFIED";
    if (harvest?.status !== "HALTED" || typeof harvest.haltReason !== "string") return null;
    if (harvest.haltReason.startsWith("D-064 harvest cannot verify fresh broker account data for ") ||
      harvest.haltReason === "D-068 cannot read and price every configured account ticket; owner review required") return "FRESH_DATA";
    if (harvest.haltReason === D064_FLAT_CONFIRMATION_HALT) return "VERIFIED_FLAT";
    // Old D-068 persistence may identify this plan as FULL despite the
    // unambiguous D-068 halt reason.  Do not use that legacy mode label.
    if (harvest.haltReason === D068_ROLLOVER_CONFIRMATION_HALT) {
      return "ROLLOVER_UNVERIFIED";
    }
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
      : recoveryKind === "ROLLOVER_UNVERIFIED"
        ? `D-068 UNVERIFIED RECOVERY ${phase} — BOOKS NOT RECONCILED`
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

  function compactPoolLine() {
    const raw = safePoolLine().trim();
    const match = raw.match(/^exposure pool:\s+(.+?) of soft (\$[\d,.]+) \/ hard (\$[\d,.]+).*·\s*(FULL|OPEN)/i);
    if (!match) return `Entry pool: ${raw.replace(/^exposure pool:\s*/i, "")}`;
    const [, exposure, soft, hard, state] = match;
    return state.toUpperCase() === "FULL"
      ? `Entry pool: CLOSED — ${exposure} / ${soft} soft (hard ${hard})`
      : `Entry pool: OPEN — ${exposure} / ${soft} soft (hard ${hard})`;
  }

  function sourceSummary(per) {
    const counts = new Map();
    for (const entry of per) {
      const source = entry.markUnavailable ? "PENDING" : String(entry.entryBrakePnlSource ?? "UNAVAILABLE");
      counts.set(source, (counts.get(source) ?? 0) + 1);
    }
    const label = (source) => source === "BINANCE_REST_MARK" ? "REST" :
      source === "BINANCE_TRADE_MARK" ? "trade" :
        source === "BROKER_FLAT" ? "flat" :
          source === "PENDING" ? "pending" : "unavailable";
    const summary = [...counts.entries()].map(([source, count]) => `${count} ${label(source)}`).join(" · ");
    return summary || "unavailable";
  }

  function nextProtectionLine(snapshot) {
    const openLoss = Math.max(0, -Number(snapshot.totalUnrealisedUsd ?? snapshot.unrealisedUsd ?? 0));
    const tiers = Array.isArray(snapshot.cutTiers) ? snapshot.cutTiers : [];
    const nextCut = tiers
      .map((tier) => Number(tier?.thresholdUsd))
      .filter((threshold) => Number.isFinite(threshold) && threshold > openLoss)
      .sort((a, b) => a - b)[0] ?? null;
    const flatten = Number(snapshot.fullFlattenUsd);
    const cutText = nextCut === null ? "all cut tiers reached" : `first cut in ${money(nextCut - openLoss)}`;
    const flattenText = Number.isFinite(flatten) ? `flatten in ${money(Math.max(0, flatten - openLoss))}` : "flatten unavailable";
    return `Next protection: ${cutText} · ${flattenText}`;
  }

  function remainingDuration(ms) {
    const minutes = Math.max(0, Math.ceil(Number(ms) / 60_000));
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return hours > 0 ? `${hours}h ${remainder}m` : `${remainder}m`;
  }

  function poolClosedHarvestLine(snapshot) {
    const schedule = snapshot.poolClosedHarvest;
    if (!schedule || !Number.isFinite(Number(schedule.ageMs))) return null;
    const firstRemaining = Math.max(0, Number(schedule.firstAfterMs) - Number(schedule.ageMs));
    const secondRemaining = Math.max(0, Number(schedule.secondAfterMs) - Number(schedule.ageMs));
    const first = Number(schedule.firstTargetUsd);
    const second = Number(schedule.minimumTargetUsd);
    if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
    if (secondRemaining === 0) return `Pool harvest: −75% ACTIVE (${money(second)})`;
    const firstText = firstRemaining === 0
      ? `−50% ACTIVE (${money(first)})`
      : `−50% (${money(first)}) in ${remainingDuration(firstRemaining)}`;
    return `Pool harvest: ${firstText} · −75% (${money(second)}) in ${remainingDuration(secondRemaining)}`;
  }

  function compactAttentionLines(snapshot, per) {
    const lines = [];
    const losses = per.filter((entry) => !entry.markUnavailable && Number(entry.unrealisedUsd) <= -Number(snapshot.entryBrakeUsd ?? Infinity));
    for (const entry of losses) lines.push(`• ${entry.instrument}: ${money(entry.unrealisedUsd)} — loss brake active`);
    const pending = per.filter((entry) => entry.markUnavailable).map((entry) => entry.instrument);
    if (pending.length > 0) lines.push(`• Marks pending: ${pending.join(", ")} — entries blocked only on those books`);
    return lines;
  }

  function accountSummaryLines() {
    const snapshot = riskSupervisor?.getSnapshot?.() ?? null;
    if (!snapshot) return ["ACCOUNT RISK: supervisor snapshot unavailable"];
    const per = Array.isArray(snapshot.perInstrument) ? snapshot.perInstrument : [];
    const data = typeof getRiskDataStatus === "function" ? getRiskDataStatus() : null;
    const poolClosed = /\bFULL\b/i.test(safePoolLine());
    const unread = per.filter((entry) => entry.readFailed === true).map((entry) => entry.instrument);
    const attention = compactAttentionLines(snapshot, per);
    const lines = [
      `ACCOUNT RISK — ${snapshot.flattenedToday ? "ACCOUNT FLATTENED" : poolClosed ? "ENTRIES CLOSED" : "OPERATING NORMALLY"}`,
      snapshot.flattenedToday ? "Reason: account flatten latched through rollover" : poolClosed ? "Reason: exposure pool full" : "Reason: no account-wide entry block",
      "",
      `Day: ${money(snapshot.dayPnlUsd)}  •  Open: ${money(snapshot.totalUnrealisedUsd ?? snapshot.unrealisedUsd)}  •  Exposure: ${money(snapshot.exposureUsd)}  •  Loss room: ${money(snapshot.marginToLimitUsd)}`,
      compactPoolLine(),
      `Limits: brake ${money(-Math.abs(snapshot.entryBrakeUsd ?? 0))}/book · cuts ${(Array.isArray(snapshot.cutTiers) ? snapshot.cutTiers : []).slice().sort((a, b) => a.thresholdUsd - b.thresholdUsd).map((tier) => `${Math.round(tier.fraction * 100)}% at ${money(-tier.thresholdUsd)}`).join(", ")} · flatten ${money(-Math.abs(snapshot.fullFlattenUsd ?? 0))}`,
      "",
      `Data: ${data?.brokerHealthy === true ? `DXtrade fresh ${Math.ceil(Number(data.brokerAgeMs ?? 0) / 1000)}s` : "DXtrade unavailable"} · marks ${sourceSummary(per)}`,
      `Open positions: ${Number.isFinite(data?.openBooks) ? `${data.openBooks} books · ${data.ticketCount} tickets` : "unavailable"}`,
      nextProtectionLine(snapshot),
      `Account day: ${snapshot.dayKey ?? "not evaluated"} · reset 22:00 UTC · cuts today: ${Number(snapshot.cutsToday ?? 0)}`
    ];
    const marksUnavailable = per.filter((entry) => entry.markUnavailable === true).map((entry) => entry.instrument);
    lines.push("", "Attention");
    if (unread.length > 0) {
      lines.push(`• Broker risk data unread: ${unread.join(", ")}`);
    } else if (attention.length > 0) {
      lines.push(...attention);
    } else {
      lines.push("• None — all books readable and no current loss brake");
    }
    if (marksUnavailable.length > 0 && unread.length === 0) lines.push("• Account-wide protection remains active while those marks refresh");
    if (snapshot.lastError && unread.length > 0) lines.push(`• Supervisor: ${snapshot.lastError}`);
    if (snapshot.freshDataGrace) {
      lines.push(`• D-064 broker-data outage: ${Math.ceil(snapshot.freshDataGrace.outageMs / 1000)}s`);
    }
    const pendingHalt = haltWarnings?.snapshot ? haltWarnings.snapshot() : null;
    if (pendingHalt && typeof pendingHalt.then !== "function") {
      lines.push(`• Pending owner-warning halt: ${pendingHalt.reasonCode} · warning ${pendingHalt.warningNumber}/5`);
    }
    if (snapshot.flattenedToday === true) {
      lines.push("• All entries blocked until 22:00 UTC rollover");
    }
    const harvestUsd = Number(snapshot.sessionHarvestUsd);
    if (snapshot.sessionHarvestEnabled === true && Number.isFinite(harvestUsd)) {
      const harvest = snapshot.harvest ?? { status: snapshot.harvestedToday === true ? "CONFIRMED" : "READY" };
      const exits = snapshot.trancheExitsPaused === true ? "OFF" : "ON";
      lines.push("", `Harvest: ${harvest.status} · target +${harvestUsd.toFixed(2)} · tranche exits ${exits}`);
      const poolHarvest = poolClosedHarvestLine(snapshot);
      if (poolHarvest) lines.push(poolHarvest);
      const rolloverWaitMs = Number(snapshot.rolloverHarvestDelayRemainingMs);
      if (Number.isFinite(rolloverWaitMs) && rolloverWaitMs > 0) {
        lines.push(`Settlement wait: ${Math.ceil(rolloverWaitMs / 60_000)}m remaining`);
      }
      if (Number.isFinite(Number(harvest.triggerPnlUsd)) && Number(harvest.triggerPnlUsd) !== 0) lines.push(`Trigger P&L: ${money(Number(harvest.triggerPnlUsd))}`);
      if (harvest.haltReason) lines.push(`Harvest halt: ${harvest.haltReason}`);
    }
    return lines;
  }

  function riskDetailText(arg) {
    const snapshot = riskSupervisor?.getSnapshot?.() ?? null;
    if (!snapshot) return "RISK DETAIL: supervisor snapshot unavailable";
    const target = normaliseInstrument(arg);
    const per = (Array.isArray(snapshot.perInstrument) ? snapshot.perInstrument : [])
      .filter((entry) => target === null || entry.instrument === target)
      .sort((left, right) => {
        const exposure = (entry) => {
          const value = Number(entry.exposureUsd);
          return Number.isFinite(value) ? Math.abs(value) : -Infinity;
        };
        return exposure(right) - exposure(left);
      });
    if (target !== null && per.length === 0) return `Unknown instrument "${arg}".`;
    const braked = new Set(Array.isArray(snapshot.brakedInstruments) ? snapshot.brakedInstruments : []);
    const rows = per.map((entry) => {
      const mark = entry.markUnavailable ? "MARK: PENDING" : ({
        BINANCE_REST_MARK: "MARK: BINANCE REST",
        BINANCE_TRADE_MARK: "MARK: BINANCE STREAM",
        BROKER_FLAT: "MARK: BROKER FLAT"
      }[entry.entryBrakePnlSource] ?? "MARK: UNAVAILABLE");
      const brake = braked.has(entry.instrument)
        ? "BRAKE: LOSS"
        : entry.entryBlockedForMark ? "ENTRY BLOCK: MARK" : "READY";
      const ticker = String(entry.instrument ?? "?").replace(/\/USD$/, "");
      return `${ticker.padEnd(6)} P&L ${entry.markUnavailable ? "unavailable" : money(entry.unrealisedUsd).padStart(8)} · exposure ${money(entry.exposureUsd).padStart(8)} · ${brake} · ${mark}`;
    });
    return [
      "RISK DETAIL",
      `Account day: ${snapshot.dayKey ?? "not evaluated"} · open P&L: ${money(snapshot.totalUnrealisedUsd ?? snapshot.unrealisedUsd)}`,
      `Entry brakes: ${braked.size === 0 ? "none" : `${braked.size} active`} · live ticket P&L`,
      "",
      ...rows,
      "",
      "Brake: LOSS means current ticket P&L is at or below the threshold; it releases as soon as the P&L recovers.",
      "Mark: BINANCE REST is a background HTTP ticker price; BINANCE STREAM is the live WebSocket trade price."
    ].join("\n");
  }

  return Object.freeze({
    instruments: Object.freeze(books.map((b) => b.instrument)),
    inspectBooks,

    async statusText(arg) {
      if (normaliseInstrument(arg) !== null) return fanOut("statusText", arg);
      const rows = await inspectBooks();
      const recovery = virtualInventoryRecoveryPlan(rows);
      const anchorFailure = getAnchorRecoveryStatus?.()?.failure;
      const anchorLine = anchorFailure ? `\n\nANCHOR SHIFT FAILED: ${anchorFailure.instrument} — ${anchorFailure.reason}\nNew entries blocked; automatic retries stopped. Protective operations remain available. Owner review required.` : "";
      return `${accountSummaryLines().join("\n")}${recovery ? `\n\n${recovery}` : ""}${anchorLine}`;
    },
    riskText: riskDetailText,
    async anchorsText() {
      const rows = [];
      for (const book of books) {
        try {
          rows.push(await book.service.anchorSummaryLine());
        } catch (error) {
          rows.push(`${book.instrument}  anchor unavailable (${error?.message ?? "read failed"})`);
        }
      }
      return ["ANCHORS", ...rows].join("\n");
    },
    anchorText: async (arg) => {
      if (normaliseInstrument(arg) === null) return "Specify a coin: /anchor <COIN>";
      return fanOut("anchorText", arg);
    },
    anchorHistoryText: (arg) => fanOut("anchorHistoryText", arg),
    anchorStatsText: (arg) => fanOut("anchorStatsText", arg),
    async anchorRecoveryText(confirm) {
      if (typeof recoverAnchors !== "function") return "Anchor recovery is not configured on this deployment.";
      if (String(confirm ?? "").trim().toUpperCase() !== "CONFIRM") {
        return [
          "ANCHOR SHIFT RECOVERY",
          "",
          "Use only after a confirmed account-wide flat event whose anchor shift was missed during a deploy.",
          "It takes a fresh DXtrade snapshot, then starts the normal 9-second entry hold and requires a second fresh flat snapshot.",
          "It never places a DXtrade order. It refuses if any book or virtual lot is open.",
          "",
          "To start, send /anchorrecover CONFIRM"
        ].join("\n");
      }
      const result = await recoverAnchors();
      if (result.action === "HOLD_STARTED") {
        return `ANCHOR SHIFT HOLD STARTED\n\nVerified flat account. Entries are held for 9 seconds while awaiting a second fresh DXtrade flat snapshot.\nPending: ${result.instruments.join(", ")}`;
      }
      if (result.action === "FAILED") return `ANCHOR SHIFT FAILED\n${result.failure.instrument}: ${result.failure.reason}\nEntries remain blocked; automatic retries have stopped. ${result.failure.rollbackConfirmed ? "The failed write rolled back. A new explicit recovery requires another fresh flat verification." : "Owner review of state and history is required before retrying."} Protective operations remain available.`;
      if (result.action === "HOLD_ALREADY_STARTED") return "Anchor shift confirmation is already in progress. Entries remain held until it completes or is cancelled by a non-flat or unhealthy snapshot.";
      if (result.action === "RECOVERY_NOT_NEEDED") return "Anchor recovery is not needed: no pending anchor excursion is recorded.";
      return "Anchor recovery was refused. The account must be freshly readable, broker-flat, virtual-flat, and have no order in flight. No anchor changed.";
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
      if (!riskSupervisor || !database) return { code: null, message: "Harvest recovery is not configured on this deployment." };
      const snapshot = riskSupervisor.getSnapshot();
      const recoveryKind = d064RecoveryKind(snapshot.harvest);
      if (!recoveryKind) return { code: null, message: "Harvest recovery is refused: the current halt is not a recoverable fresh-data, flat-confirmation, or no-fill D-068 halt." };
      const [botState, rows] = await Promise.all([database.getState(), inspectBooks()]);
      if (botState.safety_halt === true && botState.halt_reason !== snapshot.harvest.haltReason) {
        return { code: null, message: "Harvest recovery is refused: a different safety halt is active. It was not changed." };
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
        : recoveryKind === "ROLLOVER_UNVERIFIED"
          ? "This clears an unverified legacy D-068 record after every book is freshly reconciled. It does not treat a saved plan as proof of a fill: the harvest gate returns to READY and ordinary tranche exits are enabled."
          : "This rechecks fresh account data and clears only the matching fresh-data halt.";
      const heading = recoveryKind === "ROLLOVER_UNVERIFIED" ? "D-068 ROLLOVER RECOVERY" : "D-064 HARVEST RECOVERY";
      return { code, message: [heading, "", rowsText(rows), "", purpose, "It will not change virtual lots, place a DXtrade order, or lift an operator pause.", "", `To apply, send /confirmharvestrecover ${code} within 10 minutes.`].join("\n") };
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
      if (!riskSupervisor || !database) return "Harvest recovery is not configured on this deployment.";
      const botState = await database.getState();
      if (!/^\d{6}$/.test(code ?? "")) return "Use /confirmharvestrecover followed by the 6-digit code from /harvestrecover.";
      if (!botState.resume_code_hash || !botState.resume_code_salt || !botState.resume_code_expires_at) return "No harvest recovery request is pending. Send /harvestrecover first.";
      if (new Date(botState.resume_code_expires_at).getTime() < Date.now()) {
        await database.clearResumeChallenge();
        return "That harvest recovery code expired. Send /harvestrecover for a new code.";
      }
      const snapshot = riskSupervisor.getSnapshot();
      const recoveryKind = d064RecoveryKind(snapshot.harvest);
      const rows = await inspectBooks();
      if (!recoveryKind || !sameHex(harvestRecoveryHash(code, botState.resume_code_salt, recoveryKind), botState.resume_code_hash) || (botState.safety_halt === true && botState.halt_reason !== snapshot.harvest.haltReason)) {
        await database.clearResumeChallenge();
        return "Harvest recovery aborted: the harvest or safety-halt state changed. No halt was cleared.";
      }
      if (!recoveryRowsAreSafe(rows, recoveryKind)) {
        await database.clearResumeChallenge();
        return recoveryRowsFailureText(rows, recoveryKind, "ABORTED");
      }
      const result = await riskSupervisor.recoverHarvest({ dayKey: accountDayKey(Date.now()), booksVerified: true, recoveryKind });
      await database.clearResumeChallenge();
      if (result.action === "HARVEST_RECOVERY_REFUSED" || result.action === "ACCOUNT_DATA_UNAVAILABLE") return "Harvest recovery refused because fresh broker account data could not be verified. No harvest state was changed.";
      await database.addEvent("WARN", "D064_HARVEST_RECOVERY_APPLIED", { source: "telegram", dayKey: accountDayKey(Date.now()), action: result.action, recoveryKind, books: rows });
      return `Harvest recovery applied: ${result.action}. The account-day harvest gate is now ${riskSupervisor.getSnapshot().harvest?.status ?? "unavailable"}. Operator pause is unchanged.`;
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
