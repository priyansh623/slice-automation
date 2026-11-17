import { NextResponse } from 'next/server';
import { requireProject, requireUser, type AuthUser } from '@/lib/api-auth';
import { OverlayError, overlaysEnabled } from './service';

/** Shared guard for every overlay route: feature flag (404 when off), signed-in user, existing project. */
export async function overlayGuard(params: Promise<{ id: string; oid?: string }>): Promise<{ user: AuthUser; projectId: number; overlayId?: number } | NextResponse> {
  if (!overlaysEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  const p = await params;
  const projectId = parseInt(p.id, 10);
  if (!Number.isInteger(projectId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const project = await requireProject(projectId);
  if (project instanceof NextResponse) return project;
  let overlayId: number | undefined;
  if (p.oid !== undefined) { overlayId = parseInt(p.oid, 10); if (!Number.isInteger(overlayId)) return NextResponse.json({ error: 'Invalid overlay id' }, { status: 400 }); }
  return { user: auth.user, projectId, overlayId };
}

export const overlayErrorResponse = (err: unknown): NextResponse => {
  if (err instanceof OverlayError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  throw err;
};

export const intOrUndef = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);
