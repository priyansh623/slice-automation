# Deployment guide — `deploy` branch

## 1. Supabase: run migrations

Run migrations in order against your production Supabase project.

```bash
# From the project root, with DATABASE_URL set to the direct (port 5432) connection
npx drizzle-kit migrate
```

Or apply each file manually via the Supabase SQL editor in order:
`drizzle/pg/0001_initial_schema.sql` → `0010_worker_claimed_at.sql`

### Storage buckets

Create three buckets in Supabase Dashboard → Storage:
- `uploads` (private) — base reference images
- `videos` (private) — generated video clips
- `compilations` (private) — FFmpeg-compiled output

### Users

There are no roles. Every signed-in user has the same access, including `/admin/settings`, the dashboard and the connection-test endpoint.

---

## 2. Vercel (Next.js app)

**Connect repo:** New Project → import this repo → select the `deploy` branch as the production branch.

**Framework preset:** Next.js (auto-detected).

**Build & Output Settings:** leave at defaults (`npm run build` / `.next`).

**Environment variables** (Settings → Environment Variables):

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://your-ref.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon/public key from Supabase API settings |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key (server-only) |
| `DATABASE_URL` | pooler URL — `postgres://postgres.REF:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres` |
| `ANTHROPIC_API_KEY` | your Anthropic API key |
| `USEAPI_TOKEN` | your useapi.net token |
| `GOOGLE_FLOW_EMAIL` | Google account email registered with useapi.net |
| `SUPABASE_BUCKET_UPLOADS` | `uploads` |
| `SUPABASE_BUCKET_VIDEOS` | `videos` |

> `DATABASE_DIRECT_URL` is **not** needed on Vercel — the pooler URL (port 6543) is correct for serverless functions.

**Deploy:** push to the `deploy` branch (or trigger manually).

---

## 3. Railway (worker process)

**New Project → Deploy from GitHub repo → select `deploy` branch.**

Railway detects `railway.toml` and `Dockerfile.worker` automatically.

**Environment variables** (same as Vercel, plus the direct DB URL):

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | same as Vercel |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same as Vercel |
| `SUPABASE_SERVICE_ROLE_KEY` | same as Vercel |
| `DATABASE_URL` | pooler URL (port 6543) — used for all non-lock DB calls |
| `DATABASE_DIRECT_URL` | direct URL (port 5432) — **required** for `pg_advisory_lock` |
| `ANTHROPIC_API_KEY` | same as Vercel |
| `USEAPI_TOKEN` | same as Vercel |
| `GOOGLE_FLOW_EMAIL` | same as Vercel |
| `SUPABASE_BUCKET_VIDEOS` | `videos` |

**Singleton enforcement:** `pg_advisory_lock(1)` prevents two worker instances from running simultaneously. Railway's restart-on-failure policy (configured in `railway.toml`) handles crashes.

---

## 4. Verify

1. Visit your Vercel URL → redirected to `/login` ✓
2. Sign in → see video projects list ✓
3. Visit `/admin/settings` → run connection tests → all green ✓
4. Create a project → worker picks it up within 5 s and starts prompt generation ✓
