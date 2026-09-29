import test from "node:test";
import assert from "node:assert/strict";
import { createRingGrid } from "../src/strategies/ringGrid.js";
import {
  brokerTicketsFromOpenPositions,
  runBrokerAuthoritativeRematchPass,
  ticketsMatch,
  virtualTickets
} from "../src/runtime/brokerAuthoritativeRematch.js";

const INSTRUMENT = "AAVE/USD";
const STAMP = "2026-09-29T19:00:00.000Z";

function grid() {
  return createRingGrid({
    strategyId: "broker-rematch-test",
    instrument: INSTRUMENT,
    marketSymbol: "AAVEUSDT",
    orderPrefix: "AAVE",
    geometry: { maDays: 200, bandPct: 0.01, deadZoneBands: 1, activeLevelsPerSide: 1, growth: 1, innerLevels: 0, innerPositionsPerRing: 1, outerPositionsPerRing: 1, rearmBands: 0.5 },
    sizing: { lotStep: 0.01, capUsd: 1000, roundTripCostFloorPct: 0.001 },
    tranches: { weights: [1, 1, 1, 1], denominator: 4 }
  });
}

function brokerPayload(quantity = 0.1) {
  return {
    positions: [{
      symbol: INSTRUMENT,
      positionCode: "broker-ticket-1",
      side: "SELL",
      quantity,
      avgOpenPrice: 100
    }]
  };
}

test("broker ticket parsing rejects incomplete tickets and preserves exact ticket identity", () => {
  const parsed = brokerTicketsFromOpenPositions(brokerPayload(), [INSTRUMENT]);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.byInstrument[INSTRUMENT].map(({ positionCode, side, remainingUnits, entryPrice }) => ({ positionCode, side, remainingUnits, entryPrice })), [
    { positionCode: "broker-ticket-1", side: "SELL", remainingUnits: 0.1, entryPrice: 100 }
  ]);

  const incomplete = brokerTicketsFromOpenPositions({
    positions: [{ symbol: INSTRUMENT, side: "SELL", quantity: 0.1, avgOpenPrice: 100 }]
  }, [INSTRUMENT]);
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.error, /without a positionCode/);
});

test("ticket rematch retires stale virtual lots and adopts broker-only tickets", () => {
  const instance = grid();
  let state = instance.adoptPosition(instance.createInitialState(), {
    positionCode: "stale-virtual-ticket",
    side: "SELL",
    entryPrice: 101,
    originalUnits: 1,
    remainingUnits: 1,
    openedAt: "2026-09-29T18:00:00.000Z",
    ma: 100
  });
  const tickets = brokerTicketsFromOpenPositions(brokerPayload(), [INSTRUMENT]).byInstrument[INSTRUMENT];
  state = instance.rematchBrokerTickets(state, tickets, { movingAverage: 99, observedAt: STAMP });

  assert.equal(state.adopted.length, 1);
  assert.equal(state.adopted[0].positionCode, "broker-ticket-1");
  assert.equal(state.adopted[0].remainingUnits, 0.1);
  assert.equal(instance.expectedNetUnits(state), -0.1);
  assert.equal(ticketsMatch(virtualTickets(instance, state), tickets), true);
});

test("ticket rematch preserves a ring only when its positionCode still exists at the broker", () => {
  const instance = grid();
  let state = instance.applyConfirmedEntry(instance.createInitialState(), {
    type: "ENTRY",
    stateVersion: 0,
    ringTag: "SELL1",
    lotId: "SELL1-V0",
    side: "SELL",
    quantity: 0.5
  }, {
    fillPrice: 101,
    filledAt: "2026-09-29T18:00:00.000Z",
    filledQuantity: 0.5,
    positionCode: "still-a-ring-ticket"
  });
  state = instance.rematchBrokerTickets(state, [{
    positionCode: "still-a-ring-ticket",
    side: "SELL",
    remainingUnits: 0.2,
    entryPrice: 100
  }], { observedAt: STAMP });

  const ring = state.rings.find((candidate) => candidate.tag === "SELL1");
  assert.equal(ring.lots.length, 1);
  assert.equal(ring.lots[0].remainingUnits, 0.2);
  assert.equal(ring.lots[0].entryPrice, 100);
  assert.equal(state.adopted.length, 0);
});

test("a stable broker-flat book can retire stale virtual inventory without a moving average", () => {
  const instance = grid();
  let state = instance.adoptPosition(instance.createInitialState(), {
    positionCode: "stale-virtual-ticket",
    side: "SELL",
    entryPrice: 101,
    originalUnits: 1,
    remainingUnits: 1,
    openedAt: "2026-09-29T18:00:00.000Z",
    ma: 100
  });
  state = instance.rematchBrokerTickets(state, [], { observedAt: STAMP });
  assert.equal(instance.expectedNetUnits(state), 0);
  assert.equal(state.adopted.length, 0);
});

test("automatic rematch waits ten uninterrupted minutes and verifies a second broker read", async () => {
  const instance = grid();
  let state = instance.adoptPosition(instance.createInitialState(), {
    positionCode: "stale-virtual-ticket",
    side: "SELL",
    entryPrice: 101,
    originalUnits: 1,
    remainingUnits: 1,
    openedAt: "2026-09-29T18:00:00.000Z",
    ma: 100
  });
  const records = new Map();
  let time = Date.parse(STAMP);
  let reads = 0;
  const books = {
    [INSTRUMENT]: {
      grid: instance,
      stateStore: {
        async load() { return state; },
        async save(version, next) {
          assert.equal(version, state.version);
          state = next;
        }
      },
      movingAverage: async () => 99
    }
  };
  const deps = {
    books,
    now: () => time,
    readBrokerTickets: async (instruments) => {
      reads += 1;
      return brokerTicketsFromOpenPositions(brokerPayload(), instruments);
    },
    observeStability: async ({ instrument, fingerprint, observedAt }) => {
      const previous = records.get(instrument);
      const record = previous?.fingerprint === fingerprint
        ? { ...previous, lastObservedAt: observedAt }
        : { instrument, fingerprint, firstObservedAt: observedAt, lastObservedAt: observedAt };
      records.set(instrument, record);
      return record;
    },
    clearStability: async (instrument) => records.delete(instrument)
  };

  const waiting = await runBrokerAuthoritativeRematchPass(deps);
  assert.equal(waiting.rematched.length, 0);
  assert.equal(waiting.rows[0].outcome, "WAITING");

  time += 10 * 60 * 1000;
  const applied = await runBrokerAuthoritativeRematchPass(deps);
  assert.deepEqual(applied.rematched, [INSTRUMENT]);
  assert.equal(applied.verifiedAll, true);
  assert.equal(reads, 3, "the rematch pass performs a second broker verification read");
  assert.equal(ticketsMatch(virtualTickets(instance, state), brokerTicketsFromOpenPositions(brokerPayload(), [INSTRUMENT]).byInstrument[INSTRUMENT]), true);
});
