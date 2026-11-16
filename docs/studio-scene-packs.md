# Scene Packs: taxonomy, import and metadata

The V1 library is 54 source images in eight **scene** packs. A pack is defined by the scenes it holds, never by the person in the pictures.
The character reference is a separate project input and replaces that person later.

## Packs and the allocation rule
`scripts/studio-import/allocation.ts` holds the eight packs (name, description, permanent key) and the allocation of IMG-001..IMG-054.
Rule: if an identifiable **setting** exists it decides the primary pack; if not, the **activity** does. Secondary concepts help search and
recommendations and never create a second pack membership. Uncertain allocations carry review flags (`classification_uncertain`,
`setting_discrepancy`, `filename_mismatch`) that the Repository shows as "Needs review".

## Identity
* **Permanent image ID** `IMG-001`.. (`studio_assets.import_key`): the identity of the SOURCE image. Independent of file name, folder and pack.
* **Asset row**: one VERSION of that image in one pack. Changed content or a pack change registers a NEW row (new deterministic R2 key) and
  archives the old one in the same transaction. Old rows, their R2 objects and their history are kept. `pack_id` is never changed in place
  (trigger + composite foreign keys). Only one ACTIVE row may carry an ID (partial unique index); an ID cannot be changed once set (trigger).
* **R2 key** = `studio/assets/<uuidv5(IMG-ID | v<version> | sha256)>.png`; thumbnail `studio/assets/thumbs/<same uuid>.webp`.
  Same inputs, same key (a rerun after a crash finds its own object); new version or content, new key (nothing is overwritten).
* **Pack** permanent key (`studio_packs.import_key`), set once; an import never renames or re-describes an existing pack.

## Metadata: manual > imported > AI, per field
Three layers in `studio_asset_metadata`: `ai`, `manual`, `imported`. A field's value is decided per field:
manual (a deliberate `null` = cleared, does NOT fall back) -> imported (null/empty = none supplied) -> AI.
Re-analysis writes `ai` only, an edit writes `manual` only, an import writes `imported` only. Reverting a manual edit reveals the imported
value, else the AI value. Implemented identically in SQL (`studio_effective(ai, manual, imported, field)`, used by the generated
`search_tsv`) and TypeScript (`effectiveMetadata`).

`imported` = `{ fields, composition, operational, technical, source, status, version, lineage }`. Only `fields` (scene metadata) is
searched/recommended. `composition` (pose, gaze, face visibility, position, scale, hands) is kept for character replacement and is never
searched, ranked or used as a filter. `operational` holds replacement-risk and brand flags and review items.

## No person in discovery
Not imported at all: persona descriptions, gender/age/ethnicity/appearance, clothing and personal accessories, facial-expression tags, the
inventory's `scene_description` and `flag_notes` (they describe the person), and person-related flags (`ACCESSORY`, `OUTFIT_DIFFERS`,
`IDENTITY_CONTINUITY_UNCONFIRMED`). The rules are named and explainable in `src/lib/studio/import/scene-metadata.ts`; `build-manifest.ts`
prints every dropped term with its reason. Profiles and prompts apply the same rules again, so a later manual edit cannot leak a person
into a recommendation. `character_position` is not indexed for search.
Search is also filtered at the index itself: migration 0027's `studio_scene_text()` removes person and clothing words (the list `INDEX_STRIPPED_WORDS`, kept equal by a test) from every layer's text before it is indexed, so AI or manual text can never make a person searchable. The stored text is not altered. Ambiguous words (ring, watch, cap, glasses) are not removed.

## Importer (`scripts/studio-import/run.ts`)
```
npx tsx scripts/studio-import/run.ts check --source "<Scene Packs folder>"            # files vs manifest only; no DB, no R2
npx tsx --env-file=.env.local scripts/studio-import/run.ts plan --source "..." [--verify-r2]   # dry run: reads DB + R2, writes nothing
npx tsx --env-file=.env.local scripts/studio-import/run.ts apply --source "..." --owner <user uuid> --yes
npx tsx --env-file=.env.local scripts/studio-import/run.ts archive-legacy --pack-id <id> [--yes]  # soft-archives the "Cafe" test pack after checks
```
Per image it validates the source (SHA-256, size, dimensions, PNG, limits), then: skip (verified by the real content hash of the R2 object),
repair a missing thumbnail, refresh the imported layer (manual edits untouched), or register a new version. A failing image never stops
the others; a rerun finishes the work. Nothing is overwritten or deleted. `manifest.json` is committed (identity + intent);
`import-state.json` (asset IDs, R2 keys, version history) is written by an `apply` run and ignored by git. It is only a record: it is rebuilt from the database after every image, so a failed write or an empty file is healed by the next run (a failed write is reported and makes the exit code 2). Exit code 0 means every image imported or was already in place; failed, invalid and missing source files give 2.

## Migration 0027 (additive)
`imported` column; `import_key` on packs and assets with unique indexes and immutability triggers; `studio_effective` with the imported
layer; `search_tsv` rebuilt (drop and add, which works on PostgreSQL 16 and 17). It fails with a clear message unless 0025 and 0026 are applied.

## Production runbook (each step needs explicit approval)
1. Fresh backup (`pg_dump`, verify with `pg_restore --list`).
2. Apply `drizzle/pg/0027_studio_scene_packs.sql`; verify columns, indexes, triggers, and that the Cafe asset's effective metadata is unchanged.
3. Deploy the application code (it reads the new columns).
4. `check`, then `plan` (review the report: 8 packs to create, 54 images to create, IMG-018 noted as identical to the legacy asset).
5. `apply --owner <uuid> --yes`; verify counts (8 packs, 54 assets, 108 R2 objects) and thumbnails.
6. `archive-legacy --pack-id <Cafe id> --yes`.
7. Review the "Needs review" images in the Repository.
