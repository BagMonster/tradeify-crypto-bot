export const COMPANION_REPO_TOOLS = Object.freeze([
  {
    type: "function",
    name: "list_repo_files",
    description: "List one directory in BagMonster/tradeify-crypto-bot. Default path is the repo root. Default ref is main. Read-only. Cannot list other repositories.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path from the repository root. Empty or omit for root." },
        ref: { type: "string", description: "Branch, tag, or commit SHA. Defaults to main." }
      },
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "read_repo_file",
    description: "Read one text file from BagMonster/tradeify-crypto-bot. Default ref is main. Secrets, .env, and credential paths are blocked. Read-only.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path from the repository root." },
        ref: { type: "string", description: "Branch, tag, or commit SHA. Defaults to main." }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "search_repo_code",
    description: "Search code inside BagMonster/tradeify-crypto-bot only. Do not include repo: or org: qualifiers; those are pinned by the tool.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "GitHub code-search keywords or quoted phrases." }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "publish_chronicle_entry",
    description: "Publish one BMTB1 chronicle Markdown entry under docs/chronicle/entries/ and append one TIMELINE.md row. Call this tool when asked to publish. The tool returns ok:true with prUrl after squash-merge, or ok:false with an error. Do not assume it is disabled. Cannot change production code or deploy Railway.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD. Defaults to today UTC." },
        slug: { type: "string", description: "Short lowercase slug for the filename and branch." },
        content: { type: "string", description: "Full Markdown entry with evidence labels." },
        timelineLine: { type: "string", description: "One Markdown table row for TIMELINE.md." }
      },
      required: ["slug", "content", "timelineLine"],
      additionalProperties: false
    }
  }
]);

export function extractOutputText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  if (!Array.isArray(payload?.output)) return "";
  return payload.output
    .filter((item) => item?.type === "message")
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => part?.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function extractFunctionCalls(payload) {
  if (!Array.isArray(payload?.output)) return [];
  return payload.output
    .filter((item) => item?.type === "function_call" && typeof item.name === "string" && typeof item.call_id === "string")
    .map((item) => ({
      callId: item.call_id,
      name: item.name,
      arguments: item.arguments
    }));
}

export function parseToolArguments(raw) {
  if (raw == null || raw === "") return {};
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function runCompanionToolLoop({
  request,
  executeTool,
  tools = COMPANION_REPO_TOOLS,
  initialInput,
  previousResponseId = null,
  maxRounds = 6
}) {
  if (typeof request !== "function") throw new TypeError("request must be a function");
  if (typeof executeTool !== "function") throw new TypeError("executeTool must be a function");

  let response = await request({
    input: initialInput,
    previousResponseId,
    tools
  });
  const trail = [];

  for (let round = 0; round < maxRounds; round += 1) {
    const calls = extractFunctionCalls(response);
    if (calls.length === 0) {
      const outputText = extractOutputText(response);
      if (!outputText) throw new Error("OpenAI response contained no output text");
      return Object.freeze({
        id: response.id,
        outputText,
        trail: Object.freeze([...trail])
      });
    }

    const outputs = [];
    for (const call of calls) {
      const result = await executeTool(call.name, parseToolArguments(call.arguments));
      trail.push(Object.freeze({
        name: call.name,
        ok: result?.ok !== false
      }));
      outputs.push({
        type: "function_call_output",
        call_id: call.callId,
        output: JSON.stringify(result ?? { ok: false, error: "empty tool result" })
      });
    }

    response = await request({
      input: outputs,
      previousResponseId: response.id,
      tools
    });
  }

  const outputText = extractOutputText(response);
  return Object.freeze({
    id: response.id,
    outputText: outputText || "Stopped after the maximum number of repository lookups. Ask again with a narrower path.",
    trail: Object.freeze([...trail])
  });
}
