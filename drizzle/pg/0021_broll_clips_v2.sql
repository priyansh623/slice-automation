-- Migration 0021: Add new metadata columns to broll_clips and create broll_feedback table
-- DO NOT APPLY TO REMOTE WITHOUT APPROVAL

ALTER TABLE broll_clips
  ADD COLUMN IF NOT EXISTS subject TEXT,
  ADD COLUMN IF NOT EXISTS activity TEXT,
  ADD COLUMN IF NOT EXISTS setting TEXT,
  ADD COLUMN IF NOT EXISTS brand TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT;

CREATE TABLE IF NOT EXISTS broll_feedback (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  clip_id INTEGER REFERENCES broll_clips(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  next_action TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS broll_feedback_user_id_idx ON broll_feedback(user_id);
CREATE INDEX IF NOT EXISTS broll_feedback_clip_id_idx ON broll_feedback(clip_id);
