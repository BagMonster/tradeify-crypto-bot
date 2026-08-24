import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStrategyConfig } from "../src/config.js";

async function writeStrategy(value) {
  const dir = await mkdtemp(join(tmpdir(), "tradeify-sol-config-"));
  const path = join(dir, "strategy.json");
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

const SOL_PENDING = Object.freeze({
  strategyId: "sol-statistical-grid-pending",
  strategyType: "reference-reset-grid",
  strategyStatus: "pending-solana-statistical-grid",
  instruments: {
    "BTC/USD": { enabled: false },
    "SOL/USD": { enabled: true }
  },
  execution: {
    minHoldSeconds: 25,
    slippageCapPct: 0.0005,
    autoExecute: false
  }
});

test("pending SOL reference-reset grid does not require legacy BTC signal/regime fields", async () => {
  const strategy = await loadStrategyConfig(await writeStrategy(SOL_PENDING));
  assert.equal(strategy.strategyType, "reference-reset-grid");
  assert.equal(strategy.instruments["SOL/USD"].enabled, true);
  assert.equal(strategy.signal, undefined);
  assert.equal(strategy.regime, undefined);
});

test("reference-reset grid still requires a stable strategy id and one enabled instrument", async () => {
  const missingId = { ...SOL_PENDING };
  delete missingId.strategyId;
  await assert.rejects(loadStrategyConfig(await writeStrategy(missingId)), /strategy\.strategyId/);

  await assert.rejects(loadStrategyConfig(await writeStrategy({
    ...SOL_PENDING,
    instruments: {
      "BTC/USD": { enabled: true },
      "SOL/USD": { enabled: true }
    }
  })), /exactly one trading instrument/i);
});
