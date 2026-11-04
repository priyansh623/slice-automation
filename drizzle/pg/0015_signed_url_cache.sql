-- Add signed URL cache columns to video_projects.
-- These let API endpoints reuse a valid signed URL instead of calling Storage on every request.
-- The expiry is stored as a Unix millisecond timestamp so comparison is a single integer check.
ALTER TABLE video_projects
  ADD COLUMN IF NOT EXISTS base_image_signed_url TEXT,
  ADD COLUMN IF NOT EXISTS base_image_signed_url_expires_at BIGINT;
