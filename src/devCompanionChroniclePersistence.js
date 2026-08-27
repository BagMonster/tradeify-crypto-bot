function mapPublication(row) {
  return Object.freeze({
    publicationKey: row.publication_key,
    date: row.date,
    slug: row.slug,
    status: row.status,
    baseSha: row.base_sha,
    branch: row.branch_name,
    entrySha: row.entry_sha,
    timelineSha: row.timeline_sha,
    expectedHeadSha: row.expected_head_sha,
    claimOwner: row.claim_owner,
    prUrl: row.pr_url,
    prNumber: row.pr_number,
    commitSha: row.commit_sha,
    errorCode: row.error_code
  });
}

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
      entry_sha TEXT,
      timeline_sha TEXT,
      expected_head_sha TEXT,
      claim_owner TEXT,
      pr_url TEXT,
      pr_number INTEGER,
      commit_sha TEXT,
      error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("ALTER TABLE ai_chronicle_publications ADD COLUMN IF NOT EXISTS entry_sha TEXT");
  await pool.query("ALTER TABLE ai_chronicle_publications ADD COLUMN IF NOT EXISTS timeline_sha TEXT");
  await pool.query("ALTER TABLE ai_chronicle_publications ADD COLUMN IF NOT EXISTS expected_head_sha TEXT");
  await pool.query("ALTER TABLE ai_chronicle_publications ADD COLUMN IF NOT EXISTS claim_owner TEXT");
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
      return mapPublication(result.rows[0]);
    },
    async claimChroniclePublication(row) {
      const inserted = await pool.query(`
        INSERT INTO ai_chronicle_publications (
          publication_key, date, slug, status, base_sha, branch_name,
          entry_sha, timeline_sha, expected_head_sha, claim_owner, created_at, updated_at
        ) VALUES ($1,$2,$3,'executing',$4,$5,$6,$7,$8,$9,NOW(),NOW())
        ON CONFLICT (publication_key) DO NOTHING
        RETURNING *
      `, [
        row.publicationKey,
        row.date,
        row.slug,
        row.baseSha ?? null,
        row.branch ?? null,
        row.entrySha ?? null,
        row.timelineSha ?? null,
        row.expectedHeadSha ?? null,
        row.claimOwner ?? "companion"
      ]);
      if (inserted.rowCount === 1) {
        return Object.freeze({ ok: true, claimed: true, publication: mapPublication(inserted.rows[0]) });
      }

      const existingResult = await pool.query(
        "SELECT * FROM ai_chronicle_publications WHERE publication_key = $1",
        [row.publicationKey]
      );
      if (existingResult.rowCount !== 1) {
        return Object.freeze({ ok: false, error: "PUBLICATION_CLAIM_RACE" });
      }
      const existing = mapPublication(existingResult.rows[0]);
      if (existing.status === "done") {
        return Object.freeze({ ok: true, claimed: false, alreadyDone: true, publication: existing });
      }

      const sameBinding = existing.baseSha === row.baseSha
        && existing.branch === row.branch
        && existing.entrySha === row.entrySha
        && existing.timelineSha === row.timelineSha
        && (existing.expectedHeadSha == null || row.expectedHeadSha == null || existing.expectedHeadSha === row.expectedHeadSha);

      if (!sameBinding) {
        return Object.freeze({ ok: false, error: "PUBLICATION_BINDING_MISMATCH", publication: existing });
      }

      const owner = row.claimOwner ?? "companion";
      const updated = await pool.query(`
        UPDATE ai_chronicle_publications
        SET status = 'executing',
            claim_owner = $2,
            error_code = NULL,
            updated_at = NOW()
        WHERE publication_key = $1
          AND status <> 'done'
          AND base_sha IS NOT DISTINCT FROM $3
          AND branch_name IS NOT DISTINCT FROM $4
          AND entry_sha IS NOT DISTINCT FROM $5
          AND timeline_sha IS NOT DISTINCT FROM $6
          AND (status = 'failed' OR claim_owner IS NULL OR claim_owner = $2)
        RETURNING *
      `, [row.publicationKey, owner, row.baseSha, row.branch, row.entrySha, row.timelineSha]);

      if (updated.rowCount === 1) {
        return Object.freeze({
          ok: true,
          claimed: true,
          resumed: true,
          publication: mapPublication(updated.rows[0])
        });
      }
      return Object.freeze({ ok: false, error: "PUBLICATION_IN_FLIGHT", publication: existing });
    },
    async bindChroniclePublicationHead(key, expectedHeadSha) {
      const result = await pool.query(`
        UPDATE ai_chronicle_publications
        SET expected_head_sha = $2, updated_at = NOW()
        WHERE publication_key = $1 AND status = 'executing'
        RETURNING *
      `, [key, expectedHeadSha]);
      if (result.rowCount !== 1) return null;
      return mapPublication(result.rows[0]);
    },
    async beginChroniclePublication(row) {
      const claimed = await this.claimChroniclePublication(row);
      if (!claimed.ok) throw new Error(claimed.error);
      return claimed;
    },
    async completeChroniclePublication(key, result) {
      await pool.query(`
        UPDATE ai_chronicle_publications
        SET status = 'done', pr_url = $2, pr_number = $3, commit_sha = $4, error_code = NULL, updated_at = NOW()
        WHERE publication_key = $1 AND status = 'executing'
      `, [key, result.prUrl ?? null, result.prNumber ?? null, result.commitSha ?? null]);
    },
    async failChroniclePublication(key, errorCode) {
      await pool.query(`
        UPDATE ai_chronicle_publications
        SET status = 'failed', error_code = $2, claim_owner = NULL, updated_at = NOW()
        WHERE publication_key = $1 AND status <> 'done'
      `, [key, String(errorCode).slice(0, 160)]);
    }
  });
}
