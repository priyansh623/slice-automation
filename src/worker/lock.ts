import postgres from 'postgres';

// Uses a persistent direct connection (port 5432) for pg_advisory_lock.
// The pooler (port 6543) is transaction-scoped and cannot hold session-level advisory locks.

const ADVISORY_LOCK_KEY = 1n; // bigint advisory lock key

let _sql: ReturnType<typeof postgres> | null = null;
let _lockHeld = false;

function getSql(): ReturnType<typeof postgres> {
  if (!_sql) {
    const url = process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL!;
    if (new URL(url).port === '6543') {
      // A session-level advisory lock does not hold through a transaction pooler. Job claiming in the database still prevents double work.
      console.warn('[worker] DATABASE_DIRECT_URL is not set to a direct connection: the single-worker lock is not reliable.');
    }
    _sql = postgres(url, { max: 1, idle_timeout: 0 });
  }
  return _sql;
}

export async function acquireLock(): Promise<boolean> {
  if (_lockHeld) return true;
  const sql = getSql();
  // pg_advisory_lock_int8 tries immediately; returns true if acquired, false if not
  const rows = await sql`SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}::bigint) AS acquired`;
  _lockHeld = rows[0]?.acquired === true;
  return _lockHeld;
}

export async function releaseLock(): Promise<void> {
  if (!_lockHeld) return;
  const sql = getSql();
  await sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY}::bigint)`;
  _lockHeld = false;
}

export async function closeLockConnection(): Promise<void> {
  if (_sql) {
    await _sql.end();
    _sql = null;
  }
}
