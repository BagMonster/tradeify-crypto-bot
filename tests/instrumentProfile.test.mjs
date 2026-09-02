import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveInstrumentProfile,
  getSupportedInstrumentProfile
} from "../src/instrumentProfile.js";

test("resolves SOL/USD to Binance SOLUSDT and DXtrade SOL/USD", () => {
  const profile = resolveInstrumentProfile({
    instruments: {
      "BTC/USD": { enabled: false },
      "SOL/USD": { enabled: true }
    }
  });
  assert.deepEqual(profile, {
    asset: "SOL",
    dxtradeSymbol: "SOL/USD",
    binanceSymbol: "SOLUSDT",
    binanceStream: "solusdt@trade",
    lotStep: 0.01
  });
});

test("requires exactly one enabled supported instrument", () => {
  assert.throws(() => resolveInstrumentProfile({
    instruments: {
      "BTC/USD": { enabled: true },
      "SOL/USD": { enabled: true }
    }
  }), /exactly one trading instrument/i);

  assert.throws(() => resolveInstrumentProfile({
    instruments: {
      "BTC/USD": { enabled: false },
      "SOL/USD": { enabled: false }
    }
  }), /exactly one trading instrument/i);
});

test("supported profiles remain explicit", () => {
  assert.equal(getSupportedInstrumentProfile("BTC/USD").binanceSymbol, "BTCUSDT");
  assert.equal(getSupportedInstrumentProfile("SOL/USD").binanceSymbol, "SOLUSDT");
  assert.throws(() => getSupportedInstrumentProfile("ETH/USD"), /unsupported instrument/i);
});
