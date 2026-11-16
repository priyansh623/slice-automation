-- Migration 0027: Scene Pack import support (follows 0025 and 0026).
-- NOT YET APPLIED to any database. Apply to production only with explicit approval, after a fresh backup, and BEFORE the code
-- that reads these columns is deployed.
--
-- Additive only. It changes no existing row. Studio tables only.
--
--   * studio_asset_metadata.imported   a third metadata layer: values supplied by an import (never written by the AI worker or by a
--                                      person's edit). Shape: { fields: {environment, activity, ...}, composition, operational,
--                                      technical, source, status, version, lineage }. Only `fields` takes part in the effective value.
--   * studio_asset_metadata.search_tsv  rebuilt so that it follows the new precedence per field: manual > imported > AI.
--                                      character_position (where a person stands in the frame) is no longer indexed: search is about
--                                      scenes, not about the person.
--   * studio_scene_text(text)         removes descriptions of a person (and unambiguous clothing) from text before it is indexed,
--                                      whichever layer (AI, imported, manual) the text came from: a person can never be searched for,
--                                      while scene terms ("hair salon", "old building") stay. Same patterns as scene-metadata.ts.
--   * studio_packs.import_key          a permanent external identity for a pack (unique, set once, never changed).
--   * studio_assets.import_key         the permanent identity of a SOURCE IMAGE. A database asset row is one version of that image in
--                                      one pack; several rows (archived versions) may share a key, but only one ACTIVE row may.
--
-- Why not ALTER COLUMN ... SET EXPRESSION for search_tsv: it exists only from PostgreSQL 17, and the unit tests run on PGlite (a
-- PostgreSQL 16 build). The column is derived data, so it is dropped and added again, which behaves the same on 16 and 17 and
-- is trivial at this size (it is rebuilt from ai/manual/imported, nothing is lost).

DO $$
BEGIN
  IF to_regclass('public.studio_asset_metadata') IS NULL OR to_regclass('public.studio_deleted_keys') IS NULL
     OR to_regclass('public.studio_assets') IS NULL OR to_regclass('public.studio_packs') IS NULL
     OR to_regprocedure('public.studio_effective(jsonb,jsonb,text)') IS NULL
     OR to_regprocedure('public.studio_assets_immutable()') IS NULL THEN
    RAISE EXCEPTION 'Migration 0027 needs migrations 0025 and 0026 to be applied first';
  END IF;
END $$;

-- ── Identity columns ─────────────────────────────────────────────────────────

ALTER TABLE studio_packs  ADD COLUMN IF NOT EXISTS import_key TEXT;
ALTER TABLE studio_assets ADD COLUMN IF NOT EXISTS import_key TEXT;

-- A pack key is unique for ever (archived packs keep theirs). An image key is unique among ACTIVE rows only, so an archived older
-- version can keep the key while a newer version carries it too.
CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_packs_import_key ON studio_packs (import_key) WHERE import_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_assets_import_key_active ON studio_assets (import_key) WHERE import_key IS NOT NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_studio_assets_import_key ON studio_assets (import_key) WHERE import_key IS NOT NULL;

-- A key can be set once (null -> value) and never changed or removed.
CREATE OR REPLACE FUNCTION studio_import_key_immutable() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.import_key IS NOT NULL AND NEW.import_key IS DISTINCT FROM OLD.import_key THEN
    RAISE EXCEPTION 'An import_key is permanent: it cannot be changed or removed';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS studio_assets_import_key_trg ON studio_assets;
CREATE TRIGGER studio_assets_import_key_trg BEFORE UPDATE OF import_key ON studio_assets FOR EACH ROW EXECUTE FUNCTION studio_import_key_immutable();
DROP TRIGGER IF EXISTS studio_packs_import_key_trg ON studio_packs;
CREATE TRIGGER studio_packs_import_key_trg BEFORE UPDATE OF import_key ON studio_packs FOR EACH ROW EXECUTE FUNCTION studio_import_key_immutable();

-- ── The imported layer and the new precedence ────────────────────────────────

ALTER TABLE studio_asset_metadata ADD COLUMN IF NOT EXISTS imported JSONB NOT NULL DEFAULT '{}'::jsonb;

-- The value a field has, decided per field: a manual value wins (even a deliberate null, which means "cleared on purpose" and does
-- NOT fall back to anything), then an imported value, then the AI value. An imported value that is null, absent, an empty string or an empty list is "no imported
-- value" and the AI value shows.
CREATE OR REPLACE FUNCTION studio_effective(ai JSONB, manual JSONB, imported JSONB, field TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN jsonb_exists(manual, field) THEN manual ->> field
    WHEN NULLIF(NULLIF(imported -> 'fields' ->> field, ''), '[]') IS NOT NULL THEN imported -> 'fields' ->> field
    ELSE ai ->> field
  END
$$;

-- Descriptions of a person (who they are, age, build, hair, skin, clothing) never reach the search index. The patterns are the
-- single list in src/lib/studio/import/scene-metadata.ts (PERSON_PATTERNS + CLOTHING_PATTERN, with \y for a word boundary); a test
-- keeps them identical and runs both implementations on the same corpus. Scene terms such as "hair salon", "old building" and
-- "young audience" are NOT matched: a word is removed only where it names a person or is attached to one.
CREATE OR REPLACE FUNCTION studio_scene_text(t TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT regexp_replace(translate(coalesce(t, ''), '_', ' '), '\y(?:(?:young|old|elderly|middle-aged|teenage|adult|slim|athletic|muscular|bearded|bald|tall|short|fit|handsome|pretty|indian|asian|caucasian|african|european|latino|hispanic|white|black|brown|south asian|east asian)[ -]+){0,3}(?:man|men|woman|women|male|female|boy|girl|guy|lady|gentleman|husband|wife|mother|father|homemaker|housewife|teen|teenager|gen z|he|she|him|himself|herself)\y|\y(?:young|old|elderly|middle-aged|teenage|adult|slim|athletic|muscular|bearded|bald|tall|short|fit|handsome|pretty|indian|asian|caucasian|african|european|latino|hispanic|white|black|brown|south asian|east asian)[ -]+(?:person|persons|people|adults|adult|children|child|kids|kid)\y|\y(?:beard|bearded|moustache|mustache|stubble|complexion|bald)\y|\y(?:[a-z]+[ -])?haired\y|\y(?:his|her|their|long|short|curly|wavy|straight|black|brown|blond|blonde|grey|gray|dark|red|tied|messy)[ -]+hair\y|\yhair[ -]+(?:tied|bun|ponytail|pulled)\y|\y(?:fair|dark|light|olive|tanned|smooth|clear|brown)[ -]+skin\y|\yskin[ -]+(?:tone|colou?r)\y|\y(?:slim|athletic|muscular|lean|stocky|curvy)[ -]+(?:build|physique|body|figure|frame)\y|\y[0-9]{1,2}[ -]years?[ -]old\y|\yaged?[ ]+[0-9]{1,2}\y|\yin (?:his|her) (?:early |mid |late )?(?:[2-9]0s|twenties|thirties|forties|fifties)\y|\y(?:his|her|hers)\y|\y(?:t-shirt|tshirt|tee|polo|sweatshirt|shirt|overshirt|jacket|hoodie|trousers|pyjama|pyjamas|pajama|pajamas|jeans|beanie|sunglasses|spectacles|bracelet|wristwatch|necklace|sneakers|loungewear)\y', ' ', 'gi')
$$;

-- Rebuilt from the same ai/manual values plus the imported layer. For every existing row (imported = '{}') it yields the
-- vector the old expression gave, except that character_position is no longer indexed and person or clothing words are removed.
ALTER TABLE studio_asset_metadata DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE studio_asset_metadata ADD COLUMN search_tsv TSVECTOR GENERATED ALWAYS AS (
  to_tsvector('english',
    coalesce(studio_scene_text(studio_effective(ai, manual, imported, 'description')), '') || ' ' ||
    coalesce(studio_scene_text(studio_effective(ai, manual, imported, 'environment')), '') || ' ' ||
    coalesce(studio_scene_text(studio_effective(ai, manual, imported, 'activity')), '') || ' ' ||
    coalesce(studio_scene_text(studio_effective(ai, manual, imported, 'objects_props')), '') || ' ' ||
    coalesce(studio_scene_text(studio_effective(ai, manual, imported, 'camera_angle')), '') || ' ' ||
    coalesce(studio_scene_text(studio_effective(ai, manual, imported, 'framing')), '') || ' ' ||
    coalesce(studio_scene_text(studio_effective(ai, manual, imported, 'lighting')), '') || ' ' ||
    coalesce(studio_scene_text(studio_effective(ai, manual, imported, 'composition')), '') || ' ' ||
    coalesce(studio_scene_text(studio_effective(ai, manual, imported, 'tags')), '')
  )
) STORED;

CREATE INDEX IF NOT EXISTS idx_studio_asset_metadata_search ON studio_asset_metadata USING GIN (search_tsv);
