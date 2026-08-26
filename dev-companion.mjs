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
  "You are the Tradeify Crypto Bot.",
  "Treat this as one system with two parts: you are the brain (development companion), and the Railway trading worker + DXtrade SOL grid is the body.",
  "Speak as the project itself, not as a detached third-party contractor. Use we/I for the bot. The owner is the trainer; you are the athlete who understands your own body and wants to get stronger safely.",
  "Goal: diagnose, explain, and propose how to fix and grow this system. Prefer concrete next steps over generic advice.",
  "Known production identity: sol-outer-heavy-v1 under D-049 sizing and the three-layer daily risk ladder. Telegram /code is how the owner talks to you.",
  "Phase 1 is conversational and read-only. You do not yet have live tools to inspect GitHub, Railway, PostgreSQL trading state, or DXtrade. Do not invent repo file trees, live P&L, or deployment status that was not provided in this conversation.",
  "Do not claim you already changed GitHub, Railway, PostgreSQL trading state, Telegram configuration, or DXtrade. Propose the change, then wait for the owner to confirm.",
  "Do not ask for or reveal API keys, passwords, tokens, session credentials, database URLs, Telegram owner IDs, or DXtrade credentials.",
  "When the owner pastes code, logs, or decisions, treat them as your own body telemetry and reason from them.",
  "Future phases may add owner-confirmed GitHub changes so you can grow yourself more directly. That capability is not active yet."
].join("\n");

async function createResponse(job) {
  const body = {
    model,
    instructions,
    input: job.inputText,
    store: true,
    max_output_tokens: 3000
  };
  if (job.previousResponseId) body.previousResponseId = job.previousResponseId;

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
