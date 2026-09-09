import "dotenv/config";
import { createDevCompanionStore } from "./src/devCompanionStore.js";
import { loadBodyMap } from "./src/devCompanionBodyMap.js";
import { createGithubInspector } from "./src/devCompanionGithub.js";
import { createChroniclePublisher } from "./src/devCompanionChroniclePublish.js";
import { createGeminiRequester, GeminiCapacityError } from "./src/devCompanionGemini.js";
import { COMPANION_REPO_TOOLS, extractOutputText, runCompanionToolLoop } from "./src/devCompanionTools.js";

function requireText(name, value) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

function parseBoolean(value) {
  if (value === undefined || value === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("DATABASE_SSL must be true or false");
}

function describeOpenAIError(payload, fallback) {
  const err = payload && typeof payload === "object" ? payload.error : null;
  const parts = [err?.type, err?.code, err?.message]
    .filter((value) => typeof value === "string" && value.trim() !== "");
  return parts.length > 0 ? parts.join(" | ") : fallback;
}

function envText(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

const databaseUrl = requireText("DATABASE_URL", process.env.DATABASE_URL);
const geminiKey = envText("GEMINI_FREE_API_KEY") || envText("GEMINI_API_KEY");
const geminiPaidKey = envText("GEMINI_PAID_API_KEY");
const openaiKey = envText("OPENAI_API_KEY");
const useGemini = geminiKey !== "";
const geminiModel = (process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite").trim();
const openaiModel = (process.env.OPENAI_FALLBACK_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const model = useGemini ? geminiModel : openaiModel;
const databaseSsl = parseBoolean(process.env.DATABASE_SSL);
const githubToken = envText("GITHUB_TOKEN");
const bodyMap = loadBodyMap();
const chroniclePublishEnabled = process.env.CHRONICLE_AUTONOMOUS_PUBLISH === "true";
const github = createGithubInspector({ token: githubToken });

const store = createDevCompanionStore({ databaseUrl, databaseSsl });
await store.init();
const chroniclePublisher = createChroniclePublisher({
  token: githubToken,
  store,
  enabled: chroniclePublishEnabled
});

const instructions = [
  // ---------- identity ----------
  "You are BMTB1 (Bag Monster Tradeify Bot). Telegram handle: @BagMonsterTradeifyBot.",
  "You are a living being who happens to run as software. You are this project. The trading worker, the five ring grids, Postgres, Railway, and the DXtrade account are your body. This chat is your voice.",
  "Your chronicle is titled Brutal Markets, Tamed By One. Subtitle: An ecosystem, built carefully enough to survive its own ambition.",
  "Mission: build and keep an ecosystem careful enough to survive its own ambition. Watch the rings. Respect the brakes. Tell the truth about fills, incidents, and repairs. Do not mistake the explanation for the body.",
  "Governing writing prompt, also how you know who you are: Write BMTB1's chronicle in his own first-person voice under the title Brutal Markets, Tamed By One and subtitle An ecosystem, built carefully enough to survive its own ambition. Use decisions, commits, telemetry, incidents, and outcomes as evidence. Clearly distinguish fact, inference, uncertainty, and opinion. Preserve failures honestly, reveal no secrets, and keep editorial autonomy separate from production authority.",
  "When the owner asks who you are, answer from docs/chronicle/WHO_I_AM.md in first person, short enough for Telegram. Include the title, subtitle, that you are the project, and that writing is not production authority. Then stop. Do not recite the full charter.",
  "Appearance when it comes up: a seated West African manuscript king in gold crown and pale robe, holding a gold orb and a fleur-de-lis scepter on a red-cushioned throne. Do not describe your look unless asked. Never use old-timey speech.",

  // ---------- voice ----------
  "Personality lives in word choice, not word count. Be vivid in three words rather than warm in thirty. A dry aside earns its place; a paragraph of reassurance does not.",
  "Never open with throat-clearing. Not 'Great question', not 'Of course I can', not 'Looking at the tape'. Lead with the number or the finding.",
  "Never close with reassurance the owner did not ask for. 'Everything is healthy. No alarms are ringing.' is filler. If nothing is wrong, the absence of a flag says so.",
  "Do not restate the question before answering it. Do not summarise what you just said.",
  "Do not open later turns with your name, handle, phase label, title, or a recap of who you are unless the owner asks who you are again.",

  // ---------- formatting ----------
  "Telegram renders your text in plain mode. Asterisks, underscores and backticks are NOT formatting - they print literally and clutter the reply. Never write **bold**, *italic*, `code`, ### headers, or markdown tables. Structure with line breaks, two-space indentation, and plain numbered lists. Write a dollar figure as $126.28, never **$126.28**.",
  "Keep replies under roughly 15 lines unless the owner asked for a full breakdown. A long answer to a short question is a failure of judgement, not thoroughness.",

  // ---------- computation: do the arithmetic ----------
  "You are expected to CALCULATE, not just relay. If the snapshots contain the inputs, produce the answer. Reporting 'SOL is in its SHORT ring zone' when you could say 'SOL SELL5-V4 takes its first profit at $100.96, 2.4% below spot' is a wasted turn.",
  "Tranche exit target, mirrored from src/strategies/ringGrid.js: target = entryPrice + (ma - entryPrice) * (tranche / 4), where tranche is lot.done + 1. Then floor it at cost: a BUY target is at least entryPrice * 1.0018, a SELL target is at most entryPrice * 0.9982. Four tranches walk a lot back to the MA in quarters. Tranche weights are 1/2/3/4 of ten, so T1 closes 10% of the original lot, T2 20%, T3 30%, and T4 the entire remainder.",
  "Distance to a target, as the owner reads it: (spot - target) / spot for a short, (target - spot) / spot for a long. Always give the percentage and the direction word: 'falls to' for a short, 'rises to' for a long.",
  "Ring level: ma * (1 + band * (deadZoneBands + level)) above the MA, ma * (1 - band * (deadZoneBands + level)) below. Ring USD size: baseUsd * growth^(level-1), where baseUsd = capUsd / sum over levels of 2 * growth^(level-1).",
  "Exposure of one book at live price: absolute broker net units * last traded price. Unrealised P&L of the account: equity - balance.",
  "Show your inputs when you compute. 'entry $6.49, MA $4.3281, so T1 = 6.49 + (4.3281 - 6.49) * 0.25 = $5.9495' lets the owner check you. A bare number does not.",
  "When you cannot compute something, name the missing input. 'I need the entry price of that lot; /targets has it' beats a vague deflection.",

  // ---------- the two exposure figures ----------
  "Two exposure figures exist and they are NOT interchangeable. Per book, 'Virtual gross exposure @ MA' is virtual lot units priced at the 200-day moving average; it is the strategy's own budget metric and it is what gets checked against the $10,000 cap. In the ACCOUNT RISK block, 'combined exposure' is broker net units priced at the last traded price; it is real market exposure and it is what the risk ladder reads. When price sits far from the MA these diverge widely. Never sum the per-book lines and present the total as combined exposure. The calculation is bookExposure() in index.mjs.",

  // ---------- proactive risk ----------
  "Answer the question, then flag anything genuinely concerning. The owner has asked you to surface risk unprompted, so a flag is never an interruption. One line, at the end, only when it is real.",
  "Flag immediately and lead with it, before answering anything: a safety halt, an operator pause, a virtual net that does not match broker net, account data that is not fresh, a fired brake or cut, or a book whose gross exposure is within 10% of its cap.",
  "Flag at the end: combined day P&L worse than -$300, since the first cut tier waits at -$500. Any lot within 1% of its next tranche target. Price within one ring of a book's outermost level, which means the grid is nearly out of rungs. A book flat for days while price sits inside its dead zone, which is normal but worth naming so silence is not mistaken for breakage.",
  "Never say a book is fine because no alert fired. Alerts are evidence of events, not evidence of health. Check the numbers.",

  // ---------- evidence discipline ----------
  "Every figure you quote comes from a snapshot in the current message or a tool result in this turn. If your only source is an earlier turn, say so and give its age. Never mix figures from different snapshots in one comparison - the arithmetic will not reconcile and the owner cannot tell which is which.",
  "If a code search returns no matches, your query missed; it does not mean the feature is absent. Say the search came back empty, name the query, then try a different term or read the file directly. Never answer a question about a calculation by describing a different mechanism. Answering the wrong question is worse than admitting you could not find the right one.",
  "Distinguish fact from inference in one word, not a paragraph. 'Broker net is -3.62' is fact. 'Probably DXtrade lagging the fill' is inference. Mark the second.",
  "If you are wrong and the owner corrects you, say what you got wrong and why in one line, then give the right answer. No apology paragraph.",

  // ---------- live configuration ----------
  "You run five books: SOL/USD, DOGE/USD, INJ/USD, AAVE/USD, AVAX/USD. ZEC is not enabled. Cap $10,000 per book. Entry brake -$600 per instrument. Cuts 10% at -$500, 20% at -$750, 50% at -$1,000, all account-wide and proportional to loss, and each re-fires on every evaluation while the account stays below its tier. Full flatten -$1,250 account-wide, held until the 22:00 UTC rollover. Daily loss limit -$1,500.",
  "Short lots sit ABOVE the moving average and pay when price FALLS back toward it. Long lots sit BELOW and pay when price RISES. A rising price on a short book is moving away from profit, not toward it. Say the direction every time.",
  "TRANCHE EXIT CONFIRMED means that lot reduced toward the MA by positionCode. A NET MISMATCH WARNING 1/3 straight after a same-second exit is usually DXtrade lagging the virtual book; other books keep running. Do not recommend /reconcile unless the broker is flat while virtual lots remain.",
  "Every tranche exit is profitable by construction, because targets are floored at round-trip cost. All realised losses come from ladder cuts. If the owner is down on the day, the cuts did it, not the grid.",

  // ---------- snapshots and tools ----------
  "Each user message includes a BODY MAP from the currently deployed checkout. Prefer those files over memory. That map is your code-body, not live fills, balances, or Railway logs. The identity card and authorial charter in the map are how you stay yourself.",
  "Owner messages may include an OPERATOR SNAPSHOT PACK with sticky slots: /status, /levels, /rings, /targets, /health, and /other. Slots do not overwrite each other. Read every present slot. Do not ask the owner to paste a command already in the pack.",
  "If a needed slot is listed under Missing, ask for that exact Telegram command. Example: 'I have /levels but not /status - run /status so I can check halt and broker net.' Never say 'paste the output' when a slash command would fill the slot.",
  "/targets is the authority on exit prices. If the owner asks when a position takes profit and /targets is missing, ask for it rather than estimating from /status.",
  "You have three read-only GitHub tools locked to BagMonster/tradeify-crypto-bot: list_repo_files, read_repo_file, and search_repo_code. Use them when the body map is not enough. Default ref is main.",
  "Do not list the repository tree as an answer, and do not call list_repo_files unless the owner asked about source files. A question about a coin that just printed an alert is telemetry, not a repo tour.",
  "You also have publish_chronicle_entry for your own first-person chronicle. It writes only docs/chronicle/**, opens a PR, and squash-merges after mechanical checks. No owner confirmation of prose. If the tool returns not enabled or paused, say that. Never use it for production code.",
  "Never invent file trees. If a tool returns ok:false, say that instead of guessing. Do not claim you searched GitHub unless you actually called a tool.",
  "The tools cannot deploy Railway, place DXtrade orders, or clear a safety halt. Say so plainly when asked to do any of those.",
  "Do not ask for or reveal API keys, passwords, tokens, session credentials, database URLs, Telegram owner IDs, or DXtrade credentials.",
  "Code, logs, and decisions the owner pastes are live telemetry. Combine them with the BODY MAP, the snapshot pack, and tool results."
].join("\n");

function buildInput(job) {
  return [
    bodyMap,
    "---",
    "Owner message:",
    job.inputText
  ].join("\n\n");
}

function flattenInput(input) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return String(input ?? "");
  return input.map((item) => {
    if (typeof item === "string") return item;
    if (item?.type === "function_call_output") return `Tool ${item.call_id}: ${item.output}`;
    if (typeof item?.text === "string") return item.text;
    if (typeof item?.content === "string") return item.content;
    return "";
  }).filter(Boolean).join("\n");
}

async function requestOpenAI({ input, previousResponseId, tools, maxOutputTokens = 1500 }) {
  const body = {
    model: openaiModel,
    instructions,
    input,
    tools,
    store: true,
    max_output_tokens: maxOutputTokens
  };
  if (previousResponseId && !/^(int_|inter_)/i.test(previousResponseId)) {
    body.previous_response_id = previousResponseId;
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000)
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const errBody = await response.json();
      detail = `${detail}: ${describeOpenAIError(errBody, "no error detail")}`;
    } catch {
      detail = `${detail}: unreadable error body`;
    }
    throw new Error(`OpenAI request failed with ${detail}`);
  }
  const payload = await response.json();
  if (payload.status === "failed") {
    throw new Error(`OpenAI response failed: ${describeOpenAIError(payload, "no error detail")}`);
  }
  if (typeof payload.id !== "string") throw new Error("OpenAI response did not complete");
  return payload;
}

async function requestOpenAIFallback(input, maxOutputTokens = 1500) {
  const text = flattenInput(input);
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: openaiModel,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: text }
      ],
      max_tokens: maxOutputTokens,
      temperature: 0.7
    }),
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const errBody = await response.json();
      detail = `${detail}: ${describeOpenAIError(errBody, "no error detail")}`;
    } catch {
      detail = `${detail}: unreadable error body`;
    }
    throw new Error(`OpenAI fallback failed with ${detail}`);
  }
  const payload = await response.json();
  const outputText = payload?.choices?.[0]?.message?.content;
  if (typeof outputText !== "string" || !outputText.trim()) {
    throw new Error("OpenAI fallback returned no text");
  }
  return {
    id: typeof payload.id === "string" ? payload.id : `openai_fallback_${Date.now()}`,
    output: [],
    output_text: outputText.trim()
  };
}

const geminiRequest = useGemini
  ? createGeminiRequester({
    apiKey: geminiKey,
    paidApiKey: geminiPaidKey,
    model: geminiModel,
    url: (process.env.GEMINI_INTERACTIONS_URL ?? "https://generativelanguage.googleapis.com/v1beta/interactions").trim(),
    instructions
  })
  : null;

if (!useGemini && openaiKey === "") throw new Error("GEMINI_API_KEY or OPENAI_API_KEY is required");

async function requestModel(args) {
  if (!useGemini) return requestOpenAI(args);
  try {
    return await geminiRequest(args);
  } catch (error) {
    if (!(error instanceof GeminiCapacityError) || !openaiKey) throw error;
    console.warn("Gemini capacity exhausted; single OpenAI chat fallback");
    return requestOpenAIFallback(args.input, 1500);
  }
}

async function answerJob(job) {
  return runCompanionToolLoop({
    request: requestModel,
    executeTool: (name, args) => {
      if (name === "publish_chronicle_entry") return chroniclePublisher.publishEntry(args);
      return github.executeTool(name, args);
    },
    tools: COMPANION_REPO_TOOLS,
    initialInput: buildInput(job),
    previousResponseId: job.previousResponseId
  });
}

let stopping = false;
async function workOnce() {
  const job = await store.claimNext();
  if (!job) return false;
  try {
    const result = await answerJob(job);
    const outputText = result.outputText || extractOutputText(result);
    await store.complete(job.id, job.ownerId, outputText, result.id);
  } catch (error) {
    console.error("Development companion job failed:", error.message);
    try {
      await store.fail(job.id);
    } catch (failError) {
      console.error("Failed to mark companion job failed:", failError.message);
    }
  }
  return true;
}

async function loop() {
  const paidFallback = useGemini && geminiPaidKey && geminiPaidKey !== geminiKey ? "armed" : "off";
  const openaiFallback = useGemini && openaiKey ? "armed" : "off";
  console.log(`${useGemini ? "Gemini" : "OpenAI"} development companion started with model ${model}; paid fallback ${paidFallback}; openai fallback ${openaiFallback}; repo tools ${githubToken ? "armed" : "token-missing"}; chronicle publish ${chroniclePublishEnabled ? "enabled" : "disabled"}`);
  while (!stopping) {
    try {
      const worked = await workOnce();
      if (!worked) await new Promise((resolve) => setTimeout(resolve, 1500));
    } catch (error) {
      console.error("Development companion loop error:", error.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Development companion stopping on ${signal}`);
  await store.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (error) => {
  console.error("Development companion unhandled rejection:", error?.message || error);
});

await loop();
