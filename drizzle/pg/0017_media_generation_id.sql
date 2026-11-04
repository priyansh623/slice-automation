-- Add media_generation_id to video_generations for useapi.net concatenate support.
-- This is the mediaGenerationId returned by the Google Flow video generation API,
-- required by POST /v1/google-flow/videos/concatenate.
ALTER TABLE video_generations ADD COLUMN IF NOT EXISTS media_generation_id TEXT;
