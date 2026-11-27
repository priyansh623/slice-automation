import { describe, it, expect } from 'vitest';
import { connectionOptions, databaseTarget } from '@/db/options';

describe('database connection options', () => {
  it('turns prepared statements off for the transaction pooler, and only there', () => {
    expect(connectionOptions('postgres://u:p@aws-0-eu.pooler.supabase.com:6543/postgres?pgbouncer=true')).toMatchObject({ prepare: false });
    expect(connectionOptions('postgres://u:p@db.ref.supabase.co:5432/postgres')).not.toHaveProperty('prepare');
    expect(connectionOptions('not a url')).toMatchObject({ max: 10, connect_timeout: 10 });
  });
});

describe('which database connection a process uses', () => {
  const env = { DATABASE_URL: 'postgres://u:p@h:6543/db', DATABASE_DIRECT_URL: 'postgres://u:p@h:5432/db' };
  it('gives the worker the session connection and everything else the pooled one', () => {
    expect(databaseTarget(env, '/opt/render/project/src/src/worker/index.ts')).toEqual({ url: env.DATABASE_DIRECT_URL, max: 8 });
    expect(databaseTarget(env, '/var/task/server.js')).toEqual({ url: env.DATABASE_URL });
    expect(databaseTarget({ DATABASE_URL: env.DATABASE_URL }, '/x/src/worker/index.ts')).toEqual({ url: env.DATABASE_URL });
  });
});
