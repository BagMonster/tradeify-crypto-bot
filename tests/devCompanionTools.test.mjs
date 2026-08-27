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
