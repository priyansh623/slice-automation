import type { PgDatabase } from 'drizzle-orm/pg-core';
import type * as schema from '../db/schema.pg';

// Any Drizzle Postgres database over the app schema: the app's postgres-js connection in
// production and scripts, an in-memory PGlite database in tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BrollDb = PgDatabase<any, typeof schema>;
