import pg from "pg";

const { Pool } = pg;

function toNumber(value) {
  return typeof value === "number" ? value : Number(value);
}

function normalizeState(row) {
  return {
    ...row,
    balance: toNumber(row.balance),
    equity: toNumber(row.equity),
    prev_day_close: toNumber(row.prev_day_close),
    high_water: toNumber(row.high_water),
    mll_floor: toNumber(row.mll_floor),
    daily_realized_pnl: toNumber(row.daily_realized_pnl),
    daily_unrealized_pnl: toNumber(row.daily_unrealized_pnl),
    losses_today: Number(row.losses_today)
  };
}

export function createDatabase(environment) {
  const pool = new Pool({
    connectionString: environment.databaseUrl,
    ssl: environment.databaseSsl ? { rejectUnauthorized: false } : undefined,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

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

    await pool.query(
      `INSERT INTO bot_state (
         id, balance, equity, prev_day_close, high_water, mll_floor
       ) VALUES (1, $1, $1, $1, $1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [account.startingBalance, account.startingBalance - account.maxLossOffset]
    );
  }

  async function getState() {
    const result = await pool.query("SELECT * FROM bot_state WHERE id = 1");
    if (result.rowCount !== 1) throw new Error("bot_state row is missing");
    return normalizeState(result.rows[0]);
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

  async function getDailyLedger() {
    const result = await pool.query(
      "SELECT date_utc, realized_pnl FROM daily_ledger ORDER BY date_utc"
    );
    return result.rows.map((row) => ({
      dateUtc: new Date(row.date_utc).toISOString().slice(0, 10),
      realizedPnl: toNumber(row.realized_pnl)
    }));
  }

  async function addEvent(level, kind, payload = {}) {
    await pool.query(
      "INSERT INTO events (level, kind, payload) VALUES ($1, $2, $3::jsonb)",
      [level, kind, JSON.stringify(payload)]
    );
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
    setOperatorKilled,
    setResumeChallenge,
    clearResumeChallenge,
    getDailyLedger,
    addEvent,
    ping,
    close
  };
}
