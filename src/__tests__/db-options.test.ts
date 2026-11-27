import { describe, it, expect } from 'vitest';
import { connectionOptions } from '@/db/options';

describe('database connection options', () => {
  it('turns prepared statements off for the transaction pooler, and only there', () => {
    expect(connectionOptions('postgres://u:p@aws-0-eu.pooler.supabase.com:6543/postgres?pgbouncer=true')).toMatchObject({ prepare: false });
    expect(connectionOptions('postgres://u:p@db.ref.supabase.co:5432/postgres')).not.toHaveProperty('prepare');
    expect(connectionOptions('not a url')).toMatchObject({ max: 10, connect_timeout: 10 });
  });
});
