import { createSolanaOwnerService } from "./solanaOwnerService.js";

/**
 * src/multiInstrumentOwnerService.js
 *
 * Fans one Telegram command out across every enabled instrument.
 *
 * telegramBot.js calls service.statusText(), service.levelsText() and so on. It
 * does not know how many instruments exist. This wrapper keeps that contract:
 * it holds one per-instrument owner service each, composes their text, and
 * prepends an account-level summary from the risk supervisor.
 *
 * Read commands accept an optional instrument argument and default to all.
 * Control commands that change state are deliberately NOT fanned out silently —
 * see the safety notes on each.
 */

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

export function createMultiInstrumentOwnerService({
  instrumentConfigs,
  buildOwnerService = createSolanaOwnerService,
  riskSupervisor = null,
  sharedPause = null
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
      `  ladder: brake ${money(-Math.abs(snapshot.entryBrakeUsd ?? 300))} per instrument` +
        ` | cut ${money(-Math.abs(snapshot.partialCutUsd ?? 1000))} account-wide` +
        ` | flatten ${money(-Math.abs(snapshot.fullFlattenUsd ?? 1250))} account-wide`
    ];
    const braked = Array.isArray(snapshot.brakedInstruments) ? snapshot.brakedInstruments : [];
    lines.push(`  braked today: ${braked.length === 0 ? "none" : braked.join(", ")}`);
    if (snapshot.lastError) lines.push(`  supervisor note: ${snapshot.lastError}`);
    if (snapshot.flattenedToday === true) {
      lines.push("  *** ACCOUNT FLATTENED TODAY - all entries blocked until 22:00 UTC rollover ***");
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
    }
  });
}
