ALTER TABLE "video_projects"
  ADD COLUMN IF NOT EXISTS "archived_at" bigint;
