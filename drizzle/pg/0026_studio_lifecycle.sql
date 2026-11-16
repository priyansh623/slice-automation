-- Migration 0026: Character B-roll Studio lifecycle and cost controls (follows 0025)
-- NOT YET APPLIED to any database. Apply to production only with explicit approval, together with 0025 and BEFORE the code.
--
-- Additive only (new tables, new columns with defaults, a wider status check, one re-created index, new functions/triggers whose
-- names start with studio_). Nothing outside the Studio is touched.
--
--   * studio_deleted_keys     permanent tombstones: an R2 object is only ever deleted AFTER its key is recorded here, and a key
--                             recorded here can never be registered again (trigger). This closes the check-then-delete race.
--   * studio_upload_intents   every upload key the server hands out; a trigger marks it 'registered' in the same transaction that
--                             registers it, so a registered key (an asset, a character, even a replaced one) is never swept.
--   * studio_jobs             new status 'submit_unknown' (the provider may or may not have received the job) + counters.
--   * studio_worker_status    what each running worker says it can do (provider, R2), so the web app can refuse to queue work
--                             that no worker will process.
--   * studio_budget_usage     persistent, atomic hourly counter for paid image analysis.

-- ── Tombstones and upload intents ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS studio_deleted_keys (
  key          TEXT   PRIMARY KEY,
  reason       TEXT   NOT NULL,
  requested_at BIGINT NOT NULL,
  removed_at   BIGINT                      -- set once R2 confirmed the object is gone; null = removal still to be (re)tried
);

CREATE TABLE IF NOT EXISTS studio_upload_intents (
  key           TEXT    PRIMARY KEY,       -- an R2 key the server issued for a browser upload
  kind          TEXT    NOT NULL,
  project_id    INTEGER,
  pack_id       INTEGER,
  state         TEXT    NOT NULL DEFAULT 'issued',
  created_by    UUID,
  issued_at     BIGINT  NOT NULL,
  registered_at BIGINT,
  CONSTRAINT studio_upload_intents_kind_check CHECK (kind IN ('asset', 'character')),
  CONSTRAINT studio_upload_intents_state_check CHECK (state IN ('issued', 'registered'))
);
CREATE INDEX IF NOT EXISTS idx_studio_upload_intents_open ON studio_upload_intents (issued_at) WHERE state = 'issued';

-- Tombstones are permanent: a row can be added but never deleted (reuses the guard function from 0025).
DROP TRIGGER IF EXISTS studio_deleted_keys_no_delete ON studio_deleted_keys;
CREATE TRIGGER studio_deleted_keys_no_delete BEFORE DELETE ON studio_deleted_keys FOR EACH ROW EXECUTE FUNCTION studio_forbid_delete();

-- Runs whenever an asset or a project's character key is written. A key that has a tombstone can never be registered; a key that is
-- registered is marked so. The SHARED advisory lock is held until the writing transaction ends, so a deletion (which takes the
-- EXCLUSIVE lock on the same key before it checks for references) either sees this registration or makes this transaction fail.
CREATE OR REPLACE FUNCTION studio_guard_object_keys() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  rec     JSONB := to_jsonb(NEW);
  old_rec JSONB;
  k       TEXT;
  i       INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' THEN old_rec := to_jsonb(OLD); END IF;
  FOR i IN 0 .. TG_NARGS - 1 LOOP
    k := rec ->> TG_ARGV[i];
    IF k IS NULL THEN CONTINUE; END IF;
    IF TG_OP = 'UPDATE' AND (old_rec ->> TG_ARGV[i]) IS NOT DISTINCT FROM k THEN CONTINUE; END IF;
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(k, 0));
    IF EXISTS (SELECT 1 FROM studio_deleted_keys d WHERE d.key = k) THEN
      RAISE EXCEPTION 'studio_key_removed: the stored file % was removed and cannot be registered', k;
    END IF;
    UPDATE studio_upload_intents SET state = 'registered', registered_at = (extract(epoch FROM clock_timestamp()) * 1000)::BIGINT
      WHERE key = k AND state = 'issued';
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS studio_assets_keys_trg ON studio_assets;
CREATE TRIGGER studio_assets_keys_trg BEFORE INSERT OR UPDATE OF storage_key, thumb_key ON studio_assets
  FOR EACH ROW EXECUTE FUNCTION studio_guard_object_keys('storage_key', 'thumb_key');
DROP TRIGGER IF EXISTS studio_projects_keys_trg ON studio_projects;
CREATE TRIGGER studio_projects_keys_trg BEFORE INSERT OR UPDATE OF character_key ON studio_projects
  FOR EACH ROW EXECUTE FUNCTION studio_guard_object_keys('character_key');

-- ── Generation jobs: an explicit "the provider may have received this" state ─

ALTER TABLE studio_jobs DROP CONSTRAINT IF EXISTS studio_jobs_status_check;
ALTER TABLE studio_jobs ADD CONSTRAINT studio_jobs_status_check
  CHECK (status IN ('queued', 'submitting', 'submit_unknown', 'processing', 'succeeded', 'failed', 'canceled'));
ALTER TABLE studio_jobs ADD COLUMN IF NOT EXISTS submit_attempts INTEGER NOT NULL DEFAULT 0;   -- how many times it was sent to the provider
ALTER TABLE studio_jobs ADD COLUMN IF NOT EXISTS ambiguous_at BIGINT;                           -- when the outcome of a send became unknown

-- A job whose submission outcome is unknown may be running (and paid for) at the provider, so it still blocks another job for the
-- same image until a person resolves it.
DROP INDEX IF EXISTS idx_studio_jobs_one_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_jobs_one_active ON studio_jobs (batch_id, asset_id)
  WHERE status IN ('queued', 'submitting', 'submit_unknown', 'processing');

-- ── Workers say what they can do ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS studio_worker_status (
  worker_id        TEXT    PRIMARY KEY,
  provider         TEXT,                   -- STUDIO_PROVIDER as this worker sees it (null = none)
  mode             TEXT    NOT NULL,       -- disabled | mock | real
  generation_ready BOOLEAN NOT NULL,       -- provider usable AND R2 configured AND the worker switched on
  r2_ready         BOOLEAN NOT NULL,
  worker_enabled   BOOLEAN NOT NULL,
  analysis_ready   BOOLEAN NOT NULL,
  details          JSONB,
  started_at       BIGINT  NOT NULL,
  last_seen_at     BIGINT  NOT NULL,
  CONSTRAINT studio_worker_status_mode_check CHECK (mode IN ('disabled', 'mock', 'real'))
);

-- ── Persistent hourly budget for paid image analysis ─────────────────────────

CREATE TABLE IF NOT EXISTS studio_budget_usage (
  kind             TEXT    NOT NULL,       -- e.g. 'analysis'
  window_start     BIGINT  NOT NULL,       -- start of the UTC hour, in ms
  reserved         INTEGER NOT NULL DEFAULT 0,
  refunded         INTEGER NOT NULL DEFAULT 0,   -- reserved but never sent to the paid service
  succeeded        INTEGER NOT NULL DEFAULT 0,
  failed           INTEGER NOT NULL DEFAULT 0,
  limit_per_window INTEGER,
  exhausted_at     BIGINT,
  updated_at       BIGINT  NOT NULL,
  PRIMARY KEY (kind, window_start),
  CONSTRAINT studio_budget_usage_counts_check CHECK (reserved >= 0 AND refunded >= 0 AND refunded <= reserved)
);

ALTER TABLE studio_deleted_keys    ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_upload_intents  ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_worker_status   ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_budget_usage    ENABLE ROW LEVEL SECURITY;
