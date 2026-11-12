-- Migration 0022: clip clearance status and structured brand associations
-- DO NOT APPLY TO REMOTE WITHOUT APPROVAL
--
-- Additive only. Apply this BEFORE deploying the application code that goes with it: that code
-- selects broll_clips.clearance_status and reads broll_clip_brands, so it fails if they do not exist yet.
-- Existing rows are not marked cleared; every row starts as 'unresolved'.

-- Clearance is separate from review_status and from classification.
ALTER TABLE broll_clips
  ADD COLUMN IF NOT EXISTS clearance_status TEXT NOT NULL DEFAULT 'unresolved';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'broll_clips_clearance_status_check') THEN
    ALTER TABLE broll_clips
      ADD CONSTRAINT broll_clips_clearance_status_check
      CHECK (clearance_status IN ('unresolved', 'cleared', 'not_cleared'));
  END IF;
END $$;

-- One row per brand (or brand-like element) visible in a clip. broll_clips.brand is kept as
-- the hero brand for the existing brand filter and brand-scoped categories.
--
-- role says what the brand is to the clip; clearance_status says whether it may be used.
-- They are independent. role 'unresolved' means something brand-like is visible but its role
-- is undecided. brand_name stays NULL when the identity is unknown, so a name is never invented;
-- an unnamed row must carry a note describing what was observed.
CREATE TABLE IF NOT EXISTS broll_clip_brands (
  id               SERIAL PRIMARY KEY,
  clip_id          INTEGER NOT NULL REFERENCES broll_clips(id) ON DELETE CASCADE,
  brand_name       TEXT,
  role             TEXT NOT NULL,                        -- hero | incidental | client_product | unresolved
  clearance_status TEXT NOT NULL DEFAULT 'unresolved',   -- unresolved | cleared | not_cleared
  note             TEXT,
  created_at       BIGINT NOT NULL,
  updated_at       BIGINT NOT NULL,
  CONSTRAINT broll_clip_brands_role_check
    CHECK (role IN ('hero', 'incidental', 'client_product', 'unresolved')),
  CONSTRAINT broll_clip_brands_clearance_status_check
    CHECK (clearance_status IN ('unresolved', 'cleared', 'not_cleared')),
  CONSTRAINT broll_clip_brands_name_required_check
    CHECK (brand_name IS NOT NULL OR role IN ('client_product', 'unresolved')),
  CONSTRAINT broll_clip_brands_name_not_blank_check
    CHECK (brand_name IS NULL OR length(trim(brand_name)) > 0),
  CONSTRAINT broll_clip_brands_unnamed_needs_note_check
    CHECK (brand_name IS NOT NULL OR length(trim(coalesce(note, ''))) > 0)
);

-- A clip cannot list the same brand twice in the same role. Unnamed rows are told apart by
-- their note. This is also what makes the backfill idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS broll_clip_brands_unique_key
  ON broll_clip_brands (
    clip_id,
    role,
    lower(coalesce(brand_name, '')),
    (CASE WHEN brand_name IS NULL THEN lower(coalesce(note, '')) ELSE '' END)
  );

CREATE INDEX IF NOT EXISTS broll_clip_brands_clip_id_idx ON broll_clip_brands (clip_id);
CREATE INDEX IF NOT EXISTS broll_clip_brands_brand_name_idx ON broll_clip_brands (lower(brand_name));

-- No policies: the app reaches this table through its server-side connection only.
ALTER TABLE broll_clip_brands ENABLE ROW LEVEL SECURITY;
