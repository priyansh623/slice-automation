-- Soma data recovery: generations recorded as failed although their video was stored (the polling race).
-- DO NOT RUN WITHOUT APPROVAL. Prepared 27 November 2026. Nothing here has been executed against production.
--
-- Run ONLY after: (1) the generation release is live on the worker (so the race cannot create more), and
-- (2) every file has been confirmed to exist with docs/stabilisation-recovery-checklist.md. A stored path is not proof of a file.
--
-- What it changes: video_generations.status 'failed' -> 'completed', clears error_message and claimed_at, sets updated_at.
-- What it never touches: scenes, approvals, files, compilations, projects.
--
-- Safeguards: exact id list; every row must still be failed with that exact message, a stored path and a media id; if the number of rows that
-- qualify, or the number updated, is not exactly the length of the list, an error is raised and NOTHING is changed. Running it again after a
-- successful run changes nothing and says so.
--
-- If the checklist shows a file is missing, REMOVE THAT ID from the list(s) below; the expected count follows the list.

-- ═════════════ STEP 1: PREVIEW (read only). Expect 13 rows in group A and 3 in group B, all with state 'eligible'. ═════════════
SELECT CASE WHEN g.id = ANY (ARRAY[258,261,352]) THEN 'B: deleted scene' ELSE 'A: existing scene' END AS grp,
       g.id AS generation, s.video_project_id AS project, s.screen_number AS scene, g.video_screen_id,
       g.status, g.error_message, g.video_storage_path, (g.media_generation_id IS NOT NULL) AS has_media_id,
       CASE WHEN g.status = 'failed' AND g.video_storage_path IS NOT NULL AND g.media_generation_id IS NOT NULL
                 AND g.error_message = 'Video completed but URL was not returned by provider' THEN 'eligible'
            WHEN g.status = 'completed' AND g.error_message IS NULL THEN 'already repaired'
            ELSE 'UNEXPECTED: do not run' END AS state
FROM video_generations g JOIN video_screens s ON s.id = g.video_screen_id
WHERE g.id = ANY (ARRAY[91,137,193,226,228,244,248,250,251,306,330,356,358, 258,261,352])
ORDER BY grp, g.id;

-- ═════════════ STEP 2: GROUP A, 13 generations on scenes that still exist. ═════════════
BEGIN;
DO $$
DECLARE
  targets  CONSTANT int[] := ARRAY[91,137,193,226,228,244,248,250,251,306,330,356,358];
  expected CONSTANT int := array_length(targets, 1);
  eligible int; repaired int; changed int;
BEGIN
  SELECT count(*) INTO eligible FROM video_generations
   WHERE id = ANY (targets) AND status = 'failed' AND video_storage_path IS NOT NULL AND media_generation_id IS NOT NULL
     AND error_message = 'Video completed but URL was not returned by provider';
  SELECT count(*) INTO repaired FROM video_generations WHERE id = ANY (targets) AND status = 'completed' AND error_message IS NULL;
  IF eligible = 0 AND repaired = expected THEN
    RAISE NOTICE 'Group A: already repaired, nothing to do.';
    RETURN;
  END IF;
  IF eligible <> expected THEN
    RAISE EXCEPTION 'Group A: expected % eligible rows, found % (% already repaired). Nothing changed.', expected, eligible, repaired;
  END IF;
  UPDATE video_generations SET status = 'completed', error_message = NULL, claimed_at = NULL, updated_at = (extract(epoch from now()) * 1000)::bigint
   WHERE id = ANY (targets) AND status = 'failed' AND video_storage_path IS NOT NULL AND media_generation_id IS NOT NULL
     AND error_message = 'Video completed but URL was not returned by provider';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> expected THEN
    RAISE EXCEPTION 'Group A: updated % rows, expected %. Rolled back.', changed, expected;
  END IF;
  RAISE NOTICE 'Group A: % rows repaired.', changed;
END $$;
COMMIT;   -- after an error PostgreSQL turns this into ROLLBACK by itself

-- ═════════════ STEP 3 (OPTIONAL): GROUP B, 3 generations on DELETED scenes. They are not visible unless the scene is restored. ═════════════
BEGIN;
DO $$
DECLARE
  targets  CONSTANT int[] := ARRAY[258,261,352];
  expected CONSTANT int := array_length(targets, 1);
  eligible int; repaired int; changed int;
BEGIN
  SELECT count(*) INTO eligible FROM video_generations
   WHERE id = ANY (targets) AND status = 'failed' AND video_storage_path IS NOT NULL AND media_generation_id IS NOT NULL
     AND error_message = 'Video completed but URL was not returned by provider';
  SELECT count(*) INTO repaired FROM video_generations WHERE id = ANY (targets) AND status = 'completed' AND error_message IS NULL;
  IF eligible = 0 AND repaired = expected THEN
    RAISE NOTICE 'Group B: already repaired, nothing to do.';
    RETURN;
  END IF;
  IF eligible <> expected THEN
    RAISE EXCEPTION 'Group B: expected % eligible rows, found % (% already repaired). Nothing changed.', expected, eligible, repaired;
  END IF;
  UPDATE video_generations SET status = 'completed', error_message = NULL, claimed_at = NULL, updated_at = (extract(epoch from now()) * 1000)::bigint
   WHERE id = ANY (targets) AND status = 'failed' AND video_storage_path IS NOT NULL AND media_generation_id IS NOT NULL
     AND error_message = 'Video completed but URL was not returned by provider';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> expected THEN
    RAISE EXCEPTION 'Group B: updated % rows, expected %. Rolled back.', changed, expected;
  END IF;
  RAISE NOTICE 'Group B: % rows repaired.', changed;
END $$;
COMMIT;
