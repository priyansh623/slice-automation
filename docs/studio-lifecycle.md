# Character B-roll Studio: lifecycle and cost controls

Operational notes for migrations 0025 and 0026. Neither migration is applied anywhere yet; apply BOTH (in order) before deploying
the code, with explicit approval.

## Removing stored files (R2)
A stored file is only deleted through `discardIfUnreferenced` (`src/lib/studio/references.ts`):
1. one transaction takes the key's exclusive advisory lock, checks every reference (assets, thumbnails, characters including
   replaced ones, batch/job snapshots, outputs) and records a permanent tombstone in `studio_deleted_keys`;
2. only then is the object deleted from R2 (idempotent; a failed delete is retried by `retryPendingRemovals`);
3. a trigger refuses to register any tombstoned key, so a registration cannot slip in between the check and the delete.

Every upload key is recorded in `studio_upload_intents` before its link is signed. The worker's housekeeping (every 15 minutes)
removes intents still `issued` whose link expired more than 24 hours ago, through the same safe path. Nothing is listed in R2.

## Provider submissions
`submit_unknown` means the provider may have received the job. It is never resent blindly. See `src/lib/studio/provider.ts` for
the contract a real provider must follow (`ProviderError.outcome`, `idempotentSubmit`, `findSubmission`). Limitation: for a
provider without idempotency or lookup, exactly-once submission is impossible; an unknown job waits for a late answer or for a
person to confirm "Generate again anyway" (which may be charged twice).

## Web / worker consistency
`STUDIO_PROVIDER` must have the same value on the web app and on the worker. The worker reports its value, R2 readiness and
switches to `studio_worker_status` every 30 seconds; the web app refuses to create a batch when no worker reported in the last
90 seconds, when providers differ, or when the worker is not ready. `GET /api/v1/studio/config` shows the state. Never set
`STUDIO_PROVIDER=mock` in production: mock output is labelled "TEST" everywhere it is displayed.

## Analysis budget
`STUDIO_ANALYSIS_BUDGET_PER_HOUR` (default 600, 0 = no limit) is counted per UTC hour in `studio_budget_usage`, atomically, across
all workers and restarts. A unit is reserved before an image is claimed; it is refunded if nothing was sent to the model (nothing
to analyse, original unreadable, reduction failed); failed model calls and attempts cut off by a shutdown stay counted. When the
hour's budget is used up, images stay pending. Usage is visible in `GET /api/v1/studio/config` (`analysisBudget`) and in each
worker's status row.
