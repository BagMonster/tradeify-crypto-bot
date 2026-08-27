const DEFAULT_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const DEFAULT_MODEL = "gemini-3.7-flash";
const DEFAULT_FALLBACK_MODEL = "gemini-3.6-flash";
const GEMINI_INTERACTION_ID = /^(int_|inter_)/i;

export class GeminiCapacityError extends Error {
  constructor(message) {
    super(message);
    this.name = "GeminiCapacityError";
    this.code = "GEMINI_CAPACITY";
  }
}

function describeGeminiError(payload, fallback) {
  const err = payload && typeof payload === "object" ? payload.error : null;
  const parts = [err?.status, err?.code, err?.message, err?.type];
  const violations = Array.isArray(err?.details)
    ? err.details.flatMap((detail) => Array.isArray(detail.fieldViolations) ? detail.fieldViolations : [])
      .map((item) => [item.field, item.description].filter(Boolean).join(": "))
    : [];
  const all = [...parts, ...violations]
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== "");
  return all.length > 0 ? all.map((value) => String(value)).join(" | ") : fallback;
}

function isCapacityError(status, payload) {
  const text = `${status} ${describeGeminiError(payload, "")}`;
  return status === 429 || status === 500 || status === 503 || /high demand|resource.?exhausted|unavailable|overloaded/i.test(text);
}

function isRetryablePreviousId(status, payload) {
  const text = `${status} ${describeGeminiError(payload, "")}`;
  return /not found|INVALID_ARGUMENT|invalid argument|previous_interaction|expired|unknown interaction/i.test(text);
}

function isToolFollowUp(input) {
  return Array.isArray(input) && input.some((item) => item?.type === "function_call_output" || item?.type === "function_result" || item?.function_response);
}

function sanitizeSchema(value) {
  if (Array.isArray(value)) return value.map(sanitizeSchema);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "additionalProperties" || key === "additional_properties") continue;
    out[key] = sanitizeSchema(child);
  }
  return out;
}

function mapTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: sanitizeSchema(tool.parameters ?? { type: "object", properties: {} })
  }));
}

function mapInput(input, callNames) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return String(input ?? "");
  return input.map((item) => {
    if (item?.type === "function_call_output") {
      const name = callNames.get(item.call_id) || item.name || "";
      const text = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? {});
      return {
        type: "function_result",
        call_id: item.call_id,
        name,
        result: [{ type: "text", text }]
      };
    }
    return item;
  });
}

function collectCallsFromParts(parts, bucket) {
  if (!Array.isArray(parts)) return;
  for (const part of parts) {
    const call = part?.function_call;
    if (call && typeof call.name === "string") {
      bucket.push({
        name: call.name,
        id: call.id || call.call_id || "",
        arguments: call.args ?? call.arguments ?? {}
      });
    }
  }
}

function extractFunctionCalls(payload) {
  const found = [];
  const steps = Array.isArray(payload?.steps) ? payload.steps : Array.isArray(payload?.output) ? payload.output : [];
  for (const step of steps) {
    if (step?.type === "function_call" && typeof step.name === "string") {
      found.push({
        name: step.name,
        id: step.id || step.call_id || "",
        arguments: step.arguments ?? step.args ?? {}
      });
      continue;
    }
    collectCallsFromParts(step?.content, found);
    collectCallsFromParts(step?.model_output?.parts, found);
    collectCallsFromParts(step?.parts, found);
  }
  return found.map((step, index) => {
    const callId = String(step.id || `fc_${step.name}_${index}`);
    const args = step.arguments;
    return {
      type: "function_call",
      name: step.name,
      call_id: callId,
      arguments: typeof args === "string" ? args : JSON.stringify(args ?? {})
    };
  });
}

function extractOutputText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const chunks = [];
  const steps = Array.isArray(payload?.steps) ? payload.steps : [];
  for (const step of steps) {
    const parts = Array.isArray(step?.content)
      ? step.content
      : Array.isArray(step?.model_output?.parts)
        ? step.model_output.parts
        : [];
    for (const part of parts) {
      if (typeof part?.text === "string" && part.text.trim()) chunks.push(part.text.trim());
    }
  }
  return chunks.join("\n").trim();
}

export function createGeminiRequester({
  apiKey,
  paidApiKey = "",
  model = DEFAULT_MODEL,
  fallbackModel = DEFAULT_FALLBACK_MODEL,
  url = DEFAULT_URL,
  instructions,
  fetchImpl = fetch
}) {
  if (typeof apiKey !== "string" || apiKey.trim() === "") throw new TypeError("GEMINI_API_KEY is required");
  const primaryKey = apiKey.trim();
  const fallbackKey = typeof paidApiKey === "string" && paidApiKey.trim() && paidApiKey.trim() !== primaryKey
    ? paidApiKey.trim()
    : "";
  const backupModel = typeof fallbackModel === "string" && fallbackModel.trim() && fallbackModel.trim() !== model
    ? fallbackModel.trim()
    : "";
  const callNames = new Map();
  let lastKey = primaryKey;
  let lastModel = model;

  async function post(body, key) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000)
    });
    let payload = {};
    try { payload = await response.json(); } catch { payload = {}; }
    return { response, payload };
  }

  return async function requestGemini({ input, previousResponseId, tools }) {
    const followUp = isToolFollowUp(input);
    const usablePrevious = typeof previousResponseId === "string" && GEMINI_INTERACTION_ID.test(previousResponseId)
      ? previousResponseId
      : null;
    const body = {
      model: followUp ? lastModel : model,
      system_instruction: instructions,
      input: mapInput(input, callNames),
      tools: mapTools(tools),
      store: true
    };
    if (usablePrevious) body.previous_interaction_id = usablePrevious;

    const startKey = followUp ? lastKey : primaryKey;
    let { response, payload } = await post(body, startKey);
    if (!followUp && !response.ok && body.previous_interaction_id && isRetryablePreviousId(response.status, payload)) {
      delete body.previous_interaction_id;
      ({ response, payload } = await post(body, startKey));
    }
    if (!followUp && !response.ok && fallbackKey && isCapacityError(response.status, payload)) {
      console.warn(`Primary Gemini key hit HTTP ${response.status}; retrying paid key on ${model}`);
      await new Promise((resolve) => setTimeout(resolve, 800));
      ({ response, payload } = await post(body, fallbackKey));
      if (response.ok) lastKey = fallbackKey;
    }
    if (!followUp && !response.ok && backupModel && (isCapacityError(response.status, payload) || response.status === 404)) {
      const key = fallbackKey || primaryKey;
      console.warn(`Gemini ${body.model} still at HTTP ${response.status}; retrying ${backupModel}`);
      body.model = backupModel;
      await new Promise((resolve) => setTimeout(resolve, 800));
      ({ response, payload } = await post(body, key));
      if (response.ok) {
        lastKey = key;
        lastModel = backupModel;
      }
    }

    if (!response.ok) {
      const detail = `Gemini request failed with HTTP ${response.status}: ${describeGeminiError(payload, "no error detail")}`;
      if (isCapacityError(response.status, payload) || response.status === 404) throw new GeminiCapacityError(detail);
      throw new Error(detail);
    }
    if (!payload || typeof payload.id !== "string" || payload.id.trim() === "") {
      throw new Error(`Gemini response did not complete: ${describeGeminiError(payload, "missing interaction id")}`);
    }

    lastKey = followUp ? startKey : (lastKey || startKey);
    lastModel = body.model;
    const mappedCalls = extractFunctionCalls(payload);
    for (const call of mappedCalls) callNames.set(call.call_id, call.name);

    return {
      id: payload.id,
      output: mappedCalls,
      output_text: extractOutputText(payload),
      status: payload.status ?? null
    };
  };
}
