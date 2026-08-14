import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase, normalizeBar } from "../src/database.js";

const ENVIRONMENT = {
  databaseUrl: "postgres://example.invalid/tradeify",
  databaseSsl: false
};

const ACCOUNT = {
  startingBalance: 50_000,
  maxLossOffset: 3_000
};

function completedBar(overrides = {}) {
  return {
    source: "binance",
    symbol: "BTCUSDT",
    timeframe: "15m",
    openTime: "2026-08-14T10:00:00.000Z",
    closeTime: "2026-08-14T10:15:00.000Z",
    open: "65000.10",
    high: "65100.20",
    low: "64900.30",
    close: "65050.40",
    volume: "123.456",
    isClosed: true,
    ...overrides
  };
}

function storedRow(bar = completedBar()) {
  return {
    source: bar.source,
    symbol: bar.symbol,
    timeframe: bar.timeframe,
    open_time: bar.openTime,
    close_time: bar.closeTime,
    open: String(bar.open),
    high: String(bar.high),
    low: String(bar.low),
    close: String(bar.close),
    volume: bar.volume === null ? null : String(bar.volume),
    is_closed: true
  };
}

function databaseWithPool(pool) {
  class PoolClass {
    constructor(config) {
      pool.config = config;
      return pool;
    }
  }
  return createDatabase(ENVIRONMENT, { PoolClass });
}

test("1 - normalizes a completed, UTC-aligned bar", () => {
  const bar = normalizeBar(completedBar());
  assert.deepEqual({
    source: bar.source,
    symbol: bar.symbol,
    timeframe: bar.timeframe,
    openTime: bar.openTime.toISOString(),
    closeTime: bar.closeTime.toISOString(),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    isClosed: bar.isClosed
  }, {
    source: "binance",
    symbol: "BTCUSDT",
    timeframe: "15m",
    openTime: "2026-08-14T10:00:00.000Z",
    closeTime: "2026-08-14T10:15:00.000Z",
    open: 65000.1,
    high: 65100.2,
    low: 64900.3,
    close: 65050.4,
    volume: 123.456,
    isClosed: true
  });
});

test("2 - rejects incomplete, misaligned, malformed, and impossible bars", () => {
  const invalidBars = [
    completedBar({ isClosed: false }),
    completedBar({ timeframe: "1h" }),
    completedBar({ openTime: "2026-08-14T10:01:00.000Z" }),
    completedBar({ closeTime: "2026-08-14T10:14:59.999Z" }),
    completedBar({ open: Number.NaN }),
    completedBar({ high: 64999 }),
    completedBar({ low: 65200 }),
    completedBar({ volume: -1 })
  ];

  for (const bar of invalidBars) assert.throws(() => normalizeBar(bar));
});

test("3 - database initialization creates the bars table automatically", async () => {
  const calls = [];
  const pool = {
    async query(text, params) {
      calls.push({ text, params });
      return { rowCount: 0, rows: [] };
    },
    async end() {}
  };
  const database = databaseWithPool(pool);

  await database.init(ACCOUNT);

  assert.equal(pool.config.connectionString, ENVIRONMENT.databaseUrl);
  assert.equal(pool.config.ssl, undefined);
  const schema = calls.map((call) => call.text).join("\n");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS bars/i);
  assert.match(schema, /PRIMARY KEY \(source, symbol, timeframe, open_time\)/i);
  assert.match(schema, /timeframe IN \('15m', '4h', '1d'\)/i);
  assert.match(schema, /is_closed = TRUE/i);
  assert.match(schema, /EXTRACT\(EPOCH FROM open_time\)/i);
  assert.equal(calls.at(-1).params[0], 50_000);
  assert.equal(calls.at(-1).params[1], 47_000);
});

test("4 - one bar is parameterized and idempotently upserted", async () => {
  const calls = [];
  const input = completedBar();
  const pool = {
    async query(text, params) {
      calls.push({ text, params });
      return { rowCount: 1, rows: [storedRow(input)] };
    },
    async end() {}
  };
  const database = databaseWithPool(pool);

  const result = await database.upsertBar(input);

  assert.match(calls[0].text, /ON CONFLICT \(source, symbol, timeframe, open_time\)/i);
  assert.deepEqual(calls[0].params.slice(0, 3), ["binance", "BTCUSDT", "15m"]);
  assert.equal(calls[0].params.length, 10);
  assert.equal(result.openTime, "2026-08-14T10:00:00.000Z");
  assert.equal(result.close, 65050.4);
  assert.equal(result.isClosed, true);
});

test("5 - a batch is validated first and committed atomically", async () => {
  const calls = [];
  let released = false;
  const inputs = [
    completedBar(),
    completedBar({
      openTime: "2026-08-14T10:15:00.000Z",
      closeTime: "2026-08-14T10:30:00.000Z",
      open: 65050.4,
      high: 65200,
      low: 65000,
      close: 65150
    })
  ];
  const client = {
    async query(text, params) {
      calls.push({ text, params });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: inputs.length, rows: inputs.map(storedRow) };
    },
    release() {
      released = true;
    }
  };
  const pool = {
    async query() {
      throw new Error("batch writes must use a transaction client");
    },
    async connect() {
      return client;
    },
    async end() {}
  };
  const database = databaseWithPool(pool);

  const stored = await database.upsertBars(inputs);

  assert.equal(stored.length, 2);
  assert.deepEqual(calls.map((call) => call.text === "BEGIN" || call.text === "COMMIT"
    ? call.text
    : "BULK UPSERT"), ["BEGIN", "BULK UPSERT", "COMMIT"]);
  assert.equal(calls[1].params.length, 20);
  assert.match(calls[1].text, /\$20/);
  assert.equal(released, true);

  await assert.rejects(
    database.upsertBars([inputs[0], { ...inputs[0] }]),
    /duplicate key/i
  );
  await assert.rejects(
    database.upsertBars(Array(5001).fill(inputs[0])),
    /at most 5000/i
  );
});

test("6 - a failed batch rolls back and releases the client", async () => {
  const calls = [];
  let released = false;
  const client = {
    async query(text) {
      calls.push(text);
      if (/INSERT INTO bars/i.test(text)) {
        throw new Error("simulated PostgreSQL failure");
      }
      return { rowCount: 0, rows: [] };
    },
    release() {
      released = true;
    }
  };
  const pool = {
    async connect() {
      return client;
    },
    async end() {}
  };
  const database = databaseWithPool(pool);
  const second = completedBar({
    openTime: "2026-08-14T10:15:00.000Z",
    closeTime: "2026-08-14T10:30:00.000Z"
  });

  await assert.rejects(
    database.upsertBars([completedBar(), second]),
    /simulated PostgreSQL failure/i
  );
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(released, true);
});

test("7 - reads return chronological bars and warm-up counts", async () => {
  const calls = [];
  const rows = [
    storedRow(completedBar()),
    storedRow(completedBar({
      openTime: "2026-08-14T10:15:00.000Z",
      closeTime: "2026-08-14T10:30:00.000Z"
    }))
  ];
  const pool = {
    async query(text, params) {
      calls.push({ text, params });
      if (/COUNT\(\*\)/i.test(text)) {
        return {
          rowCount: 3,
          rows: [
            { timeframe: "15m", bar_count: "50" },
            { timeframe: "4h", bar_count: "40" },
            { timeframe: "1d", bar_count: "25" }
          ]
        };
      }
      return { rowCount: rows.length, rows };
    },
    async end() {}
  };
  const database = databaseWithPool(pool);

  const bars = await database.getBars({
    source: "binance",
    symbol: "BTCUSDT",
    timeframe: "15m",
    limit: 50
  });
  const counts = await database.getBarCounts({ source: "binance", symbol: "BTCUSDT" });

  assert.deepEqual(calls[0].params, ["binance", "BTCUSDT", "15m", 50]);
  assert.match(calls[0].text, /ORDER BY open_time DESC[\s\S]*LIMIT \$4[\s\S]*ORDER BY open_time ASC/i);
  assert.deepEqual(bars.map((bar) => bar.openTime), [
    "2026-08-14T10:00:00.000Z",
    "2026-08-14T10:15:00.000Z"
  ]);
  assert.deepEqual(counts, { "15m": 50, "4h": 40, "1d": 25 });

  await assert.rejects(
    database.getBars({ source: "binance", symbol: "BTCUSDT", timeframe: "15m", limit: 5001 }),
    /limit/i
  );
});

test("8 - exact-range coverage is counted with aligned parameterized boundaries", async () => {
  const calls = [];
  const pool = {
    async query(text, params) {
      calls.push({ text, params });
      return {
        rowCount: 1,
        rows: [{
          bar_count: "96",
          first_open_time: "2026-08-13T00:00:00.000Z",
          last_close_time: "2026-08-14T00:00:00.000Z"
        }]
      };
    },
    async end() {}
  };
  const database = databaseWithPool(pool);

  const coverage = await database.getBarCoverage({
    source: "binance",
    symbol: "BTCUSDT",
    timeframe: "15m",
    startTime: Date.parse("2026-08-13T00:00:00.000Z"),
    endTimeExclusive: Date.parse("2026-08-14T00:00:00.000Z")
  });

  assert.deepEqual(coverage, {
    count: 96,
    firstOpenTime: "2026-08-13T00:00:00.000Z",
    lastCloseTime: "2026-08-14T00:00:00.000Z"
  });
  assert.deepEqual(calls[0].params.slice(0, 3), ["binance", "BTCUSDT", "15m"]);
  assert.equal(calls[0].params[3].toISOString(), "2026-08-13T00:00:00.000Z");
  assert.equal(calls[0].params[4].toISOString(), "2026-08-14T00:00:00.000Z");
  assert.match(calls[0].text, /open_time >= \$4[\s\S]*close_time <= \$5/i);

  await assert.rejects(database.getBarCoverage({
    source: "binance",
    symbol: "BTCUSDT",
    timeframe: "15m",
    startTime: "2026-08-13T00:01:00.000Z",
    endTimeExclusive: "2026-08-14T00:00:00.000Z"
  }), /UTC-aligned/i);
});

test("9 - indicator readiness is persisted with a parameterized fail-closed flag", async () => {
  const calls = [];
  const pool = {
    async query(text, params) {
      calls.push({ text, params });
      return { rowCount: 1, rows: [{ indicators_warm: params[0] }] };
    },
    async end() {}
  };
  const database = databaseWithPool(pool);

  assert.equal(await database.setIndicatorsWarm(false), false);
  assert.equal(await database.setIndicatorsWarm(true), true);
  assert.deepEqual(calls.map(({ params }) => params), [[false], [true]]);
  assert.equal(calls.every(({ text }) => /UPDATE bot_state/i.test(text)), true);
  assert.equal(calls.every(({ text }) => /indicators_warm = \$1/i.test(text)), true);
  await assert.rejects(database.setIndicatorsWarm("true"), /boolean/i);
});
