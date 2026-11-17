-- Migration 0028: B-roll overlays on the Google Flow timeline (follows 0027).
-- NOT YET APPLIED to any database. Apply to production only with explicit approval, BEFORE the code that uses it is deployed.
--
-- Additive only. video_screens, video_generations and every Flow table are NOT changed: a Flow scene stays a Flow scene and keeps
-- its dialogue. B-roll is never a scene. It is an OVERLAY that sits on top of the Flow footage at a position given relative to a
-- Flow scene, and has no audio of its own.
--
--   * character_broll_items       the paid Character B-roll pipeline for one Scene Pack image: personalised image (made through the
--                                 Studio's replacement jobs) -> explicit approval -> editable motion prompt -> one image-to-video
--                                 job -> a silent clip in our own storage. A CHECK makes it impossible for a video job to exist
--                                 unless the personalised image was approved.
--   * video_overlays              one row per placed overlay: type, anchor Flow scene, start offset (relative to that scene),
--                                 duration, source trim, the silent normalised clip, and where it came from. `track` is 0 today;
--                                 the schema already allows more tracks.
--   * video_compilation_overlays  the overlays a compilation used, frozen at the moment it was requested, so an earlier version never
--                                 changes when overlays are edited later. The worker records the resolved absolute times here.
--   * video_compilations.overlay_count   0 for every existing and every plain Flow compilation.
--   * studio_projects.video_project_id   the Studio project that holds a video project's Character B-roll replacement jobs.

DO $$
BEGIN
  IF to_regclass('public.video_projects') IS NULL OR to_regclass('public.video_screens') IS NULL
     OR to_regclass('public.video_compilations') IS NULL OR to_regclass('public.broll_clips') IS NULL
     OR to_regclass('public.studio_projects') IS NULL OR to_regclass('public.studio_assets') IS NULL
     OR to_regclass('public.studio_jobs') IS NULL OR to_regclass('public.studio_outputs') IS NULL THEN
    RAISE EXCEPTION 'Migration 0028 needs the video workflow tables and migrations 0025 to 0027 to be applied first';
  END IF;
END $$;

ALTER TABLE studio_projects ADD COLUMN IF NOT EXISTS video_project_id INTEGER REFERENCES video_projects(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_projects_video_project ON studio_projects (video_project_id) WHERE video_project_id IS NOT NULL;

-- ── Character B-roll items ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS character_broll_items (
  id                    SERIAL PRIMARY KEY,
  video_project_id      INTEGER NOT NULL REFERENCES video_projects(id),
  studio_asset_id       INTEGER NOT NULL REFERENCES studio_assets(id),
  intended_action       TEXT    NOT NULL DEFAULT '',
  -- The personalised image (a Studio replacement job and its output).
  studio_job_id         INTEGER REFERENCES studio_jobs(id),
  studio_output_id      INTEGER REFERENCES studio_outputs(id),
  image_status          TEXT    NOT NULL DEFAULT 'pending',   -- pending | generating | ready | approved | rejected | failed
  image_error           TEXT,
  image_approved_at     BIGINT,
  image_approved_by     UUID,
  -- The motion prompt (suggested from the actual approved image, then editable).
  motion_prompt         TEXT,
  prompt_edited         BOOLEAN NOT NULL DEFAULT FALSE,
  -- The image-to-video job.
  clip_status           TEXT    NOT NULL DEFAULT 'not_started', -- not_started | queued | submitting | submit_unknown | processing | ready | failed
  clip_attempt          INTEGER NOT NULL DEFAULT 0,
  clip_provider         TEXT,
  clip_endpoint         TEXT,
  idempotency_key       TEXT,
  provider_request_id   TEXT,
  submitted_at          BIGINT,
  claimed_at            BIGINT,
  poll_count            INTEGER NOT NULL DEFAULT 0,
  next_poll_at          BIGINT,
  clip_error_code       TEXT,
  clip_error_message    TEXT,
  clip_retryable        BOOLEAN,
  clip_storage_path     TEXT,
  clip_width            INTEGER,
  clip_height           INTEGER,
  clip_duration_ms      INTEGER,
  clip_probe            JSONB,
  created_by            UUID    NOT NULL,
  created_at            BIGINT  NOT NULL,
  updated_at            BIGINT  NOT NULL,
  CONSTRAINT character_broll_image_status_check CHECK (image_status IN ('pending','generating','ready','approved','rejected','failed')),
  CONSTRAINT character_broll_clip_status_check  CHECK (clip_status IN ('not_started','queued','submitting','submit_unknown','processing','ready','failed')),
  -- THE PAID-STEP GATE: a video job (anything past not_started) can only exist for an approved personalised image.
  CONSTRAINT character_broll_video_needs_approved_image CHECK (clip_status = 'not_started' OR image_status = 'approved'),
  CONSTRAINT character_broll_approved_has_output CHECK (image_status <> 'approved' OR studio_output_id IS NOT NULL),
  CONSTRAINT character_broll_ready_has_clip CHECK (clip_status <> 'ready' OR clip_storage_path IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_character_broll_idempotency ON character_broll_items (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_character_broll_project ON character_broll_items (video_project_id);
CREATE INDEX IF NOT EXISTS idx_character_broll_clip_active ON character_broll_items (clip_status) WHERE clip_status IN ('queued','submitting','submit_unknown','processing');

-- ── Overlays ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS video_overlays (
  id                 SERIAL PRIMARY KEY,
  video_project_id   INTEGER NOT NULL REFERENCES video_projects(id),
  kind               TEXT    NOT NULL,                         -- generic | character
  track              INTEGER NOT NULL DEFAULT 0,               -- 0 today; higher tracks draw on top
  -- Position, relative to the anchor Flow scene (so reordering Flow scenes never moves an overlay away from its scene).
  anchor_screen_id   INTEGER NOT NULL REFERENCES video_screens(id),
  start_offset_ms    INTEGER NOT NULL,
  duration_ms        INTEGER NOT NULL,
  source_start_ms    INTEGER NOT NULL DEFAULT 0,               -- trim-in point inside the normalised clip
  -- The silent, normalised project copy used for compositing (the library original is never touched).
  asset_storage_path TEXT,
  asset_width        INTEGER,
  asset_height       INTEGER,
  asset_duration_ms  INTEGER,
  -- Where it came from.
  broll_clip_id      INTEGER REFERENCES broll_clips(id),
  character_item_id  INTEGER REFERENCES character_broll_items(id),
  status             TEXT    NOT NULL DEFAULT 'preparing',     -- preparing | ready | failed
  error_message      TEXT,
  claimed_at         BIGINT,
  created_by         UUID    NOT NULL,
  created_at         BIGINT  NOT NULL,
  updated_at         BIGINT  NOT NULL,
  CONSTRAINT video_overlays_kind_check   CHECK (kind IN ('generic','character')),
  CONSTRAINT video_overlays_status_check CHECK (status IN ('preparing','ready','failed')),
  CONSTRAINT video_overlays_track_check  CHECK (track >= 0),
  CONSTRAINT video_overlays_timing_check CHECK (start_offset_ms >= 0 AND duration_ms > 0 AND source_start_ms >= 0),
  CONSTRAINT video_overlays_source_check CHECK (
    (kind = 'generic'   AND broll_clip_id IS NOT NULL AND character_item_id IS NULL) OR
    (kind = 'character' AND character_item_id IS NOT NULL AND broll_clip_id IS NULL)
  ),
  CONSTRAINT video_overlays_ready_has_asset CHECK (status <> 'ready' OR asset_storage_path IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_video_overlays_project ON video_overlays (video_project_id);
CREATE INDEX IF NOT EXISTS idx_video_overlays_anchor  ON video_overlays (anchor_screen_id);
CREATE INDEX IF NOT EXISTS idx_video_overlays_preparing ON video_overlays (status) WHERE status = 'preparing';

-- ── What a compilation used ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS video_compilation_overlays (
  id                 SERIAL PRIMARY KEY,
  compilation_id     INTEGER NOT NULL REFERENCES video_compilations(id),
  overlay_id         INTEGER REFERENCES video_overlays(id),
  kind               TEXT    NOT NULL,
  track              INTEGER NOT NULL DEFAULT 0,
  anchor_screen_id   INTEGER NOT NULL REFERENCES video_screens(id),
  start_offset_ms    INTEGER NOT NULL,
  duration_ms        INTEGER NOT NULL,
  source_start_ms    INTEGER NOT NULL DEFAULT 0,
  asset_storage_path TEXT    NOT NULL,
  asset_width        INTEGER,
  asset_height       INTEGER,
  asset_duration_ms  INTEGER,
  -- Filled in by the worker when it resolves the overlay against the real Flow clip durations.
  resolved_start_ms  INTEGER,
  resolved_end_ms    INTEGER,
  created_at         BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_video_compilation_overlays_compilation ON video_compilation_overlays (compilation_id);

ALTER TABLE video_compilations ADD COLUMN IF NOT EXISTS overlay_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE character_broll_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_overlays              ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_compilation_overlays  ENABLE ROW LEVEL SECURITY;
