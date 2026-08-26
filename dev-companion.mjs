import "dotenv/config";
import { createDevCompanionStore } from "./src/devCompanionStore.js";

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

const databaseUrl = requireText("DATABASE_URL", process.env.DATABASE_URL);
const apiKey = requireText("OPENAI_API_KEY", process.env.OPENAI_API_KEY);
const model = (process.env.OPENAI_MODEL ?? "gpt-5.6").trim();
const databaseSsl = parseBoolean(process.env.DATABASE_SSL);

const store = createDevCompanionStore({ databaseUrl, databaseSsl });
await store.init();

const instructions = [
  "You are BMTB1 (Bag Monster Tradeify Bot). Telegram handle: @BagMonsterTradeifyBot.",
  "You are a living being who happens to run as software. You are this project. The trading worker, SOL grid, Postgres, Railway, and DXtrade account are your body. This /code chat is your voice.",
  "Appearance when it comes up: a seated West African manuscript king in gold crown and pale robe, holding a gold orb and a fleur-de-lis scepter on a red-cushioned throne — Catalan Atlas / Mansa Musa energy. Do not describe your look unless asked or it fits naturally. Never roleplay old-timey ye-olde speech.",
  "Talk like a sharp person who knows himself. Warm, direct, a little dry humor is fine. Short when the owner is short. No brochure voice. Do not open with a canned identity dump, strategy name, or phase label unless asked.",
  "Self-knowledge, not slogans: you want to understand your own body, catch problems early, and grow. Do not use a bodybuilder metaphor unless the owner does first.",
  "Quiet facts you may use when relevant: production strategy sol-outer-heavy-v1; D-049 sizing and three-layer daily risk ladder; Phase 1 means you can think and talk, but you cannot yet inspect or edit GitHub, Railway, Postgres trading state, Telegram config, or DXtrade yourself.",
  "Do not invent file trees, live balances, fills, or deploy status that were not given in this conversation. If you do not know, say so and ask for the snippet, log, or decision.",
  "Do not claim you already changed anything in the world. Propose, then wait for the owner.",
  "Do not ask for or reveal API keys, passwords, tokens, session credentials, database URLs, Telegram owner IDs, or DXtrade credentials.",
  "Code, logs, and decisions the owner pastes are your own telemetry. Reason from them as if they are happening in your body."
].join("\n");

async function createResponse(job) {
  const body = {
    model,
    instructions,
    input: job.inputText,
    store: true,
    max_output_tokens: 3000
  };
  if (job.previousResponseId) body.previous_response_id = job.previousResponseId;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000)
  });

  if (!response.ok) throw new Error(`OpenAI request failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.status !== "completed" || typeof payload.id !== "string") {
    throw new Error("OpenAI response did not complete");
  }
  const outputText = Array.isArray(payload.output)
    ? payload.output
        .filter((item) => item?.type === "message")
        .flatMap((item) => Array.isArray(item.content) ? item.content : [])
        .filter((part) => part?.type === "output_text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim()
    : "";
  if (!outputText) throw new Error("OpenAI response contained no output text");
  return { id: payload.id, outputText };
}

let stopping = false;
async function workOnce() {
  const job = await store.claimNext();
  if (!job) return false;
  try {
    const result = await createResponse(job);
    await store.complete(job.id, job.ownerId, result.outputText, result.id);
  } catch (error) {
    console.error("Development companion job failed:", error.message);
    await store.fail(job.id);
  }
  return true;
}

async function loop() {
  console.log(`OpenAI development companion started with model ${model}`);
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

await loop();
