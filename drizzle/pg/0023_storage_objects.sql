-- Migration 0023: storage location registry (which provider holds each stored file)
-- Applied to the production project on 2026-11-13 (additive; no existing row or table was changed).
--
-- Additive only: one new table, no change to any existing table or row. The application treats a missing row, or a
-- missing table, as "this file is in Supabase Storage", so this can be applied before or after the code that reads it.
-- Nothing in this migration moves, copies or deletes a file.

CREATE TABLE IF NOT EXISTS storage_objects (
  bucket       TEXT   NOT NULL,                 -- logical bucket: 'videos' | 'uploads'
  key          TEXT   NOT NULL,                 -- object key, identical in Supabase and R2
  provider     TEXT   NOT NULL,                 -- 'supabase' | 'r2'
  size_bytes   BIGINT,
  content_type TEXT,
  sha256       TEXT,                            -- recorded when a copy was verified
  verified_at  BIGINT,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  PRIMARY KEY (bucket, key)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storage_objects_provider_check') THEN
    ALTER TABLE storage_objects
      ADD CONSTRAINT storage_objects_provider_check CHECK (provider IN ('supabase', 'r2'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_storage_objects_provider ON storage_objects (provider);

-- Server-side only, like the other internal tables: row level security on and no policy, so the public API key
-- cannot read or change it. The application's own database connection bypasses it.
ALTER TABLE storage_objects ENABLE ROW LEVEL SECURITY;
