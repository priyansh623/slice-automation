import { NextResponse } from 'next/server';
import { db } from '@/db';
import { requireUser } from '@/lib/api-auth';
import { loadTaxonomy } from '@/lib/broll-bulk/taxonomy-server';

/** The approved vocabulary for the bulk upload screens (read-only). */
export async function GET(): Promise<NextResponse> {
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json(await loadTaxonomy(db), { headers: { 'Cache-Control': 'no-store' } });
}
