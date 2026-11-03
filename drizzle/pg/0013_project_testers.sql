-- Migration 0013: Add project_testers table
-- Allows project owners to invite testers who can submit generation feedback.

CREATE TABLE IF NOT EXISTS project_testers (
  id               SERIAL PRIMARY KEY,
  video_project_id INTEGER NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
  user_id          UUID    NOT NULL,
  invited_at       BIGINT  NOT NULL,
  UNIQUE (video_project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_pt_user_id          ON project_testers(user_id);
CREATE INDEX IF NOT EXISTS idx_pt_video_project_id ON project_testers(video_project_id);
