# B-roll overlays (Generic and Character B-roll on the Flow timeline)

Status: implemented on branch `feature/broll-overlays`, **not deployed, not committed**. Migration `0028` has **not** been applied anywhere except throwaway test databases.

## What it is
Flow scenes stay the primary video and keep their own embedded narration. B-roll is a silent **overlay** placed over Flow footage, positioned relative to a Flow scene (anchor scene + offset), never a scene. `video_screens` / `video_generations` are untouched.

## Deploy order (when approved)
1. Apply `drizzle/pg/0028_broll_overlays.sql` (done) and then `drizzle/pg/0029_broll_selection.sql` (additive, idempotent, no rewrites of existing rows).
2. Deploy web + worker. Without the flag the new code paths are inert, and the compile worker does not query overlay tables unless they exist.
3. Set `BROLL_OVERLAYS_ENABLED=true` on web **and** worker when ready.

## B-roll selection before generation (migration 0029)
Order of the workflow: Details, Breakdown, **B-roll selection** (`/video-projects/[id]/broll`), the existing Generation screens, Composition, Compile, Review. Nothing about Flow, Grok, Kling, the workers, storage, approval, retry or audio changed.

- **Selection is IDs only**, in `video_projects.broll_selection` (nullable JSONB): `generic: [{clipId, screenId, overlayId?}]`, `character: [{assetId, screenId, action, itemId?, overlayId?}]`. Saving it (`PUT /broll-selection`) creates no overlay, no item, no job and costs nothing. Revisiting any screen costs nothing.
- **Suggestions** never select anything. Generic: word match of each scene's dialogue against the library's own tags, subjects, activity, category, title and summary (`lib/overlays/recommend-generic.ts`, no AI). Character: the existing Studio recommender (`lib/studio/recommend.ts`, one model call, only when the person presses the button).
- **Character B-roll runs on the existing Generation screen**: the header button "Character B-roll (n)" lists the picked images. Pressing "Make the personalised image" starts the existing process (`startCharacterPick` -> `createCharacterItem`, one item and one job; a double click cannot start two). The existing item card (`components/CharacterItemCard.tsx`, the only place these controls exist; Composition only shows finished clips and edits placement) does personalise -> approve -> motion prompt -> 5 s Kling video, unchanged.
- **Composition fills itself** (`POST /overlays/populate`, safe to repeat): library clips right away; Character clips once their video is ready. Each pick gets at most one overlay (the overlay id is written back to the pick), a clip the person removed does not come back, and a scene that was deleted is reported, never re-attached.
- **`video_overlays.placement_source`** is `auto` for overlays the system placed and `manual` for anything a person placed or edited (any edit, including replace, sets `manual`). Automatic arrangement (`lib/overlays/arrange.ts`: spread evenly inside the clip's own scene, snapped to 0.1 s, routing around manual clips) only ever moves `auto` overlays. Existing overlays default to `manual`.
- **Migration 0029** is additive: `video_projects.broll_selection JSONB NULL`, `video_overlays.placement_source TEXT NOT NULL DEFAULT 'manual'` with a CHECK. Apply it BEFORE deploying the code: `brollSelection` is declared on `videoProjects`, so every query that selects that table's columns needs the column to exist.

## Providers (final decision)
Image personalisation: **Grok Imagine 2.0** (`xai/grok-imagine-image-2.0`) through the Higgsfield API. Video: **Kling 3.0 Standard** (`kling-video/v3.0/std/image-to-video`), 5 s, sound off. No other provider is used or substituted.

| Step | Request (verified against docs.higgsfield.ai; not against the live service) |
|---|---|
| Upload input | `POST /files/generate-upload-url {content_type}` -> `{public_url, upload_url, upload_headers}`; `PUT upload_url` with every `upload_headers` entry and **no** credentials |
| Image | `POST /xai/grok-imagine-image-2.0 {prompt, image_urls:[scene, character], resolution:"2k", aspect_ratio:"auto", quality:"medium"}`; result `images[0].url` |
| Video | `POST /kling-video/v3.0/std/image-to-video {image_url, prompt, duration:5, sound:"off"}`; result `video.url` |
| Poll | `GET /requests/{id}/status` -> queued, in_progress, completed, failed, nsfw, canceled |
| Both submits | header `Idempotency-Key` (replay returns the original request; same key + different body = 422), header `Authorization: Key ID:SECRET` |

The image prompt is exactly: `Image 1 is the master image.\nImage 2 is the master model.\nReplace the model in the master image with the master model.` Image 1 = Scene Pack image, image 2 = the project's master character.

## Lifecycle
* **Image job** = a Studio job (`studio_jobs`), run by the existing Studio worker: queued -> submitting -> processing -> succeeded|failed, plus `submit_unknown` (outcome not known).
* **Video job** = a `character_broll_items` clip (separate state machine, separate worker, separate retry): queued -> submitting -> processing -> ready (or submit_unknown / failed).
* The approval gate is between them: API check + service check + DB CHECK `character_broll_video_needs_approved_image`.

## Duplicate generations: what we guarantee and what depends on Higgsfield
Higgsfield documents that the same `Idempotency-Key` returns the original request ("replay"), that the same key with a different body is a 422, and that a request rejected before acceptance does not consume the key. It does **not** document how long a key is remembered, and offers no way to look up or list requests by key.

**We therefore do NOT claim duplicate billing is impossible, and neither provider declares idempotent submits.**

Guaranteed by our code (independent of Higgsfield):
* A job is submitted at most once by the system. A worker restart never submits again: a job found mid-submit becomes `submit_unknown`; a job with a provider request id is only polled.
* Before anything is submitted the uploaded input URLs, the endpoint, a SHA-256 of the exact body and the time are persisted (`studio_jobs.request` / `character_broll_items.clip_probe`), and the idempotency key is deterministic per job/attempt. The request id is persisted as soon as it is returned.
* A lost answer, a 5xx, a timeout or a dropped connection on submit become **outcome unknown**. Nothing resends them. They wait for a person. They do not hold up other jobs.
* The person is told what to check (the Higgsfield generation history around that time) and may choose "generate again anyway (could be charged twice)". That creates a NEW job/attempt with a new key and fresh uploads, closes the old one (never deletes it) and is the only way a second generation can follow an unknown one.
* Hourly caps (`HIGGSFIELD_IMAGE_BUDGET_PER_HOUR`, `HIGGSFIELD_BUDGET_PER_HOUR`) bound the damage of any bug.

Depends on Higgsfield (not guaranteed by us): that an accepted request is charged once; that failed/nsfw/canceled requests are not charged (documented, unverified live); that a replayed key would be deduplicated (we never rely on it).

Known gap: if Higgsfield accepts a request and the answer is lost, we cannot learn the request id (no lookup by key), so the paid generation completes unseen at Higgsfield until a person looks. That is the price of never auto-resending.

Bounded retries: a 429 `account_queue_full` or 423 (model temporarily blocked) re-queues the SAME job after Retry-After / 60 s, at most 20 times, then fails. Polling errors are retried until the job's maximum age (Studio 2 h, video 45 min). Failed, canceled and nsfw end the job; nsfw is not retryable.

## Reference images: privacy and URL handling (from docs.higgsfield.ai; nothing here is invented)
* Inputs must be **public HTTPS URLs**. Presigned/non-public URLs are not documented as supported (not used). Base64 is not documented.
* `POST /files/generate-upload-url` returns a `public_url`. The docs do not say it needs no credentials, who can open it, or when it expires. The upload URL expires in one hour. Uploaded files are "stored independently of a single request and are deleted within seven days". The `x-amz-tagging: retention=temporary` header is not explained.
* There is **no documented per-file delete** for uploads. `DELETE /requests/{id}` removes what Higgsfield stored for a request (its input copies, output, prompt, parameters) and keeps billing records; it is documented not to cover standalone uploads.
* Implemented: the documented upload is used (the only supported way to supply a private image); images are uploaded immediately before the submit, never reused across jobs, never sent to the browser (the stored URLs and the idempotency key are stripped from every API response); after our own copy is stored, `DELETE /requests/{id}` is called (best effort; `HIGGSFIELD_DELETE_AFTER_STORE=off` disables it). R2 access controls are unchanged.
* Implication: anyone holding a `public_url` could fetch the image until Higgsfield deletes it (up to 7 days is the only documented bound). The master character and scene image are exposed this way for the life of the upload. If that is not acceptable, the alternative (presigned R2 URLs) is undocumented by Higgsfield and would need their confirmation first.

## Image dimensions and aspect ratio
* Grok returns 1504 x 2752 (ratio 0.546, slightly narrower than 9:16 = 0.5625). The image is stored in R2 **byte-for-byte as received**: no resize, crop or re-encode. Its size is recorded.
* Review: a small WebP thumbnail (fit inside 480 px, proportions kept) is listed; clicking opens the original, whole, `object-fit: contain`. The review box takes the image's own proportions.
* Approval does not change the file. Kling receives the approved original (checked byte-for-byte in tests).
* Generated clips: the existing normalisation covers 720 x 1280 and crops the overflow. For a 1504 x 2752 source that is a uniform scale of 0.479 and about 1.4% of the height cropped (a square stays square, no bars; tested). The original image is never altered. Kling's own output size/aspect is undocumented: whatever it returns is probed and normalised the same way.

## Where image data moves (egress)
All Scene Pack, master-character and generated-image files are in **R2** (`uploads` bucket), never Supabase.
1. Worker reads scene + character from R2.
2. Worker uploads both to Higgsfield's presigned storage (no API credentials on that request).
3. Higgsfield CDN -> worker -> **R2** (`putR2Only`): the 2K PNG plus a small WebP thumbnail, immediately. Then the Higgsfield copy is deleted. The Higgsfield link is never used again.
4. Browser review: R2 signed URLs (thumbnail in the list, original on click). No Higgsfield URL reaches the browser.
5. Approval: worker reads the approved image from R2, uploads it once for Kling.
6. Kling result: Higgsfield CDN -> worker -> normalised silent 720x1280 clip -> `getStorage().put('videos', ...)`, which follows the existing `STORAGE_WRITE_PROVIDER` (the rule compilations use). The provider's original file is stored once beside it.
Supabase egress: none for the image path; video files touch Supabase only if `STORAGE_WRITE_PROVIDER` is not `r2`.

## Provider configuration and credentials
* `STUDIO_PROVIDER=higgsfield` on **web and worker**. The web app only needs the name (it never calls Higgsfield). `HF_CREDENTIALS` on the **worker only**.
* Only worker-side modules read `HF_CREDENTIALS` or build a provider (enforced by a test that scans all web code).
* A worker without credentials reports itself not ready: new image batches are refused (503 `worker_not_ready`), queued jobs are not submitted, and video requests are refused (503 `video_unavailable`). The worker reports its video provider with its Studio status; the Composition page shows the reason.
* Mock development keeps working with no paid access: `STUDIO_PROVIDER=mock` + `CHARACTER_CLIP_PROVIDER=mock`.

## Environment variables
| Variable | Where | Purpose |
|---|---|---|
| `BROLL_OVERLAYS_ENABLED` | web + worker | Feature flag. Off: overlay routes return 404, compile is unchanged. |
| `BROLL_OVERLAY_LIMIT` | web | Max overlays per project (default 20). |
| `STUDIO_PROVIDER=higgsfield` | web + worker | Personalised images through Grok Imagine 2.0. (`mock` for local development.) |
| `HF_CREDENTIALS` | **worker only** | `KEY_ID:KEY_SECRET`. Never in the frontend or committed. Without it a worker reports itself not ready and nothing is submitted. |
| `HIGGSFIELD_IMAGE_BUDGET_PER_HOUR` | web | Max personalised images started per hour (default 30, 0 = unlimited). |
| `HIGGSFIELD_BUDGET_PER_HOUR` | web | Max Character videos started per hour (default 20). |
| `HIGGSFIELD_VIDEO_ENDPOINT` | worker | Default `kling-video/v3.0/std/image-to-video`. Never defaults to Turbo. |
| `CHARACTER_CLIP_PROVIDER` | worker | `mock` for local development; unset + `HF_CREDENTIALS` = real Kling. |
| `HIGGSFIELD_DELETE_AFTER_STORE` | worker | `off` keeps Higgsfield's copy of a finished request (default: delete it once ours is stored). |
| `HIGGSFIELD_BASE_URL`, `HIGGSFIELD_TIMEOUT_MS` | worker | Optional (tests, proxies). |

## Behaviour that must hold
* Overlays never contribute audio; the compositor copies the Flow audio stream untouched and keeps the video length.
* A deleted anchor scene flags the overlay "needs attention"; it is never silently moved. Compile is refused until it is moved or removed.
* A compilation freezes its overlays; later edits never change an earlier version.
* Character video generation cannot start without an **approved** personalised image. Video requests are paid; each is submitted once and its request id persisted first.

## Known limitations
* No live Higgsfield call has been made. Everything is verified against a local fake that follows the public documentation, not the real service.
* Not documented by Higgsfield: idempotency-key retention and lookup, `public_url` accessibility/expiry, the meaning of `retention=temporary`, per-file deletion, fetch behaviour and requirements for reference URLs (redirects, size, content type), the error for an unreachable reference URL (probably a generic `failed`), base64 input, a seed, and Kling's output size.
* Polling follows our own backoff (Studio 3 s growing to 60 s; video 5 s to 30 s), slower than the 2 s to 10 s the docs suggest. Results are therefore noticed a few seconds later; this was kept to limit load.

## Known pre-existing test issues (verified at baseline 2f647ed, not caused by this work)
- `studio-postgres.concurrency.test.ts` > "touches no table that existed before" fails on a real PostgreSQL (`TEST_POSTGRES_URL`): it builds a comparison database without migrations 0025-0027 but still applies 0028, which requires them. It fails identically on a clean checkout of 2f647ed. Fix when convenient by also excluding 0028 and later from the probe database (and comparing only up to 0027).
- `signed-url-cache-route.integration.test.ts` has 26 TypeScript errors (TS2352: the test casts the typed database handle to `Record<string, unknown>`). They are identical at baseline and are test-only; `tsc --noEmit` reports exactly those 26 and nothing else.
