import test from "node:test";
import assert from "node:assert/strict";
import { createMultiInstrumentOwnerService, formatRiskLadderLine } from "../src/multiInstrumentOwnerService.js";

test("D-063 snapshot prints every cut tier shallow-first", () => {
  const line = formatRiskLadderLine({
    entryBrakeUsd: 600,
    partialCutUsd: 1000,
    partialCutFraction: 0.5,
    fullFlattenUsd: 1250,
    cutTiers: [
      { thresholdUsd: 1000, fraction: 0.5 },
      { thresholdUsd: 750, fraction: 0.2 },
      { thresholdUsd: 500, fraction: 0.1 }
    ]
  });
  assert.match(line, /brake -\$600\.00 per instrument/);
  assert.match(line, /10% at -\$500\.00/);
  assert.match(line, /20% at -\$750\.00/);
  assert.match(line, /50% at -\$1000\.00/);
  assert.match(line, /flatten -\$1250\.00 account-wide/);
});

test("legacy snapshot without cutTiers still shows the single 50% cut", () => {
  const line = formatRiskLadderLine({
    entryBrakeUsd: 300,
    partialCutUsd: 1000,
    partialCutFraction: 0.5,
    fullFlattenUsd: 1250
  });
  assert.match(line, /brake -\$300\.00 per instrument/);
  assert.match(line, /50% at -\$1000\.00/);
  assert.doesNotMatch(line, /10% at/);
});

test("status names a local pending mark without mislabeling DXtrade as D-064", async () => {
  const service = createMultiInstrumentOwnerService({
    instrumentConfigs: [{ enabled: true, instrument: "RUNE/USD", orderPrefix: "RUNE" }],
    buildOwnerService: () => ({
      async statusText() { return "RUNE/USD STATUS"; },
      async inspectForRerun() { return { ok: true, match: true, virtualNet: 0, brokerNet: 0, openLots: 0 }; }
    }),
    riskSupervisor: {
      getSnapshot: () => ({
        dayKey: "2026-10-05",
        dayPnlUsd: -12,
        exposureUsd: 300,
        marginToLimitUsd: 288,
        dailyLossLimitUsd: 300,
        entryBrakeUsd: 33,
        partialCutUsd: 100,
        partialCutFraction: 0.1,
        fullFlattenUsd: 250,
        brakedInstruments: [],
        perInstrument: [{ instrument: "RUNE/USD", unreadFailed: false, readFailed: false, markUnavailable: true, entryBlockedForMark: true, unrealisedUsd: 0, entryBrakePnlSource: "MARK_UNAVAILABLE" }],
        sessionHarvestEnabled: false,
        flattenedToday: false,
        cutsToday: 0
      })
    }
  });
  const status = await service.statusText();
  assert.match(status, /Marks pending: RUNE\/USD/);
  assert.match(status, /entries blocked only on those books/);
  assert.match(status, /Account-wide protection remains active/);
  assert.doesNotMatch(status, /D-064 broker-data outage/);
  const risk = service.riskText();
  assert.match(risk, /RISK DETAIL/);
  assert.match(risk, /RUNE\s+P&L/);
  assert.match(risk, /MARK: PENDING/);
});

test("risk lists the highest-exposure books first with concise mark labels", () => {
  const service = createMultiInstrumentOwnerService({
    instrumentConfigs: [
      { enabled: true, instrument: "SOL/USD", orderPrefix: "SOL" },
      { enabled: true, instrument: "RUNE/USD", orderPrefix: "RUNE" }
    ],
    buildOwnerService: () => ({ async inspectForRerun() { return { ok: true, match: true, virtualNet: 0, brokerNet: 0, openLots: 0 }; } }),
    riskSupervisor: {
      getSnapshot: () => ({
        dayKey: "2026-10-05",
        totalUnrealisedUsd: -35,
        entryBrakeUsd: 33,
        brakedInstruments: ["RUNE/USD"],
        perInstrument: [
          { instrument: "SOL/USD", unrealisedUsd: -1, exposureUsd: 120, entryBrakePnlSource: "BINANCE_TRADE_MARK" },
          { instrument: "RUNE/USD", unrealisedUsd: -34, exposureUsd: 920, entryBrakePnlSource: "BINANCE_REST_MARK" }
        ]
      })
    }
  });
  const risk = service.riskText();
  const rows = risk.split("\n");
  assert.ok(rows.findIndex((line) => line.startsWith("RUNE")) < rows.findIndex((line) => line.startsWith("SOL")));
  assert.match(risk, /RUNE\s+P&L.*BRAKE: LOSS.*MARK: BINANCE REST/);
  assert.match(risk, /SOL\s+P&L.*MARK: BINANCE STREAM/);
  assert.doesNotMatch(risk, /RUNE\/USD/);
});
