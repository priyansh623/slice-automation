import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.pg';
import { connectionOptions, databaseTarget } from './options';

// Uses the Supabase pooler URL (port 6543, transaction mode) for serverless/Next.js.
// The worker uses the session-mode connection (port 5432) for its queries and its advisory lock.
const target = databaseTarget(process.env, process.argv[1]);

const client = postgres(target.url, { ...connectionOptions(target.url), ...(target.max ? { max: target.max } : {}) });

export const db = drizzle(client, { schema });

// Type helper for transactions
type TransactionCallback = Parameters<(typeof db)['transaction']>[0];
export type Tx = Parameters<TransactionCallback>[0];
