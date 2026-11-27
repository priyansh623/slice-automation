# Before running `stabilisation-recovery.sql`: prove each file exists

A `video_storage_path` in the database and a row in `storage_objects` are records, not proof. Check the object itself.

## 1. Get the keys (read only)

```sql
SELECT g.id, g.video_storage_path AS key,
       coalesce(r.provider, 'supabase') AS registry_says,
       r.size_bytes AS registered_size,
       (o.name IS NOT NULL) AS supabase_has_object,
       (o.metadata->>'size')::bigint AS supabase_size
FROM video_generations g
LEFT JOIN storage_objects r ON r.bucket = 'videos' AND r.key = g.video_storage_path
LEFT JOIN storage.objects o ON o.bucket_id = 'videos' AND o.name = g.video_storage_path
WHERE g.id = ANY (ARRAY[91,137,193,226,228,244,248,250,251,306,330,356,358, 258,261,352])
ORDER BY g.id;
```

As of 26 November: 91, 137, 193, 226, 228 are registered in R2 **and** present in Supabase; 244, 248, 250, 251, 258, 261, 306, 330 are R2 only; 352, 356, 358 are Supabase only. Re-run before relying on this.

## 2. Check the object

- **R2** (registry_says = r2): Cloudflare dashboard → R2 → videos bucket → search the key; or, with read credentials:
  `aws s3api head-object --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com --bucket <R2_BUCKET_VIDEOS> --key '<key>'`
- **Supabase**: Dashboard → Storage → `videos` → the `screen-<n>/` folder.

For each id record: found (yes/no), size in bytes (not zero; matches the registered size where there is one), and **it plays** (open it).
If R2 cannot be reached because of the current R2 problem, wait; do not assume.

## 3. Decide

- Found and plays → keep the id in the list.
- Missing, empty or unplayable → remove the id from the SQL list. Leave that row as failed.

## 4. After running

Open two repaired scenes in the app: the take appears and plays. Approvals are unchanged.
