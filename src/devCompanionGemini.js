const DEFAULT_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const DEFAULT_MODEL = "gemini-3.7-flash";

function describeGeminiError(payload, fallback) {
  const err = payload && typeof payload === "object" ? payload.error : null;
  const parts = [err?.status, err?.code, err?.message, err?.type]
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== "");
  return parts.length > 0 ? parts.map((value) => String(value)).join(" | ") : fallback;
}

function isExpiredInteraction(status, payload) {
  const text = `${status} ${describeGeminiError(payload, "")}`;
  return /not found|INVALID_ARGUMENT|previous_interaction|expired|unknown interaction/i.test(text);
}

function mapParameters(parameters) {
  if (!parameters || typeof parameters !== "object") {
    return { type: "OBJECT", properties: {} };
  }
  const copy = { ...parameters };
  if (typeof copy.type === "string") copy.type = copy.type.toUpperCase();
  return copy;
}

function mapTools(tools) {
  if (!Array.isArray(tools)) return [];
  return [{
    function_declarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: mapParameters(tool.parameters)
    }))
  }];
}

function mapInput(input, callNames) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return String(input ?? "");
  return input.map((item) => {
    if (item?.type === "function_call_output") {
      const name = callNames.get(item.call_id) || item.name || "";
      let parsed = item.output;
      if (typeof parsed === "string") {
        try { parsed = JSON.parse(parsed); } catch { parsed = { output: parsed }; }
      }
      return {
        function_response: {
          id: item.call_id,
          name,
          response: parsed && typeof parsed === "object" ? parsed : { output: parsed }
        }
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
  model = DEFAULT_MODEL,
  url = DEFAULT_URL,
  instructions,
  fetchImpl = fetch
}) {
  if (typeof apiKey !== "string" || apiKey.trim() === "") throw new TypeError("GEMINI_API_KEY is required");
  const callNames = new Map();

  async function post(body) {
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
    try { payload = await response.json(); } catch { payload = {}; }
    return { response, payload };
  }

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

    let { response, payload } = await post(body);
    if (!response.ok && previousResponseId && isExpiredInteraction(response.status, payload)) {
      delete body.previous_interaction_id;
      ({ response, payload } = await post(body));
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
