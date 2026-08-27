export async function initChroniclePersistence(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_chronicle_control (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      paused BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("INSERT INTO ai_chronicle_control (id, paused) VALUES (1, FALSE) ON CONFLICT (id) DO NOTHING");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_chronicle_publications (
      publication_key TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      slug TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('executing','done','failed')),
      base_sha TEXT,
      branch_name TEXT,
      pr_url TEXT,
      pr_number INTEGER,
      commit_sha TEXT,
      error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export function createChroniclePersistence(pool) {
  return Object.freeze({
    async isChroniclePaused() {
      const result = await pool.query("SELECT paused FROM ai_chronicle_control WHERE id = 1");
      return result.rowCount === 1 && result.rows[0].paused === true;
    },
    async setChroniclePaused(paused) {
      await pool.query(`
        INSERT INTO ai_chronicle_control (id, paused, updated_at)
        VALUES (1, $1, NOW())
        ON CONFLICT (id) DO UPDATE SET paused = EXCLUDED.paused, updated_at = NOW()
      `, [paused === true]);
    },
    async getChroniclePublication(key) {
      const result = await pool.query("SELECT * FROM ai_chronicle_publications WHERE publication_key = $1", [key]);
      if (result.rowCount !== 1) return null;
      const row = result.rows[0];
      return Object.freeze({
        publicationKey: row.publication_key,
        status: row.status,
        prUrl: row.pr_url,
        prNumber: row.pr_number,
        branch: row.branch_name
      });
    },
    async beginChroniclePublication(row) {
      await pool.query(`
        INSERT INTO ai_chronicle_publications (
          publication_key, date, slug, status, base_sha, branch_name, created_at, updated_at
        ) VALUES ($1,$2,$3,'executing',$4,$5,NOW(),NOW())
        ON CONFLICT (publication_key) DO UPDATE SET
          status = 'executing',
          base_sha = EXCLUDED.base_sha,
          branch_name = EXCLUDED.branch_name,
          error_code = NULL,
          updated_at = NOW()
        WHERE ai_chronicle_publications.status <> 'done'
      `, [row.publicationKey, row.date, row.slug, row.baseSha, row.branch]);
    },
    async completeChroniclePublication(key, result) {
      await pool.query(`
        UPDATE ai_chronicle_publications
        SET status = 'done', pr_url = $2, pr_number = $3, commit_sha = $4, error_code = NULL, updated_at = NOW()
        WHERE publication_key = $1
      `, [key, result.prUrl ?? null, result.prNumber ?? null, result.commitSha ?? null]);
    },
    async failChroniclePublication(key, errorCode) {
      await pool.query(`
        UPDATE ai_chronicle_publications
        SET status = 'failed', error_code = $2, updated_at = NOW()
        WHERE publication_key = $1 AND status <> 'done'
      `, [key, String(errorCode).slice(0, 160)]);
    }
  });
}
