/**
 * Connection settings for postgres.js, decided from the connection string.
 *
 * `prepare: false`: the application connects through Supabase's TRANSACTION pooler (port 6543), which hands each transaction to any server
 * connection. Prepared statements belong to one server connection, so they are not supported there (Supabase and postgres.js both say to turn
 * them off). A direct or session-mode connection keeps them.
 * `connect_timeout` 10 s and `idle_timeout` 20 s are unchanged. `max_lifetime` replaces connections after 10 minutes, so a serverless instance
 * that was frozen and woken does not keep using a connection the pooler has long dropped. The server's own statement timeout (2 minutes) is
 * left as it is: the pooler does not reliably accept per-connection settings.
 */
export function connectionOptions(connectionString: string) {
  let transactionPooler = false;
  try {
    const url = new URL(connectionString);
    transactionPooler = url.port === '6543' || url.searchParams.get('pgbouncer') === 'true';
  } catch { transactionPooler = false; }
  return { max: 10, idle_timeout: 20, connect_timeout: 10, max_lifetime: 10 * 60, ...(transactionPooler ? { prepare: false } : {}) };
}

/**
 * The web app uses DATABASE_URL (transaction pooler). The long-running worker uses DATABASE_DIRECT_URL (session mode) when it is set:
 * through the transaction pooler its queries were answered by the server but never reached the worker, which stopped its loops.
 * The session pooler allows few clients, so the worker keeps a smaller pool (the lock holds one more connection).
 */
export function databaseTarget(env: Record<string, string | undefined>, entry: string | undefined): { url: string; max?: number } {
  const isWorker = /[\\/]worker[\\/]index\.[cm]?[jt]s$/.test(entry ?? '');
  if (isWorker && env.DATABASE_DIRECT_URL) return { url: env.DATABASE_DIRECT_URL, max: 8 };
  return { url: env.DATABASE_URL! };
}
