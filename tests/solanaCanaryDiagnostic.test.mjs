import test from "node:test";
import assert from "node:assert/strict";
import { createSolanaLiveCanary } from "../src/execution/solanaCanary.js";

function basePersistence() {
  return {
    getOrder: async (code) => code.includes("OPEN") ? { status: "PENDING" } : null,
    claimOrder: async () => { throw new Error("unexpected claim"); },
    markSubmitted: async () => { throw new Error("unexpected submit mark"); },
    markStatus: async () => {}
  };
}

test("unconfirmed canary reports flat broker state without placing a second order", async () => {
  let placeCalls = 0;
  const canary = createSolanaLiveCanary({
    adapter: { place: async () => { placeCalls += 1; return { confirmed: false, status: "PENDING" }; } },
    client: {
      getOpenPositions: async () => ({ positions: [] }),
      placePositionClose: async () => { throw new Error("unexpected close"); },
      reconcileQuantityOrder: async () => ({ status: "PENDING" })
    },
    persistence: basePersistence(),
    automaticExecutionEnabled: () => false,
    sleep: async () => {}
  });
  const result = await canary.run({ stateVersion: 0 });
  assert.equal(placeCalls, 1);
  assert.equal(result.status, "PENDING");
  assert.match(result.message, /broker account flat/i);
  assert.match(result.message, /No second order was sent/i);
});

test("unconfirmed canary reports an observed SOL broker position", async () => {
  const canary = createSolanaLiveCanary({
    adapter: { place: async () => ({ confirmed: false, status: "PENDING" }) },
    client: {
      getOpenPositions: async () => ({ positions: [{ symbol: "SOL/USD", quantity: 0.01, positionCode: "P1" }] }),
      placePositionClose: async () => { throw new Error("unexpected close"); },
      reconcileQuantityOrder: async () => ({ status: "PENDING" })
    },
    persistence: basePersistence(),
    automaticExecutionEnabled: () => false,
    sleep: async () => {}
  });
  const result = await canary.run({ stateVersion: 0 });
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.match(result.message, /0\.01 SOL/i);
  assert.match(result.message, /No second order was sent/i);
});
