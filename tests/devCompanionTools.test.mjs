import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPANION_REPO_TOOLS,
  extractFunctionCalls,
  runCompanionToolLoop
} from "../src/devCompanionTools.js";

test("tool definitions include inspection plus chronicle publish", () => {
  assert.deepEqual(
    COMPANION_REPO_TOOLS.map((tool) => tool.name),
    ["list_repo_files", "read_repo_file", "search_repo_code", "publish_chronicle_entry"]
  );
  assert.ok(COMPANION_REPO_TOOLS.every((tool) => tool.type === "function"));
  assert.equal(COMPANION_REPO_TOOLS.some((tool) => /deploy|halt|order/i.test(tool.name)), false);
});

test("tool loop executes function calls then returns final text", async () => {
  const requests = [];
  const toolsUsed = [];
  const result = await runCompanionToolLoop({
    initialInput: "Where is confirmReconcile?",
    previousResponseId: "resp_prev",
    executeTool: async (name, args) => {
      toolsUsed.push({ name, args });
      return { ok: true, path: "src/solanaTradeifyService.js", content: "confirmReconcile" };
    },
    request: async ({ input, previousResponseId, tools }) => {
      requests.push({ input, previousResponseId, toolCount: tools.length });
      if (requests.length === 1) {
        return {
          id: "resp_tools",
          output: [{
            type: "function_call",
            call_id: "call_1",
            name: "search_repo_code",
            arguments: JSON.stringify({ query: "confirmReconcile" })
          }]
        };
      }
      return {
        id: "resp_final",
        output: [{
          type: "message",
          content: [{ type: "output_text", text: "It lives in src/solanaTradeifyService.js." }]
        }]
      };
    }
  });

  assert.equal(result.id, "resp_final");
  assert.match(result.outputText, /solanaTradeifyService/);
  assert.deepEqual(toolsUsed, [{ name: "search_repo_code", args: { query: "confirmReconcile" } }]);
  assert.equal(requests[0].previousResponseId, "resp_prev");
  assert.equal(requests[1].input[0].type, "function_call_output");
  assert.equal(requests[1].input[0].call_id, "call_1");
  assert.equal(requests[1].previousResponseId, "resp_tools");
});

test("extracts function calls only from output items", () => {
  const calls = extractFunctionCalls({
    output: [
      { type: "message", content: [{ type: "output_text", text: "hi" }] },
      { type: "function_call", name: "list_repo_files", call_id: "c1", arguments: "{}" }
    ]
  });
  assert.deepEqual(calls, [{ callId: "c1", name: "list_repo_files", arguments: "{}" }]);
});
