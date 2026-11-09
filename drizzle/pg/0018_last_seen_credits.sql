ALTER TABLE "admin_settings"
  ADD COLUMN IF NOT EXISTS "last_seen_credits" integer,
  ADD COLUMN IF NOT EXISTS "last_seen_credits_at" bigint;
