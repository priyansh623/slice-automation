-- Migration 0024: compilation version history
--
-- Purpose: let a project be compiled again and again, keeping every successful compilation as its own numbered version.
--
-- Additive only. No existing row is deleted, and no existing value is overwritten except filling the new `version`
-- column for compilations that are already completed.
--
--   version  Number of a SUCCESSFUL compilation within its project (1, 2, 3, ...). NULL for compilations that have not
--            succeeded (pending, processing, failed), so failed attempts never consume a version number. It is assigned
--            by the worker when the compilation completes, inside a transaction that holds the project row lock.
--   method   How the video was produced: 'useapi' (concatenate endpoint) or 'ffmpeg' (stored clips joined by FFmpeg).
--            NULL for compilations made before this migration (unknown; not guessed).
--
-- The CURRENT compilation of a project is, by definition, its completed compilation with the highest version.
-- It is derived, never stored, so it cannot get out of step with the data.

ALTER TABLE video_compilations ADD COLUMN IF NOT EXISTS version INTEGER;
ALTER TABLE video_compilations ADD COLUMN IF NOT EXISTS method  TEXT;

-- Number the compilations that have already completed, per project, in the order they were created.
UPDATE video_compilations c
SET    version = n.v
FROM  (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY video_project_id ORDER BY created_at, id) AS v
  FROM   video_compilations
  WHERE  status = 'completed'
) n
WHERE  c.id = n.id
  AND  c.version IS NULL;

-- A version number is used at most once per project, and only completed compilations have one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vc_project_version
  ON video_compilations (video_project_id, version)
  WHERE version IS NOT NULL;

-- At most one compilation per project may be waiting or running. This is what stops two requests (a double click, two
-- tabs, two testers) from starting overlapping jobs; the API turns a violation into a clear "already running" answer.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vc_one_active_per_project
  ON video_compilations (video_project_id)
  WHERE status IN ('pending', 'processing');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_compilations_version_positive') THEN
    ALTER TABLE video_compilations
      ADD CONSTRAINT video_compilations_version_positive CHECK (version IS NULL OR version >= 1);
  END IF;
END $$;
