import test from "node:test";
import assert from "node:assert/strict";
import { createGeminiRequester } from "../src/devCompanionGemini.js";

test("maps OpenAI-style tools and function outputs onto Interactions payloads", async () => {
  const seen = [];
  const request = createGeminiRequester({
    apiKey: "test-key",
    model: "gemini-3.7-flash",
    instructions: "You are BMTB1.",
    fetchImpl: async (url, init) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      if (seen.length === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "int_1",
            status: "requires_action",
            steps: [{
              type: "function_call",
              id: "fc_1",
              name: "list_repo_files",
              arguments: { path: "src" }
            }]
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "int_2",
          status: "completed",
          output_text: "Listed src.",
          steps: [{ type: "model_output", content: [{ type: "text", text: "Listed src." }] }]
        })
      };
    }
  });

  const first = await request({
    input: "body map\n---\nOwner message:\nlist src",
    tools: [{ type: "function", name: "list_repo_files", description: "list", parameters: { type: "object" } }]
  });
  assert.equal(first.id, "int_1");
  assert.equal(first.output[0].call_id, "fc_1");
  assert.equal(first.output[0].name, "list_repo_files");
  assert.equal(JSON.parse(first.output[0].arguments).path, "src");
  assert.equal(seen[0].headers["x-goog-api-key"], "test-key");
  assert.equal(seen[0].body.tools[0].name, "list_repo_files");
  assert.ok(!JSON.stringify(seen[0]).includes("Authorization"));

  const second = await request({
    input: [{ type: "function_call_output", call_id: "fc_1", output: JSON.stringify({ ok: true }) }],
    previousResponseId: "int_1",
    tools: [{ type: "function", name: "list_repo_files", description: "list", parameters: { type: "object" } }]
  });
  assert.equal(second.output_text, "Listed src.");
  assert.equal(seen[1].body.previous_interaction_id, "int_1");
  assert.equal(seen[1].body.input[0].type, "function_result");
  assert.equal(seen[1].body.input[0].name, "list_repo_files");
  assert.equal(seen[1].body.input[0].call_id, "fc_1");
});
