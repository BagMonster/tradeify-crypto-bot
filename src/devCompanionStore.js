import pg from "pg";

const { Pool } = pg;

function requireOwnerId(value) {
  const ownerId = Number(value);
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new Error("ownerId must be a positive safe integer");
  return ownerId;
}

function requireText(name, value, maxLength) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  const text = value.trim();
  if (text.length > maxLength) throw new Error(`${name} must be at most ${maxLength} characters`);
  return text;
}

export function createDevCompanionStore({ databaseUrl, databaseSsl = false, PoolClass = Pool }) {
  const pool = new PoolClass({
    connectionString: databaseUrl,
    ssl: databaseSsl ? { rejectUnauthorized: false } : undefined,
    max: 3,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  async function init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_dev_sessions (
        owner_id BIGINT PRIMARY KEY,
        active BOOLEAN NOT NULL DEFAULT FALSE,
        previous_response_id TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_dev_jobs (
        id BIGSERIAL PRIMARY KEY,
        owner_id BIGINT NOT NULL,
        input_text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','COMPLETED','FAILED')),
        output_text TEXT,
        response_id TEXT,
        error_code TEXT,
        delivered_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ
      )
    `);
    await pool.query("CREATE INDEX IF NOT EXISTS ai_dev_jobs_pending_idx ON ai_dev_jobs (status, id)");
    await pool.query("CREATE INDEX IF NOT EXISTS ai_dev_jobs_delivery_idx ON ai_dev_jobs (owner_id, status, delivered_at, id)");

    // Phase 1 runs exactly one companion worker. If Railway restarts it after a job was
    // claimed but before completion, make that job eligible again instead of stranding it.
    await pool.query(`
      UPDATE ai_dev_jobs
      SET status = 'PENDING', started_at = NULL
      WHERE status = 'PROCESSING' AND completed_at IS NULL
    `);
  }

  async function setSessionActive(ownerIdValue, active) {
    const ownerId = requireOwnerId(ownerIdValue);
    await pool.query(`
      INSERT INTO ai_dev_sessions (owner_id, active, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (owner_id) DO UPDATE SET active = EXCLUDED.active, updated_at = NOW()
    `, [ownerId, active === true]);
  }

  async function isSessionActive(ownerIdValue) {
    const ownerId = requireOwnerId(ownerIdValue);
    const result = await pool.query("SELECT active FROM ai_dev_sessions WHERE owner_id = $1", [ownerId]);
    return result.rowCount === 1 && result.rows[0].active === true;
  }

  async function resetSession(ownerIdValue) {
    const ownerId = requireOwnerId(ownerIdValue);
    await pool.query(`
      INSERT INTO ai_dev_sessions (owner_id, active, previous_response_id, updated_at)
      VALUES ($1, TRUE, NULL, NOW())
      ON CONFLICT (owner_id) DO UPDATE SET active = TRUE, previous_response_id = NULL, updated_at = NOW()
    `, [ownerId]);
  }

  async function enqueue(ownerIdValue, inputValue) {
    const ownerId = requireOwnerId(ownerIdValue);
    const inputText = requireText("inputText", inputValue, 12000);
    const result = await pool.query(
      "INSERT INTO ai_dev_jobs (owner_id, input_text) VALUES ($1, $2) RETURNING id",
      [ownerId, inputText]
    );
    return Number(result.rows[0].id);
  }

  async function claimNext() {
    const result = await pool.query(`
      UPDATE ai_dev_jobs
      SET status = 'PROCESSING', started_at = NOW()
      WHERE id = (
        SELECT id FROM ai_dev_jobs
        WHERE status = 'PENDING'
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, owner_id, input_text
    `);
    if (result.rowCount !== 1) return null;
    const row = result.rows[0];
    const session = await pool.query("SELECT previous_response_id FROM ai_dev_sessions WHERE owner_id = $1", [row.owner_id]);
    return {
      id: Number(row.id),
      ownerId: Number(row.owner_id),
      inputText: row.input_text,
      previousResponseId: session.rowCount === 1 ? session.rows[0].previous_response_id : null
    };
  }

  async function complete(jobId, ownerIdValue, outputValue, responseIdValue) {
    const ownerId = requireOwnerId(ownerIdValue);
    const outputText = requireText("outputText", outputValue, 50000);
    const responseId = requireText("responseId", responseIdValue, 256);
    await pool.query("BEGIN");
    try {
      const job = await pool.query(`
        UPDATE ai_dev_jobs
        SET status = 'COMPLETED', output_text = $2, response_id = $3, completed_at = NOW()
        WHERE id = $1 AND owner_id = $4 AND status = 'PROCESSING'
        RETURNING id
      `, [jobId, outputText, responseId, ownerId]);
      if (job.rowCount !== 1) throw new Error("Development companion job could not be completed");
      await pool.query(`
        INSERT INTO ai_dev_sessions (owner_id, active, previous_response_id, updated_at)
        VALUES ($1, TRUE, $2, NOW())
        ON CONFLICT (owner_id) DO UPDATE SET previous_response_id = EXCLUDED.previous_response_id, updated_at = NOW()
      `, [ownerId, responseId]);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }

  async function fail(jobId, errorCode = "OPENAI_REQUEST_FAILED") {
    await pool.query(`
      UPDATE ai_dev_jobs
      SET status = 'FAILED', error_code = $2, completed_at = NOW()
      WHERE id = $1 AND status = 'PROCESSING'
    `, [jobId, String(errorCode).slice(0, 64)]);
  }

  async function pendingDeliveries(ownerIdValue, limit = 5) {
    const ownerId = requireOwnerId(ownerIdValue);
    const result = await pool.query(`
      SELECT id, status, output_text, error_code
      FROM ai_dev_jobs
      WHERE owner_id = $1 AND status IN ('COMPLETED','FAILED') AND delivered_at IS NULL
      ORDER BY id
      LIMIT $2
    `, [ownerId, limit]);
    return result.rows.map((row) => ({
      id: Number(row.id),
      status: row.status,
      outputText: row.output_text,
      errorCode: row.error_code
    }));
  }

  async function markDelivered(jobId, ownerIdValue) {
    const ownerId = requireOwnerId(ownerIdValue);
    await pool.query(
      "UPDATE ai_dev_jobs SET delivered_at = NOW() WHERE id = $1 AND owner_id = $2 AND delivered_at IS NULL",
      [jobId, ownerId]
    );
  }

  async function status(ownerIdValue) {
    const ownerId = requireOwnerId(ownerIdValue);
    const [session, jobs] = await Promise.all([
      pool.query("SELECT active, previous_response_id IS NOT NULL AS has_context, updated_at FROM ai_dev_sessions WHERE owner_id = $1", [ownerId]),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
          COUNT(*) FILTER (WHERE status = 'PROCESSING')::int AS processing,
          COUNT(*) FILTER (WHERE status = 'COMPLETED' AND delivered_at IS NULL)::int AS ready,
          COUNT(*) FILTER (WHERE status = 'FAILED' AND delivered_at IS NULL)::int AS failed
        FROM ai_dev_jobs
        WHERE owner_id = $1
      `, [ownerId])
    ]);
    const row = jobs.rows[0];
    return Object.freeze({
      active: session.rowCount === 1 && session.rows[0].active === true,
      hasContext: session.rowCount === 1 && session.rows[0].has_context === true,
      pending: Number(row.pending ?? 0),
      processing: Number(row.processing ?? 0),
      ready: Number(row.ready ?? 0),
      failed: Number(row.failed ?? 0)
    });
  }

  async function health() {
    await pool.query("SELECT 1");
    return true;
  }

  async function close() {
    await pool.end();
  }

  return Object.freeze({
    init,
    setSessionActive,
    isSessionActive,
    resetSession,
    enqueue,
    claimNext,
    complete,
    fail,
    pendingDeliveries,
    markDelivered,
    status,
    health,
    close
  });
}
