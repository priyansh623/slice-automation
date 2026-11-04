-- Admin users table: stores Supabase Auth UIDs that have admin access.
-- The ADMIN_USER_IDS env var acts as a super-admin bootstrap fallback.
CREATE TABLE IF NOT EXISTS admin_users (
  id        SERIAL PRIMARY KEY,
  user_id   UUID NOT NULL UNIQUE,
  email     TEXT NOT NULL,
  added_at  BIGINT NOT NULL
);

-- Only the service role (server-side) may read or write this table.
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON admin_users USING (false);
