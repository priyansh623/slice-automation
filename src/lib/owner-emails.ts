/**
 * Who owns a project, for display. Projects are shared across the team, so the list shows each creator's email, not the viewer's.
 * Looked up with the service key (as the admin dashboard does), cached for a few minutes, and never allowed to fail or slow a request badly:
 * if it cannot be read the owner is simply unknown ('-' on the page), except the viewer's own projects.
 */
import { createServiceClient } from '@/lib/supabase/server';

const TTL_MS = 5 * 60_000;
const LOOKUP_TIMEOUT_MS = 3_000; // the list must not wait on a slow auth service; names are decoration
let cache: { at: number; byId: Map<string, string> } | null = null;

export const resetOwnerEmailCacheForTests = () => { cache = null; };

async function load(): Promise<Map<string, string>> {
  const client = createServiceClient();
  const byId = new Map<string, string>();
  for (let page = 1; ; page++) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    for (const u of data.users) if (u.email) byId.set(u.id, u.email);
    if (data.users.length < 200) return byId;
  }
}

export async function ownerEmails(userIds: string[], viewer: { id: string; email?: string | null }, now = Date.now()): Promise<Map<string, string>> {
  const needed = [...new Set(userIds)];
  const known = () => needed.every((id) => cache?.byId.has(id) || id === viewer.id);
  if (!cache || now - cache.at > TTL_MS || !known()) {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const byId = await Promise.race([load(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), LOOKUP_TIMEOUT_MS); })]).finally(() => clearTimeout(timer));
      cache = { at: now, byId };
    } catch (err) {
      console.warn('[owners] could not read user emails:', (err as Error).message.slice(0, 120));
    }
  }
  const out = new Map<string, string>();
  for (const id of needed) { const email = cache?.byId.get(id) ?? (id === viewer.id ? viewer.email : null); if (email) out.set(id, email); }
  return out;
}
