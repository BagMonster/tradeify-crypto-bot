import test from "node:test";
import assert from "node:assert/strict";
import { createGeminiRequester } from "../src/devCompanionGemini.js";

test("maps tools to function_declarations and reads nested function_call parts", async () => {
  const seen = [];
  const request = createGeminiRequester({
    apiKey: "test-key",
    model: "gemini-3.7-flash",
    instructions: "You are BMTB1.",
    fetchImpl: async (_url, init) => {
      seen.push(JSON.parse(init.body));
      if (seen.length === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "inter_abc123XYZ",
            steps: [{
              model_output: {
                parts: [{ function_call: { name: "list_repo_files", args: {} } }]
              }
            }]
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "inter_def456UVW",
          output_text: "Listed root.",
          steps: [{
            model_output: { parts: [{ text: "Listed root." }] }
          }]
        })
      };
    }
  });

  const first = await request({
    input: "list root",
    tools: [{ type: "function", name: "list_repo_files", description: "list", parameters: { type: "object" } }]
  });
  assert.equal(first.output[0].name, "list_repo_files");
  assert.equal(seen[0].tools[0].function_declarations[0].name, "list_repo_files");
  assert.equal(seen[0].store, true);

  const second = await request({
    input: [{ type: "function_call_output", call_id: first.output[0].call_id, output: JSON.stringify({ files: ["index.mjs"] }) }],
    previousResponseId: "inter_abc123XYZ",
    tools: [{ type: "function", name: "list_repo_files", description: "list", parameters: { type: "object" } }]
  });
  assert.equal(second.output_text, "Listed root.");
  assert.equal(seen[1].previous_interaction_id, "inter_abc123XYZ");
  assert.equal(seen[1].input[0].function_response.name, "list_repo_files");
});
