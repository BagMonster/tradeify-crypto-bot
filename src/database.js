import pg from "pg";
import { createPostgresGridStateStore } from "./state/gridState.js";
import { createExecutionLedger } from "./state/executionLedger.js";

const { Pool } = pg;

const BAR_INTERVAL_MS = Object.freeze({
  "15m": 15 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000
});

function requiredText(name, value, maxLength = 128) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${name} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function toFiniteNumber(name, value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be finite`);
  return number;
}

function toNonNegativeInteger(name, value) {
  const number = toFiniteNumber(name, value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return number;
}

function toPositiveNumber(name, value) {
  const number = toFiniteNumber(name, value);
  if (number <= 0) throw new Error(`${name} must be greater than zero`);
  return number;
}

function toDate(name, value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} must be a valid timestamp`);
  return date;
}

export function normalizeBar(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("bar must be an object");
  }

  const source = requiredText("bar.source", input.source, 64);
  const symbol = requiredText("bar.symbol", input.symbol, 64);
  const timeframe = requiredText("bar.timeframe", input.timeframe, 8);
  const intervalMs = BAR_INTERVAL_MS[timeframe];
  if (!intervalMs) throw new Error("bar.timeframe must be 15m, 4h, or 1d");
  if (input.isClosed !== true) throw new Error("bar must be completed before storage");

  const openTime = toDate("bar.openTime", input.openTime);
  const closeTime = toDate("bar.closeTime", input.closeTime);
  if (openTime.getTime() % intervalMs !== 0) {
    throw new Error(`bar.openTime must be UTC-aligned to ${timeframe}`);
  }
  if (closeTime.getTime() - openTime.getTime() !== intervalMs) {
    throw new Error(`bar.closeTime must equal one ${timeframe} interval after bar.openTime`);
  }

  const open = toPositiveNumber("bar.open", input.open);
  const high = toPositiveNumber("bar.high", input.high);
  const low = toPositiveNumber("bar.low", input.low);
  const close = toPositiveNumber("bar.close", input.close);
  if (high < Math.max(open, low, close)) {
    throw new Error("bar.high must be at least the open, low, and close");
  }
  if (low > Math.min(open, high, close)) {
    throw new Error("bar.low must be no greater than the open, high, and close");
  }

  const volume = input.volume === null || input.volume === undefined
    ? null
    : toFiniteNumber("bar.volume", input.volume);
  if (volume !== null && volume < 0) throw new Error("bar.volume must be non-negative");

  return Object.freeze({
    source,
    symbol,
    timeframe,
    openTime,
    closeTime,
    open,
    high,
    low,
    close,
    volume,
    isClosed: true
  });
}

function normalizeStoredBar(row) {
  const bar = normalizeBar({
    source: row.source,
    symbol: row.symbol,
    timeframe: row.timeframe,
    openTime: row.open_time,
    closeTime: row.close_time,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    isClosed: row.is_closed
  });
  return Object.freeze({
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
    isClosed: true
  });
}

function normalizeState(row) {
  return {
    ...row,
    balance: toFiniteNumber("bot_state.balance", row.balance),
    equity: toFiniteNumber("bot_state.equity", row.equity),
    prev_day_close: toFiniteNumber("bot_state.prev_day_close", row.prev_day_close),
    high_water: toFiniteNumber("bot_state.high_water", row.high_water),
    mll_floor: toFiniteNumber("bot_state.mll_floor", row.mll_floor),
    daily_realized_pnl: toFiniteNumber("bot_state.daily_realized_pnl", row.daily_realized_pnl),
    daily_unrealized_pnl: toFiniteNumber(
      "bot_state.daily_unrealized_pnl",
      row.daily_unrealized_pnl
    ),
    losses_today: toNonNegativeInteger("bot_state.losses_today", row.losses_today)
  };
}

export function createDatabase(environment, { PoolClass = Pool } = {}) {
  const pool = new PoolClass({
    connectionString: environment.databaseUrl,
    ssl: environment.databaseSsl ? { rejectUnauthorized: false } : undefined,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
  const query = (text, params = []) => pool.query(text, params);
  const gridState = createPostgresGridStateStore({ query });
  const executionLedger = createExecutionLedger({ query });

  async function init(account) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_state (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        balance NUMERIC(14,2) NOT NULL,
        equity NUMERIC(14,2) NOT NULL,
        prev_day_close NUMERIC(14,2) NOT NULL,
        high_water NUMERIC(14,2) NOT NULL,
        mll_floor NUMERIC(14,2) NOT NULL,
        payout_taken BOOLEAN NOT NULL DEFAULT FALSE,
        daily_realized_pnl NUMERIC(14,2) NOT NULL DEFAULT 0,
        daily_unrealized_pnl NUMERIC(14,2) NOT NULL DEFAULT 0,
        losses_today INTEGER NOT NULL DEFAULT 0,
        has_open_position BOOLEAN NOT NULL DEFAULT FALSE,
        indicators_warm BOOLEAN NOT NULL DEFAULT FALSE,
        feed_stale BOOLEAN NOT NULL DEFAULT TRUE,
        regime_allowed BOOLEAN NOT NULL DEFAULT FALSE,
        news_blackout BOOLEAN NOT NULL DEFAULT FALSE,
        operator_killed BOOLEAN NOT NULL DEFAULT FALSE,
        safety_halt BOOLEAN NOT NULL DEFAULT FALSE,
        halt_reason TEXT,
        resume_code_hash TEXT,
        resume_code_salt TEXT,
        resume_code_expires_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS daily_ledger (
        date_utc DATE PRIMARY KEY,
        realized_pnl NUMERIC(14,2) NOT NULL DEFAULT 0,
        trade_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        level TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bars (
        source TEXT NOT NULL CHECK (LENGTH(BTRIM(source)) BETWEEN 1 AND 64),
        symbol TEXT NOT NULL CHECK (LENGTH(BTRIM(symbol)) BETWEEN 1 AND 64),
        timeframe TEXT NOT NULL CHECK (timeframe IN ('15m', '4h', '1d')),
        open_time TIMESTAMPTZ NOT NULL,
        close_time TIMESTAMPTZ NOT NULL,
        open NUMERIC(30,12) NOT NULL CHECK (open > 0),
        high NUMERIC(30,12) NOT NULL CHECK (high > 0),
        low NUMERIC(30,12) NOT NULL CHECK (low > 0),
        close NUMERIC(30,12) NOT NULL CHECK (close > 0),
        volume NUMERIC(38,12) CHECK (volume IS NULL OR volume >= 0),
        is_closed BOOLEAN NOT NULL DEFAULT TRUE CHECK (is_closed = TRUE),
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (source, symbol, timeframe, open_time),
        CHECK (high >= open AND high >= low AND high >= close),
        CHECK (low <= open AND low <= high AND low <= close),
        CHECK (
          (timeframe = '15m'
            AND MOD(EXTRACT(EPOCH FROM open_time), 900) = 0
            AND close_time = open_time + INTERVAL '15 minutes')
          OR
          (timeframe = '4h'
            AND MOD(EXTRACT(EPOCH FROM open_time), 14400) = 0
            AND close_time = open_time + INTERVAL '4 hours')
          OR
          (timeframe = '1d'
            AND MOD(EXTRACT(EPOCH FROM open_time), 86400) = 0
            AND close_time = open_time + INTERVAL '24 hours')
        )
      )
    `);

    await pool.query(
      `INSERT INTO bot_state (
         id, balance, equity, prev_day_close, high_water, mll_floor
       ) VALUES (1, $1, $1, $1, $1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [account.startingBalance, account.startingBalance - account.maxLossOffset]
    );

    await gridState.init();
    await executionLedger.init();
  }

  async function getState() {
    const result = await pool.query("SELECT * FROM bot_state WHERE id = 1");
    if (result.rowCount !== 1) throw new Error("bot_state row is missing");
    return normalizeState(result.rows[0]);
  }

  async function getPersistedPeakClosedBalance() {
    return (await getState()).high_water;
  }

  async function syncAccountSnapshot(snapshot, account) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new Error("account snapshot must be an object");
    }
    const balance = toFiniteNumber("account snapshot balance", snapshot.balance);
    const equity = toFiniteNumber("account snapshot equity", snapshot.equity);
    const previousDayClosingBalance = toFiniteNumber(
      "account snapshot previousDayClosingBalance",
      snapshot.previousDayClosingBalance
    );
    const peakClosedBalance = Math.max(
      account.startingBalance,
      toFiniteNumber("account snapshot peakClosedBalance", snapshot.peakClosedBalance)
    );
    const dayClosedPl = toFiniteNumber("account snapshot dayClosedPl", snapshot.dayClosedPl);
    const openPl = toFiniteNumber("account snapshot openPl", snapshot.openPl);
    const openPositionsCount = toNonNegativeInteger(
      "account snapshot openPositionsCount",
      snapshot.openPositionsCount
    );
    const invariantError = snapshot.invariantError == null
      ? null
      : requiredText("account snapshot invariantError", snapshot.invariantError, 300);

    const current = await getState();
    const highWater = Math.max(current.high_water, peakClosedBalance, balance);
    const mllFloor = current.payout_taken
      ? account.startingBalance
      : Math.min(account.startingBalance, highWater - account.maxLossOffset);

    const result = await pool.query(
      `UPDATE bot_state
          SET balance = $1,
              equity = $2,
              prev_day_close = $3,
              high_water = $4,
              mll_floor = $5,
              daily_realized_pnl = $6,
              daily_unrealized_pnl = $7,
              has_open_position = $8,
              safety_halt = CASE WHEN $9::text IS NULL THEN safety_halt ELSE TRUE END,
              halt_reason = CASE
                WHEN $9::text IS NULL THEN halt_reason
                WHEN safety_halt AND halt_reason IS NOT NULL THEN halt_reason
                ELSE $9::text
              END,
              updated_at = NOW()
        WHERE id = 1
        RETURNING *`,
      [
        balance,
        equity,
        previousDayClosingBalance,
        highWater,
        mllFloor,
        dayClosedPl,
        openPl,
        openPositionsCount > 0,
        invariantError
      ]
    );
    if (result.rowCount !== 1) throw new Error("bot_state row is missing");
    return normalizeState(result.rows[0]);
  }

  async function setFeedStale(stale) {
    if (typeof stale !== "boolean") throw new Error("feed stale state must be boolean");
    const result = await pool.query(
      `UPDATE bot_state SET feed_stale = $1, updated_at = NOW() WHERE id = 1 RETURNING feed_stale`,
      [stale]
    );
    if (result.rowCount !== 1) throw new Error("bot_state row is missing");
    return result.rows[0].feed_stale === true;
  }

  async function setSafetyHalt(reason) {
    const normalizedReason = requiredText("safety halt reason", reason, 300);
    const result = await pool.query(
      `UPDATE bot_state
          SET safety_halt = TRUE, halt_reason = $1, updated_at = NOW()
        WHERE id = 1
        RETURNING safety_halt, halt_reason`,
      [normalizedReason]
    );
    if (result.rowCount !== 1) throw new Error("bot_state row is missing");
    return Object.freeze({ safetyHalt: result.rows[0].safety_halt === true, reason: result.rows[0].halt_reason });
  }

  async function clearSafetyHalt() {
    const result = await pool.query(
      `UPDATE bot_state
          SET safety_halt = FALSE, halt_reason = NULL, updated_at = NOW()
        WHERE id = 1
        RETURNING safety_halt`,
      []
    );
    if (result.rowCount !== 1) throw new Error("bot_state row is missing");
    return result.rows[0].safety_halt === false;
  }

  async function setOperatorKilled(killed) {
    await pool.query(
      `UPDATE bot_state
       SET operator_killed = $1,
           updated_at = NOW()
       WHERE id = 1`,
      [killed]
    );
  }

  async function setResumeChallenge(hash, salt, expiresAt) {
    await pool.query(
      `UPDATE bot_state
       SET resume_code_hash = $1,
           resume_code_salt = $2,
           resume_code_expires_at = $3,
           updated_at = NOW()
       WHERE id = 1`,
      [hash, salt, expiresAt]
    );
  }

  async function clearResumeChallenge() {
    await pool.query(
      `UPDATE bot_state
       SET resume_code_hash = NULL,
           resume_code_salt = NULL,
           resume_code_expires_at = NULL,
           updated_at = NOW()
       WHERE id = 1`
    );
  }

  async function setIndicatorsWarm(warm) {
    if (typeof warm !== "boolean") throw new Error("indicators warm state must be boolean");
    const result = await pool.query(
      `UPDATE bot_state
       SET indicators_warm = $1,
           updated_at = NOW()
       WHERE id = 1
       RETURNING indicators_warm`,
      [warm]
    );
    if (result.rowCount !== 1) throw new Error("bot_state row is missing");
    return result.rows[0].indicators_warm === true;
  }

  async function getDailyLedger() {
    const result = await pool.query(
      "SELECT date_utc, realized_pnl FROM daily_ledger ORDER BY date_utc"
    );
    return result.rows.map((row) => ({
      dateUtc: new Date(row.date_utc).toISOString().slice(0, 10),
      realizedPnl: toFiniteNumber("daily_ledger.realized_pnl", row.realized_pnl)
    }));
  }

  async function addEvent(level, kind, payload = {}) {
    await pool.query(
      "INSERT INTO events (level, kind, payload) VALUES ($1, $2, $3::jsonb)",
      [level, kind, JSON.stringify(payload)]
    );
  }

  async function writeBar(queryable, bar) {
    const result = await queryable.query(
      `INSERT INTO bars (
         source, symbol, timeframe, open_time, close_time,
         open, high, low, close, volume, is_closed
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
       ON CONFLICT (source, symbol, timeframe, open_time)
       DO UPDATE SET
         close_time = EXCLUDED.close_time,
         open = EXCLUDED.open,
         high = EXCLUDED.high,
         low = EXCLUDED.low,
         close = EXCLUDED.close,
         volume = EXCLUDED.volume,
         is_closed = TRUE,
         updated_at = NOW()
       RETURNING source, symbol, timeframe, open_time, close_time,
                 open, high, low, close, volume, is_closed`,
      [
        bar.source,
        bar.symbol,
        bar.timeframe,
        bar.openTime,
        bar.closeTime,
        bar.open,
        bar.high,
        bar.low,
        bar.close,
        bar.volume
      ]
    );
    if (result.rowCount !== 1) throw new Error("bar upsert did not return one row");
    return normalizeStoredBar(result.rows[0]);
  }

  async function upsertBar(input) {
    return writeBar(pool, normalizeBar(input));
  }

  async function upsertBars(inputs) {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new Error("bars must be a non-empty array");
    }
    if (inputs.length > 5000) throw new Error("bars batch may contain at most 5000 rows");

    const bars = inputs.map(normalizeBar);
    const keys = new Set();
    for (const bar of bars) {
      const key = `${bar.source}\u0000${bar.symbol}\u0000${bar.timeframe}\u0000${bar.openTime.toISOString()}`;
      if (keys.has(key)) throw new Error("bars batch contains a duplicate key");
      keys.add(key);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const parameters = [];
      const rowsSql = bars.map((bar, rowIndex) => {
        const offset = rowIndex * 10;
        parameters.push(
          bar.source,
          bar.symbol,
          bar.timeframe,
          bar.openTime,
          bar.closeTime,
          bar.open,
          bar.high,
          bar.low,
          bar.close,
          bar.volume
        );
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, ` +
          `$${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, ` +
          `$${offset + 9}, $${offset + 10}, TRUE)`;
      });
      const result = await client.query(
        `INSERT INTO bars (
           source, symbol, timeframe, open_time, close_time,
           open, high, low, close, volume, is_closed
         ) VALUES ${rowsSql.join(", ")}
         ON CONFLICT (source, symbol, timeframe, open_time)
         DO UPDATE SET
           close_time = EXCLUDED.close_time,
           open = EXCLUDED.open,
           high = EXCLUDED.high,
           low = EXCLUDED.low,
           close = EXCLUDED.close,
           volume = EXCLUDED.volume,
           is_closed = TRUE,
           updated_at = NOW()
         RETURNING source, symbol, timeframe, open_time, close_time,
                   open, high, low, close, volume, is_closed`,
        parameters
      );
      if (result.rowCount !== bars.length) {
        throw new Error("bars batch upsert did not return every row");
      }
      await client.query("COMMIT");
      return result.rows.map(normalizeStoredBar);
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original storage error if rollback also fails.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function getBars({ source, symbol, timeframe, limit = 500 }) {
    const normalizedSource = requiredText("source", source, 64);
    const normalizedSymbol = requiredText("symbol", symbol, 64);
    const normalizedTimeframe = requiredText("timeframe", timeframe, 8);
    if (!BAR_INTERVAL_MS[normalizedTimeframe]) {
      throw new Error("timeframe must be 15m, 4h, or 1d");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
      throw new Error("limit must be an integer from 1 to 5000");
    }

    const result = await pool.query(
      `SELECT source, symbol, timeframe, open_time, close_time,
              open, high, low, close, volume, is_closed
       FROM (
         SELECT source, symbol, timeframe, open_time, close_time,
                open, high, low, close, volume, is_closed
         FROM bars
         WHERE source = $1 AND symbol = $2 AND timeframe = $3 AND is_closed = TRUE
         ORDER BY open_time DESC
         LIMIT $4
       ) AS recent_bars
       ORDER BY open_time ASC`,
      [normalizedSource, normalizedSymbol, normalizedTimeframe, limit]
    );
    return result.rows.map(normalizeStoredBar);
  }

  async function getBarCounts({ source, symbol }) {
    const normalizedSource = requiredText("source", source, 64);
    const normalizedSymbol = requiredText("symbol", symbol, 64);
    const result = await pool.query(
      `SELECT timeframe, COUNT(*)::BIGINT AS bar_count
       FROM bars
       WHERE source = $1 AND symbol = $2 AND is_closed = TRUE
       GROUP BY timeframe`,
      [normalizedSource, normalizedSymbol]
    );

    const counts = { "15m": 0, "4h": 0, "1d": 0 };
    for (const row of result.rows) {
      if (!BAR_INTERVAL_MS[row.timeframe]) throw new Error("bars contains an invalid timeframe");
      counts[row.timeframe] = toNonNegativeInteger("bars.bar_count", row.bar_count);
    }
    return Object.freeze(counts);
  }

  async function getBarCoverage({
    source,
    symbol,
    timeframe,
    startTime,
    endTimeExclusive
  }) {
    const normalizedSource = requiredText("source", source, 64);
    const normalizedSymbol = requiredText("symbol", symbol, 64);
    const normalizedTimeframe = requiredText("timeframe", timeframe, 8);
    const intervalMs = BAR_INTERVAL_MS[normalizedTimeframe];
    if (!intervalMs) throw new Error("timeframe must be 15m, 4h, or 1d");

    const normalizedStart = toDate("startTime", startTime);
    const normalizedEnd = toDate("endTimeExclusive", endTimeExclusive);
    if (normalizedStart.getTime() % intervalMs !== 0 ||
        normalizedEnd.getTime() % intervalMs !== 0) {
      throw new Error("coverage boundaries must be UTC-aligned to the timeframe");
    }
    if (normalizedStart.getTime() >= normalizedEnd.getTime()) {
      throw new Error("startTime must be before endTimeExclusive");
    }

    const result = await pool.query(
      `SELECT COUNT(*)::BIGINT AS bar_count,
              MIN(open_time) AS first_open_time,
              MAX(close_time) AS last_close_time
       FROM bars
       WHERE source = $1
         AND symbol = $2
         AND timeframe = $3
         AND is_closed = TRUE
         AND open_time >= $4
         AND close_time <= $5`,
      [normalizedSource, normalizedSymbol, normalizedTimeframe, normalizedStart, normalizedEnd]
    );
    if (result.rowCount !== 1) throw new Error("bar coverage query did not return one row");
    const row = result.rows[0];
    const count = toNonNegativeInteger("bars.bar_count", row.bar_count);
    return Object.freeze({
      count,
      firstOpenTime: count === 0 ? null : toDate("bars.first_open_time", row.first_open_time).toISOString(),
      lastCloseTime: count === 0 ? null : toDate("bars.last_close_time", row.last_close_time).toISOString()
    });
  }

  async function ping() {
    const result = await pool.query("SELECT NOW() AS now");
    return result.rows[0].now;
  }

  async function close() {
    await pool.end();
  }

  return {
    init,
    getState,
    getPersistedPeakClosedBalance,
    syncAccountSnapshot,
    setFeedStale,
    setSafetyHalt,
    clearSafetyHalt,
    setOperatorKilled,
    setResumeChallenge,
    clearResumeChallenge,
    setIndicatorsWarm,
    getDailyLedger,
    addEvent,
    upsertBar,
    upsertBars,
    getBars,
    getBarCounts,
    getBarCoverage,
    gridState,
    executionLedger,
    ping,
    close
  };
}
