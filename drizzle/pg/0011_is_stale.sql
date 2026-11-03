-- Migration 0011: Add is_stale flag to screen_prompt_versions
-- Marks prompt versions whose screen dialogue has changed since the version was created.
-- Prevents stale prompts from being submitted to the video generation provider.

ALTER TABLE screen_prompt_versions
  ADD COLUMN IF NOT EXISTS is_stale BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_spv_is_stale ON screen_prompt_versions(is_stale) WHERE is_stale = TRUE;
