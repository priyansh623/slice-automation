# AI-assisted bulk B-roll upload

How the feature works, exactly what leaves the browser, and what is kept where. Written from the code, not from intent.

## 1. Workflow

1. Select or drop videos. Nothing is uploaded.
2. The browser reads each video (see section 2), checks it, fingerprints it (SHA-256) and asks the server for a suggestion.
3. Review the whole batch (grid or one clip at a time), edit with the controlled inputs, bulk-edit selected clips.
4. Explicitly approve the batch. Only now are videos uploaded, straight to R2 (presigned PUT), verified and recorded.
5. A new category is a separate explicit action (confirm dialog) that calls the existing `POST /api/v1/broll/categories`.

## 2. AI data flow (what is sent, where, and what is stored)

| Question | Answer |
|---|---|
| Where are the 4 frames extracted? | In the browser: a `<video>` element opens the file through an object URL (the browser streams it; the file is not read into memory) and 4 frames at 8 %, 30 %, 55 % and 80 % of the duration are drawn to a canvas (longest edge 640 px) and encoded as JPEG (quality 0.72, roughly 40-100 KB each). Re-encoding through a canvas drops EXIF/metadata. |
| Browser to Anthropic directly? | No. Browser -> our server (`POST /api/v1/broll/bulk/analyze`, HTTPS, JSON with base64 JPEGs) -> Anthropic Messages API, called server-side with `ANTHROPIC_API_KEY`. The key never reaches the browser. |
| Exactly what is in the Anthropic request? | `model`, `max_tokens`, one `system` prompt, one tool definition (`tool_choice: auto`; a forced choice is rejected by `claude-sonnet-5-5`), and one user message. The system prompt holds the labelling rules and the approved vocabulary: category ids and paths, approved activities and settings, known brand names, and the 200 most used tags (library content, no personal data). The user message holds, per frame, a text label ("Frame 2 of 4") and the image, then one text line: `Video: <seconds> s, <width>x<height>. Record the metadata.` There is no `metadata`/`user_id` field. A test (`broll-bulk-analyzer-http.test.ts`) asserts this exact shape. |
| File names, original video, checksum, user, clip ids? | Not sent. The browser does not include the file name in the request and the route ignores any extra field; a test sends a file name and checks it never reaches the provider. The full video is never sent. |
| Do we log frames or payloads? | No. The only log line in the analysis path records the error class and HTTP status, never message text (provider errors can quote request details). A test fails the model call and checks nothing sensitive is logged. We add no request-body logging; whether your hosting platform logs request bodies on your plan/log drains was not verified. |
| Does our server persist frames? | No. Nothing is written to R2, Supabase, the filesystem or any table during analysis (tested: table counts and R2 are unchanged). Frames exist only in the request's memory. |
| What does the browser keep? | In memory: the frames and thumbnails for the open batch (needed to retry an analysis). In `localStorage`, for 24 hours: (a) an analysis cache keyed by the file's SHA-256 and (b) a recovery snapshot of your edits. Both are stored redacted: no video, no frames, no thumbnails, no text read from the footage, no summary, no privacy detail text. Privacy warning types and severities are kept so warnings still show. |
| Is anything stored in R2 or Supabase because of the analysis? | No. |
| Privacy warnings | Unchanged: they never block an upload and nothing is blurred, redacted or deleted. |

### What Anthropic does with the images (verified vs not)

Checked on 2026-11-15 against the two official pages: the Claude Platform doc "API and data retention" and the Privacy Center article "How long do you store my organization's data" (dated July 1, 2026). They are **not fully consistent**:

- Privacy Center: "For Anthropic API users, we automatically delete inputs and outputs on our backend within 30 days of receipt or generation", with exceptions (longer-retention services such as the Files API, usage-policy enforcement, legal requirements).
- Platform doc: conversation content "is not retained by default", except for "Covered Models", which require 30-day retention. It also says: "Retained data is never used for model training without your express permission." Zero data retention (ZDR) is an opt-in agreement per organisation.
- The default model here is `claude-sonnet-5-5`. The platform doc lists the Covered Models as the Fable 5.x and Mythos 5.x families, which does not include it, but that list can change.

**Not verified:** how images specifically are treated (neither page says), whether your organisation has a ZDR agreement, and the exact training position for commercial API data beyond the sentence above. Do not state that submitted frames are not retained until your Anthropic organisation settings or account team confirm it. Sources: https://platform.claude.com/docs/en/manage-claude/api-and-data-retention and https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data

## 2b. How the AI is told to classify and rate privacy

Checked against the real model (claude-sonnet-5-5) on representative footage; results vary a little between runs, so treat suggestions as proposals for the reviewer.

- **Categories.** The model is told to choose by the main subject and what is happening, never by a word shared with a category name, to read each category through its parent, not to treat packaging as a payment card, to compare the closest options, and to return `category_id: null` with a separate `proposed_category` when only a loosely related broad parent exists. Categories are never created by analysis. Found by the real test: the category names carry no descriptions, so a shared word ("reveal") once pulled a shoe-box clip into a card category; the instructions now prevent this.
- **Privacy severity.** The model separates (1) a person visible, (2) a person identifiable, (3) sensitive information legible. Faces: high when identifiable and the main subject or with other personal information; medium when clearly identifiable; low when distant, small, blurred, turned away or occluded. Information: financial information and travel or identity documents are high; names, phone numbers, emails and addresses are medium or high. Each warning's `detail` must say what is visible and why it has that severity, without repeating personal data.
- **Deterministic floors.** Whatever the model says, `financial_info`, `payment_details` and `travel_document` are never below high, and `name`, `phone`, `email`, `address` and `receipt` never below medium. Nothing is ever lowered, and faces have no floor.
- **Limitation: sampling.** Only 4 frames are analysed. A face that is clear at a moment between those frames is not seen, and a face covered in the sampled frames is correctly rated low. If faces matter, sampling more frames is the lever (more cost).
- **Warnings never block, blur or delete anything.**

## 3. Integrity and duplicates

- **Checksum verification, every size.** The bulk uploader always sends the SHA-256 of the selected file (it is mandatory in bulk mode). `POST /api/v1/broll/upload/complete` streams the object from R2 through SHA-256 (constant memory, tested on a full 500 MB), checks the byte count against the stored size, and records nothing unless the digest matches. A mismatch removes the new object and returns 422. A read that exceeds 45 s returns 504 and keeps the upload so a retry only repeats the check. The one-video manual form is unchanged and sends no checksum.
- **Exact duplicates, enforced on the server.** After verification, a file whose SHA-256 equals another clip's recorded checksum is refused with 409 (`code: duplicate`), naming the clip, unless the reviewer explicitly chose "Upload anyway". The check runs under a lock, so two identical files completing together still produce one clip. The page also warns earlier (library, same batch, and previously uploaded in the same or an earlier visit).
- **Older clips.** Clips created before checksums were recorded (clips 34-105: 72 clips, 353,783,171 bytes) have no checksum in the registry, so they cannot be recognised until it is filled in. See the backfill proposal below. Until then a same-size clip is only a warning.

### Checksum backfill (proposal, not executed in production)

- **Records:** every clip whose `storage_objects` row (bucket `uploads`) has `sha256 IS NULL`: clips 34, 35, 36 (earlier test uploads) and 37-105 (the 69 imported clips). All 72 are on R2 and their registry sizes match the clip sizes. Query: `scripts/broll-checksum-backfill.ts` (list mode).
- **Process (read-only):** `npx tsx scripts/broll-checksum-backfill.ts --verify` streams each object from R2 through SHA-256 and compares the byte count with the registry and clip sizes. A read-only run on 2026-11-15 hashed all 72 in 2 min 27 s with 0 failures and 0 size mismatches, and the checksums for the 69 imported clips equal the SHA-256 values recorded and verified when they were imported (`--expected`). Nothing was written.
- **The only database write:** `UPDATE storage_objects SET sha256 = $1, verified_at = $2, updated_at = $2 WHERE bucket='uploads' AND key=$3 AND sha256 IS NULL`, via `--execute`. It never replaces an existing checksum, never touches clip rows, and never changes, deletes or uploads any object. Safe to re-run.
- **Cost:** about 337 MiB (353,783,171 bytes) read once from R2: 72 GET requests, no R2 egress fee, no Supabase involvement, no AI calls. Run time is minutes.
- **Approval needed** before `--execute` on production.

## 4. Recovery after a refresh

Videos cannot be kept by the browser, so recovery is a re-selection. While you work, a redacted snapshot (24 h) of each analysed video is kept in `localStorage`, keyed by SHA-256. On return the page lists what was kept (analysed / reviewed / uploaded / upload not finished). Selecting the same files again restores their analysis and edits without calling the AI. Recovery never uploads anything, never creates a record and never counts as approval: you approve the upload again. Videos already uploaded come back as "Already uploaded as clip #n" and are left out of the batch. A video whose file reached storage but whose save failed keeps its storage path, so approving again only repeats the save. Entries expire after 24 hours; values that no longer exist in the taxonomy are cleared. Saved work can be discarded at any time.

Limits: nothing is shared across browsers or devices; clearing site data removes it; a video that was mid-transfer when the page closed is simply uploaded again (the partial object is never referenced).

## 5. Configuration

- `ANTHROPIC_API_KEY` (existing; required for analysis). Never commit it.
- `BROLL_ANALYSIS_MODEL` (optional; default `claude-sonnet-5-5`).
- No other variable is new. R2 and database settings are unchanged.

### Real-model smoke test

`npx tsx scripts/broll-bulk-analyze.ts <video.mp4> [more...]` reads the approved taxonomy, samples 4 frames per video, calls the real model and prints the validated suggestion. It uploads nothing and writes nothing. Suggested set: a food scene, a visible brand, a person's face, financial or personal information on screen, footage no category fits, and one large file.
