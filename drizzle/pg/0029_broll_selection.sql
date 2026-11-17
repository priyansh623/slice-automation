-- Migration 0029: B-roll selection before generation, and auto/manual placement of overlays (follows 0028).
-- NOT YET APPLIED to any production database. Apply only with explicit approval, BEFORE the code that uses it is deployed.
--
-- Additive only; every existing row keeps working:
--   * video_projects.broll_selection   the B-roll a person picked on the selection screen, as IDs only:
--                                      { version, generic:[{clipId, screenId, overlayId?}], character:[{assetId, screenId, action, itemId?, overlayId?}] }
--                                      NULL = nothing selected (every existing project). No overlay rows and no jobs exist until the
--                                      clips are ready; selecting creates nothing and costs nothing.
--   * video_overlays.placement_source  'auto' = placed by the system when the timeline was first filled in from the selection;
--                                      'manual' = placed or edited by a person. Existing overlays are 'manual'. The automatic
--                                      arrangement only ever moves 'auto' overlays; any edit makes an overlay 'manual'.

DO $$
BEGIN
  IF to_regclass('public.video_projects') IS NULL OR to_regclass('public.video_overlays') IS NULL THEN
    RAISE EXCEPTION 'Migration 0029 needs migration 0028 to be applied first';
  END IF;
END $$;

ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS broll_selection JSONB;

ALTER TABLE video_overlays ADD COLUMN IF NOT EXISTS placement_source TEXT NOT NULL DEFAULT 'manual';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_overlays_placement_source_check') THEN
    ALTER TABLE video_overlays ADD CONSTRAINT video_overlays_placement_source_check CHECK (placement_source IN ('auto', 'manual'));
  END IF;
END $$;
