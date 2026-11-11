-- B-roll Library: clip storage, AI metadata, and review workflow
CREATE TABLE IF NOT EXISTS broll_clips (
  id                             SERIAL PRIMARY KEY,
  user_id                        UUID NOT NULL,
  title                          TEXT NOT NULL,
  storage_path                   TEXT NOT NULL,
  thumbnail_storage_path         TEXT,
  signed_url                     TEXT,
  signed_url_expires_at          BIGINT,
  thumbnail_signed_url           TEXT,
  thumbnail_signed_url_expires_at BIGINT,
  mime_type                      TEXT NOT NULL DEFAULT 'video/mp4',
  file_size_bytes                BIGINT,
  duration_seconds               INTEGER,
  ai_tags                        TEXT,
  ai_mood                        TEXT,
  ai_scene_type                  TEXT,
  ai_subjects                    TEXT,
  ai_summary                     TEXT,
  processing_status              TEXT NOT NULL DEFAULT 'pending',
  processing_error               TEXT,
  claimed_at                     BIGINT,
  review_status                  TEXT NOT NULL DEFAULT 'unreviewed',
  reviewed_at                    BIGINT,
  reviewed_by                    UUID,
  user_tags                      TEXT,
  category                       TEXT,
  notes                          TEXT,
  quality_rating                 INTEGER,
  created_at                     BIGINT NOT NULL,
  updated_at                     BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS broll_clips_user_id ON broll_clips (user_id);
CREATE INDEX IF NOT EXISTS broll_clips_processing_status ON broll_clips (processing_status);
CREATE INDEX IF NOT EXISTS broll_clips_review_status ON broll_clips (review_status);

-- RLS
ALTER TABLE broll_clips ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own broll clips"
  ON broll_clips FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
