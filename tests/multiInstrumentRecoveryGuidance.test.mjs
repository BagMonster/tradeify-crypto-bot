import test from "node:test";
import assert from "node:assert/strict";
import { createMultiInstrumentOwnerService } from "../src/multiInstrumentOwnerService.js";

test("status puts the exact reconcile and rerun recovery plan above the book details", async () => {
  const service = createMultiInstrumentOwnerService({
    instrumentConfigs: [
      { enabled: true, instrument: "SOL/USD", orderPrefix: "SOL" },
      { enabled: true, instrument: "INJ/USD", orderPrefix: "INJ" }
    ],
    buildOwnerService: (cfg) => ({
      statusText: async () => `${cfg.instrument} STATUS`,
      inspectForRerun: async () => cfg.instrument === "INJ/USD"
        ? { instrument: "INJ/USD", ok: true, match: false, virtualNet: -0.14, brokerNet: 0, openLots: 2 }
        : { instrument: "SOL/USD", ok: true, match: true, virtualNet: -1, brokerNet: -1, openLots: 1 }
    })
  });

  const text = await service.statusText();
  assert.match(text, /VIRTUAL INVENTORY RECONCILIATION REQUIRED/);
  assert.match(text, /INJ\/USD: DXtrade is flat, but 2 virtual lots remain/);
  assert.match(text, /1\. Send \/reconcile INJ/);
  assert.match(text, /2\. Send \/confirmreconcile CODE INJ/);
  assert.match(text, /After every listed book shows virtual 0\.00, broker 0\.00, and 0 lots, send \/rerun again/);
  assert.ok(text.indexOf("VIRTUAL INVENTORY RECONCILIATION REQUIRED") < text.indexOf("SOL/USD STATUS"));
});

test("status remains readable when a book inspection throws", async () => {
  const service = createMultiInstrumentOwnerService({
    instrumentConfigs: [{ enabled: true, instrument: "SOL/USD", orderPrefix: "SOL" }],
    buildOwnerService: () => ({
      statusText: async () => "SOL/USD STATUS",
      inspectForRerun: async () => {
        throw new Error("DXtrade positions read failed");
      }
    })
  });

  const text = await service.statusText();
  assert.match(text, /ACCOUNT RISK: supervisor snapshot unavailable/);
  assert.match(text, /SOL\/USD STATUS/);
});
