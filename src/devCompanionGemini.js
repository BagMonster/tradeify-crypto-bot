const DEFAULT_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const DEFAULT_MODEL = "gemini-3.7-flash";

function describeGeminiError(payload, fallback) {
  const err = payload && typeof payload === "object" ? payload.error : null;
  const parts = [err?.status, err?.code, err?.message, err?.type]
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== "");
  return parts.length > 0 ? parts.map((value) => String(value)).join(" | ") : fallback;
}

function mapTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ?? { type: "object", properties: {} }
  }));
}

function mapInput(input, callNames) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return String(input ?? "");
  return input.map((item) => {
    if (item?.type === "function_call_output") {
      const name = callNames.get(item.call_id) || item.name || "";
      return {
        type: "function_result",
        call_id: item.call_id,
        name,
        result: [{ type: "text", text: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? {}) }]
      };
    }
    return item;
  });
}

function extractFunctionCalls(payload) {
  const steps = Array.isArray(payload?.steps) ? payload.steps : Array.isArray(payload?.output) ? payload.output : [];
  return steps
    .filter((step) => step?.type === "function_call" && typeof step.name === "string")
    .map((step) => {
      const callId = String(step.id || step.call_id || "");
      const args = step.arguments;
      return {
        type: "function_call",
        name: step.name,
        call_id: callId,
        arguments: typeof args === "string" ? args : JSON.stringify(args ?? {})
      };
    })
    .filter((step) => step.call_id !== "");
}

function extractOutputText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const steps = Array.isArray(payload?.steps) ? payload.steps : [];
  return steps
    .filter((step) => step?.type === "model_output" && Array.isArray(step.content))
    .flatMap((step) => step.content)
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function createGeminiRequester({
  apiKey,
  model = DEFAULT_MODEL,
  url = DEFAULT_URL,
  instructions,
  fetchImpl = fetch
}) {
  if (typeof apiKey !== "string" || apiKey.trim() === "") throw new TypeError("GEMINI_API_KEY is required");
  const callNames = new Map();

  return async function requestGemini({ input, previousResponseId, tools }) {
    const body = {
      model,
      system_instruction: instructions,
      input: mapInput(input, callNames),
      tools: mapTools(tools),
      store: true,
      generation_config: { max_output_tokens: 3000 }
    };
    if (previousResponseId) body.previous_interaction_id = previousResponseId;

    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000)
    });

    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }

    if (!response.ok) {
      throw new Error(`Gemini request failed with HTTP ${response.status}: ${describeGeminiError(payload, "no error detail")}`);
    }
    if (!payload || typeof payload.id !== "string" || payload.id.trim() === "") {
      throw new Error(`Gemini response did not complete: ${describeGeminiError(payload, "missing interaction id")}`);
    }

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
