-- Migration 0025: Character B-roll Studio (Scene Pack Repository + Studio projects)
-- NOT YET APPLIED to any database. Apply to production only with explicit approval.
--
-- Additive only: new tables, functions and triggers whose names all start with studio_. No existing table, column, row,
-- policy or function is changed, so applying it cannot affect anything that exists today.
--
-- ORDER OF DEPLOYMENT: apply this migration FIRST, then deploy the application code. The Studio code (pages, API routes and the
-- two Studio worker loops) reads and writes these tables; if it runs before they exist, the loops log an error every few seconds
-- and every Studio request fails. (The rest of the application does not touch these tables and is unaffected either way.)
--
-- Invariants enforced here (so no code path can break them):
--   * a Scene Pack asset's file, hash, type, size and pack never change after it is created (immutable source image);
--   * a pack never lists the same image (SHA-256) twice among its active assets;
--   * a selection can only name an asset of a pack the project has approved, and the pack id on it is always the asset's own;
--   * an approval cannot be revoked while any of its assets are still selected (ON DELETE RESTRICT);
--   * at most one active generation job per (batch, asset); a retry is a new job row, so history is never overwritten;
--   * a job's provider_job_id, once set, can never be changed or cleared (a job with one is never resubmitted);
--   * assets, jobs, outputs and batches are never deleted (archive instead);
--   * AI metadata and manual edits live in separate columns, and the effective value is manual over AI per field.
-- RLS is on for every table with no policy: only the server (service connection) can read or write them.

-- ── Scene packs ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS studio_packs (
  id            SERIAL PRIMARY KEY,
  name          TEXT    NOT NULL,
  description   TEXT,
  profile       JSONB,                                  -- AI-derived pack summary used for recommendations (see profile_stale)
  profile_stale BOOLEAN NOT NULL DEFAULT TRUE,          -- true when assets changed since the profile was made
  archived_at   BIGINT,
  created_by    UUID    NOT NULL,
  created_at    BIGINT  NOT NULL,
  updated_at    BIGINT  NOT NULL
);

-- ── Source images ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS studio_assets (
  id                SERIAL PRIMARY KEY,
  pack_id           INTEGER NOT NULL REFERENCES studio_packs(id),
  storage_key       TEXT    NOT NULL UNIQUE,            -- R2 key of the original (bucket 'uploads'); never changes
  thumb_key         TEXT,                               -- R2 key of the thumbnail, if one was made
  original_filename TEXT,
  mime              TEXT    NOT NULL,
  size_bytes        BIGINT  NOT NULL,
  width             INTEGER,
  height            INTEGER,
  sha256            TEXT    NOT NULL,
  ingest_group      TEXT,                               -- opaque id grouping one bulk upload (no table needed)
  analysis_status   TEXT    NOT NULL DEFAULT 'pending', -- pending | processing | completed | failed | skipped
  analysis_error    TEXT,
  analysis_attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at        BIGINT,                             -- lease for the analysis worker
  archived_at       BIGINT,
  archived_by       UUID,
  created_by        UUID    NOT NULL,
  created_at        BIGINT  NOT NULL,
  updated_at        BIGINT  NOT NULL,
  CONSTRAINT studio_assets_analysis_status_check CHECK (analysis_status IN ('pending', 'processing', 'completed', 'failed', 'skipped')),
  CONSTRAINT studio_assets_id_pack_unique UNIQUE (id, pack_id)
);

CREATE INDEX IF NOT EXISTS idx_studio_assets_pack ON studio_assets (pack_id, id);
CREATE INDEX IF NOT EXISTS idx_studio_assets_analysis ON studio_assets (analysis_status, claimed_at);
-- The same image is never an active asset of one pack twice. A different pack may hold it, and an archived copy does not count.
CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_assets_pack_sha_active ON studio_assets (pack_id, sha256) WHERE archived_at IS NULL;

-- ── Image metadata: AI and manual kept apart ─────────────────────────────────
-- ai      what the model said (written only by the analysis worker, replaced by re-analysis)
-- manual  only the fields a person edited: a key present with a value overrides the AI; a key present with null means
--         "cleared on purpose"; a key that is absent means "use the AI value". Re-analysis never touches this column.

CREATE TABLE IF NOT EXISTS studio_asset_metadata (
  asset_id          INTEGER PRIMARY KEY REFERENCES studio_assets(id),
  ai                JSONB,
  manual            JSONB   NOT NULL DEFAULT '{}'::jsonb,
  ai_model          TEXT,
  ai_version        INTEGER,
  ai_analyzed_at    BIGINT,
  manual_updated_by UUID,
  manual_updated_at BIGINT,
  created_at        BIGINT  NOT NULL,
  updated_at        BIGINT  NOT NULL
);

-- The value a field has: the manual one if the key is present in manual (even a deliberate null), else the AI one.
CREATE OR REPLACE FUNCTION studio_effective(ai JSONB, manual JSONB, field TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN jsonb_exists(manual, field) THEN manual ->> field ELSE ai ->> field END
$$;

-- Search over the effective values (used for search and recommendations only, never to hide an image).
ALTER TABLE studio_asset_metadata ADD COLUMN IF NOT EXISTS search_tsv TSVECTOR GENERATED ALWAYS AS (
  to_tsvector('english',
    coalesce(studio_effective(ai, manual, 'description'), '') || ' ' ||
    coalesce(studio_effective(ai, manual, 'environment'), '') || ' ' ||
    coalesce(studio_effective(ai, manual, 'activity'), '') || ' ' ||
    coalesce(studio_effective(ai, manual, 'objects_props'), '') || ' ' ||
    coalesce(studio_effective(ai, manual, 'camera_angle'), '') || ' ' ||
    coalesce(studio_effective(ai, manual, 'framing'), '') || ' ' ||
    coalesce(studio_effective(ai, manual, 'character_position'), '') || ' ' ||
    coalesce(studio_effective(ai, manual, 'lighting'), '') || ' ' ||
    coalesce(studio_effective(ai, manual, 'composition'), '') || ' ' ||
    coalesce(studio_effective(ai, manual, 'tags'), '')
  )
) STORED;

CREATE INDEX IF NOT EXISTS idx_studio_asset_metadata_search ON studio_asset_metadata USING GIN (search_tsv);

-- ── Studio projects ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS studio_projects (
  id                         SERIAL PRIMARY KEY,
  name                       TEXT    NOT NULL,
  character_key              TEXT,                      -- R2 key of the one base character image (V1: one per project)
  character_mime             TEXT,
  character_media_ref        TEXT,                      -- provider-side reference cache (unused until a real provider is wired)
  script                     TEXT    NOT NULL DEFAULT '',
  script_hash                TEXT,
  analysis_status            TEXT    NOT NULL DEFAULT 'idle',   -- idle | processing | completed | failed
  analysis_error             TEXT,
  analysis_at                BIGINT,
  recommendations            JSONB,                     -- [{packId, score, reasons[], moments[]}] for script_hash below
  recommendations_script_hash TEXT,
  created_by                 UUID    NOT NULL,
  archived_at                BIGINT,
  created_at                 BIGINT  NOT NULL,
  updated_at                 BIGINT  NOT NULL,
  CONSTRAINT studio_projects_analysis_status_check CHECK (analysis_status IN ('idle', 'processing', 'completed', 'failed'))
);

-- A pack the project has approved. Every non-archived image of an approved pack is visible; nothing else gates it.
CREATE TABLE IF NOT EXISTS studio_project_packs (
  project_id  INTEGER NOT NULL REFERENCES studio_projects(id),
  pack_id     INTEGER NOT NULL REFERENCES studio_packs(id),
  source      TEXT    NOT NULL,                         -- recommended | manual
  approved_by UUID    NOT NULL,
  approved_at BIGINT  NOT NULL,
  PRIMARY KEY (project_id, pack_id),
  CONSTRAINT studio_project_packs_source_check CHECK (source IN ('recommended', 'manual'))
);

-- The one shared selection of a project, across all its approved packs. The original pack id and asset id are kept.
CREATE TABLE IF NOT EXISTS studio_selections (
  project_id INTEGER NOT NULL REFERENCES studio_projects(id),
  asset_id   INTEGER NOT NULL,
  pack_id    INTEGER NOT NULL,
  added_by   UUID    NOT NULL,
  added_at   BIGINT  NOT NULL,
  PRIMARY KEY (project_id, asset_id),
  -- RESTRICT: an approval cannot be revoked while any of its assets is still selected.
  CONSTRAINT studio_selections_approved_pack_fk FOREIGN KEY (project_id, pack_id) REFERENCES studio_project_packs (project_id, pack_id) ON DELETE RESTRICT,
  -- The pack id recorded must be the asset's own pack.
  CONSTRAINT studio_selections_asset_pack_fk FOREIGN KEY (asset_id, pack_id) REFERENCES studio_assets (id, pack_id)
);

CREATE INDEX IF NOT EXISTS idx_studio_selections_project ON studio_selections (project_id);

-- ── Batches, jobs, outputs ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS studio_batches (
  id              SERIAL PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES studio_projects(id),
  created_by      UUID    NOT NULL,
  provider        TEXT    NOT NULL,
  provider_config JSONB,                                -- non-secret settings only
  character_key   TEXT    NOT NULL,                     -- the character image used for this batch (snapshot)
  total_jobs      INTEGER NOT NULL,
  created_at      BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_studio_batches_project ON studio_batches (project_id);

-- One row per image per attempt. A retry is a NEW row (retry_of_job_id), so history is never overwritten.
CREATE TABLE IF NOT EXISTS studio_jobs (
  id               SERIAL PRIMARY KEY,
  batch_id         INTEGER NOT NULL REFERENCES studio_batches(id),
  project_id       INTEGER NOT NULL REFERENCES studio_projects(id),
  asset_id         INTEGER NOT NULL,
  pack_id          INTEGER NOT NULL,
  source_key       TEXT    NOT NULL,                    -- the source image's key at submission (snapshot)
  character_key    TEXT    NOT NULL,                    -- the character image's key at submission (snapshot)
  provider         TEXT    NOT NULL,
  provider_job_id  TEXT,
  status           TEXT    NOT NULL DEFAULT 'queued',   -- queued | submitting | processing | succeeded | failed | canceled
  attempt          INTEGER NOT NULL DEFAULT 1,
  retry_of_job_id  INTEGER,                             -- the earlier job this one retries (same batch and image, see studio_jobs_retry_fk)
  request          JSONB,                               -- provider-agnostic, non-secret
  error_code       TEXT,
  error_message    TEXT,
  error_retryable  BOOLEAN,
  claimed_at       BIGINT,
  next_poll_at     BIGINT,
  poll_count       INTEGER NOT NULL DEFAULT 0,
  created_by       UUID    NOT NULL,
  created_at       BIGINT  NOT NULL,
  started_at       BIGINT,
  finished_at      BIGINT,
  updated_at       BIGINT  NOT NULL,
  CONSTRAINT studio_jobs_status_check CHECK (status IN ('queued', 'submitting', 'processing', 'succeeded', 'failed', 'canceled')),
  CONSTRAINT studio_jobs_asset_pack_fk FOREIGN KEY (asset_id, pack_id) REFERENCES studio_assets (id, pack_id),
  CONSTRAINT studio_jobs_attempt_unique UNIQUE (batch_id, asset_id, attempt),
  CONSTRAINT studio_jobs_identity_unique UNIQUE (id, batch_id, asset_id),
  -- A retry can only point at an earlier job of the SAME batch and the SAME image (a null retry_of_job_id is not checked).
  CONSTRAINT studio_jobs_retry_fk FOREIGN KEY (retry_of_job_id, batch_id, asset_id) REFERENCES studio_jobs (id, batch_id, asset_id)
);

-- At most one active job per image per batch.
CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_jobs_one_active ON studio_jobs (batch_id, asset_id) WHERE status IN ('queued', 'submitting', 'processing');
CREATE INDEX IF NOT EXISTS idx_studio_jobs_work ON studio_jobs (status, next_poll_at);
CREATE INDEX IF NOT EXISTS idx_studio_jobs_project ON studio_jobs (project_id);

CREATE TABLE IF NOT EXISTS studio_outputs (
  id            SERIAL PRIMARY KEY,
  job_id        INTEGER NOT NULL REFERENCES studio_jobs(id),
  project_id    INTEGER NOT NULL REFERENCES studio_projects(id),
  asset_id      INTEGER NOT NULL REFERENCES studio_assets(id),
  storage_key   TEXT    NOT NULL UNIQUE,                -- R2 key; never changes
  thumb_key     TEXT,
  mime          TEXT    NOT NULL,
  size_bytes    BIGINT  NOT NULL,
  width         INTEGER,
  height        INTEGER,
  sha256        TEXT    NOT NULL,
  review_status TEXT    NOT NULL DEFAULT 'pending',     -- pending | saved | rejected
  reviewed_by   UUID,
  reviewed_at   BIGINT,
  created_at    BIGINT  NOT NULL,
  CONSTRAINT studio_outputs_review_status_check CHECK (review_status IN ('pending', 'saved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_studio_outputs_project ON studio_outputs (project_id);
CREATE INDEX IF NOT EXISTS idx_studio_outputs_job ON studio_outputs (job_id);

-- ── Guards: immutability and no deletion of history ──────────────────────────

CREATE OR REPLACE FUNCTION studio_assets_immutable() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.storage_key IS DISTINCT FROM OLD.storage_key
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.pack_id IS DISTINCT FROM OLD.pack_id
     OR NEW.mime IS DISTINCT FROM OLD.mime
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes THEN
    RAISE EXCEPTION 'A Scene Pack source image is immutable: its file, hash, type, size and pack cannot change';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS studio_assets_immutable_trg ON studio_assets;
CREATE TRIGGER studio_assets_immutable_trg BEFORE UPDATE ON studio_assets FOR EACH ROW EXECUTE FUNCTION studio_assets_immutable();

CREATE OR REPLACE FUNCTION studio_jobs_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
     OR NEW.pack_id IS DISTINCT FROM OLD.pack_id
     OR NEW.source_key IS DISTINCT FROM OLD.source_key
     OR NEW.character_key IS DISTINCT FROM OLD.character_key
     OR NEW.attempt IS DISTINCT FROM OLD.attempt THEN
    RAISE EXCEPTION 'A generation job''s inputs are a snapshot and cannot change; retry creates a new job';
  END IF;
  IF OLD.provider_job_id IS NOT NULL AND NEW.provider_job_id IS DISTINCT FROM OLD.provider_job_id THEN
    RAISE EXCEPTION 'A job that has a provider job id keeps it (it must never be submitted again)';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS studio_jobs_guard_trg ON studio_jobs;
CREATE TRIGGER studio_jobs_guard_trg BEFORE UPDATE ON studio_jobs FOR EACH ROW EXECUTE FUNCTION studio_jobs_guard();

CREATE OR REPLACE FUNCTION studio_outputs_immutable() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.storage_key IS DISTINCT FROM OLD.storage_key OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.job_id IS DISTINCT FROM OLD.job_id THEN
    RAISE EXCEPTION 'A generated output''s file and job cannot change';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS studio_outputs_immutable_trg ON studio_outputs;
CREATE TRIGGER studio_outputs_immutable_trg BEFORE UPDATE ON studio_outputs FOR EACH ROW EXECUTE FUNCTION studio_outputs_immutable();

-- History is archived, never deleted.
CREATE OR REPLACE FUNCTION studio_forbid_delete() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION '% rows are never deleted (archive them instead)', TG_TABLE_NAME;
END $$;

DROP TRIGGER IF EXISTS studio_assets_no_delete ON studio_assets;
CREATE TRIGGER studio_assets_no_delete BEFORE DELETE ON studio_assets FOR EACH ROW EXECUTE FUNCTION studio_forbid_delete();
DROP TRIGGER IF EXISTS studio_jobs_no_delete ON studio_jobs;
CREATE TRIGGER studio_jobs_no_delete BEFORE DELETE ON studio_jobs FOR EACH ROW EXECUTE FUNCTION studio_forbid_delete();
DROP TRIGGER IF EXISTS studio_outputs_no_delete ON studio_outputs;
CREATE TRIGGER studio_outputs_no_delete BEFORE DELETE ON studio_outputs FOR EACH ROW EXECUTE FUNCTION studio_forbid_delete();
DROP TRIGGER IF EXISTS studio_batches_no_delete ON studio_batches;
CREATE TRIGGER studio_batches_no_delete BEFORE DELETE ON studio_batches FOR EACH ROW EXECUTE FUNCTION studio_forbid_delete();

-- ── RLS: on, no policy (server-only), like storage_objects ───────────────────

ALTER TABLE studio_packs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_assets          ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_asset_metadata  ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_projects        ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_project_packs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_selections      ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_batches         ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_jobs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_outputs         ENABLE ROW LEVEL SECURITY;
