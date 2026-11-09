import { NextResponse } from 'next/server';
import { db } from '@/db';
import {
  videoProjects,
  videoScreens,
  videoGenerations,
  videoCompilations,
  screenPromptVersions,
} from '@/db/schema.pg';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { requireAdmin, requireUser } from '@/lib/api-auth';
import { eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm';

export async function GET(req: Request): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;
  const adminError = await requireAdmin(authResult.user.id);
  if (adminError) return adminError;

  const { searchParams } = new URL(req.url);
  const showArchived = searchParams.get('archived') === '1';

  // ── Fetch projects (archived excluded by default) ─────────────────────────
  const projects = await db
    .select()
    .from(videoProjects)
    .where(showArchived ? isNotNull(videoProjects.archivedAt) : isNull(videoProjects.archivedAt))
    .orderBy(sql`${videoProjects.createdAt} DESC`);
  if (projects.length === 0) return NextResponse.json([]);

  const projectIds = projects.map((p) => p.id);

  // ── Aggregate screens per project ─────────────────────────────────────────
  const screenRows = await db
    .select({
      videoProjectId: videoScreens.videoProjectId,
      id: videoScreens.id,
      screenNumber: videoScreens.screenNumber,
      approvedGenerationId: videoScreens.approvedGenerationId,
    })
    .from(videoScreens)
    .where(inArray(videoScreens.videoProjectId, projectIds));

  type ScreenSummary = { total: number; approved: number; ids: number[] };
  const screensByProject = new Map<number, ScreenSummary>();
  const screenNumberById = new Map<number, number>();
  for (const s of screenRows) {
    const existing = screensByProject.get(s.videoProjectId) ?? { total: 0, approved: 0, ids: [] };
    screensByProject.set(s.videoProjectId, {
      total: existing.total + 1,
      approved: existing.approved + (s.approvedGenerationId ? 1 : 0),
      ids: [...existing.ids, s.id],
    });
    screenNumberById.set(s.id, s.screenNumber);
  }

  // ── Aggregate generations per project ─────────────────────────────────────
  const allScreenIds = screenRows.map((s) => s.id);
  type GenSummary = { total: number; completed: number; failed: number; inFlight: number; lastError: string | null; lastUpdated: number };
  const gensByProject = new Map<number, GenSummary>();

  // Per-screen gen detail for expand panel
  type ScreenGenDetail = { genCount: number; failedCount: number; lastFeedback: string | null };
  const genDetailByScreen = new Map<number, ScreenGenDetail>();

  if (allScreenIds.length > 0) {
    const genRows = await db
      .select({
        videoScreenId: videoGenerations.videoScreenId,
        status: videoGenerations.status,
        errorMessage: videoGenerations.errorMessage,
        creatorFeedback: videoGenerations.creatorFeedback,
        updatedAt: videoGenerations.updatedAt,
      })
      .from(videoGenerations)
      .where(inArray(videoGenerations.videoScreenId, allScreenIds));

    const screenToProject = new Map<number, number>();
    for (const s of screenRows) screenToProject.set(s.id, s.videoProjectId);

    for (const g of genRows) {
      const pid = screenToProject.get(g.videoScreenId);
      if (!pid) continue;
      const ex = gensByProject.get(pid) ?? { total: 0, completed: 0, failed: 0, inFlight: 0, lastError: null, lastUpdated: 0 };
      gensByProject.set(pid, {
        total: ex.total + 1,
        completed: ex.completed + (g.status === 'completed' ? 1 : 0),
        failed: ex.failed + (g.status === 'failed' ? 1 : 0),
        inFlight: ex.inFlight + (g.status === 'pending' || g.status === 'processing' ? 1 : 0),
        lastError: g.status === 'failed' && g.errorMessage ? g.errorMessage : ex.lastError,
        lastUpdated: Math.max(ex.lastUpdated, g.updatedAt),
      });

      // Per-screen detail
      const sd = genDetailByScreen.get(g.videoScreenId) ?? { genCount: 0, failedCount: 0, lastFeedback: null };
      genDetailByScreen.set(g.videoScreenId, {
        genCount: sd.genCount + 1,
        failedCount: sd.failedCount + (g.status === 'failed' ? 1 : 0),
        lastFeedback: g.creatorFeedback ?? sd.lastFeedback,
      });
    }
  }

  // ── Prompt revision counts per project ────────────────────────────────────
  const promptRevByProject = new Map<number, number>();
  if (allScreenIds.length > 0) {
    const pvRows = await db
      .select({ videoScreenId: screenPromptVersions.videoScreenId, version: screenPromptVersions.version })
      .from(screenPromptVersions)
      .where(inArray(screenPromptVersions.videoScreenId, allScreenIds));

    const screenToProject = new Map<number, number>();
    for (const s of screenRows) screenToProject.set(s.id, s.videoProjectId);

    for (const pv of pvRows) {
      const pid = screenToProject.get(pv.videoScreenId);
      if (!pid) continue;
      promptRevByProject.set(pid, (promptRevByProject.get(pid) ?? 0) + 1);
    }
  }

  // ── Latest compilation per project ────────────────────────────────────────
  const compilationRows = await db
    .select()
    .from(videoCompilations)
    .where(inArray(videoCompilations.videoProjectId, projectIds))
    .orderBy(sql`${videoCompilations.createdAt} DESC`);

  const latestCompByProject = new Map<number, typeof compilationRows[number]>();
  for (const c of compilationRows) {
    if (!latestCompByProject.has(c.videoProjectId)) {
      latestCompByProject.set(c.videoProjectId, c);
    }
  }

  // ── Resolve user emails via Supabase admin API ────────────────────────────
  const serviceClient = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const uniqueUserIds = [...new Set(projects.map((p) => p.userId))];
  const emailByUserId = new Map<string, string>();
  let page = 1;
  while (true) {
    const { data, error } = await serviceClient.auth.admin.listUsers({ page, perPage: 1000 });
    if (error || !data?.users.length) break;
    for (const u of data.users) {
      if (uniqueUserIds.includes(u.id)) emailByUserId.set(u.id, u.email ?? u.id);
    }
    if (data.users.length < 1000) break;
    page++;
  }

  // ── Build response ────────────────────────────────────────────────────────
  type FunnelStep = 'created' | 'breakdown' | 'generating' | 'approving' | 'compile' | 'review';

  function funnelStep(
    p: typeof projects[number],
    screens: ScreenSummary | undefined,
    gens: GenSummary | undefined,
    comp: typeof compilationRows[number] | undefined,
  ): FunnelStep {
    if (comp?.status === 'completed') return 'review';
    if (comp) return 'compile';
    const sc = screens?.total ?? 0;
    const ap = screens?.approved ?? 0;
    const totalGens = gens?.total ?? 0;
    if (sc > 0 && ap === sc) return 'compile';
    if (totalGens > 0) return ap > 0 ? 'approving' : 'generating';
    if (p.breakdownApprovedAt) return 'breakdown';
    return 'created';
  }

  const now = Date.now();

  const result = projects.map((p) => {
    const screens = screensByProject.get(p.id);
    const gens = gensByProject.get(p.id);
    const comp = latestCompByProject.get(p.id);
    const lastActivity = Math.max(
      p.updatedAt,
      gens?.lastUpdated ?? 0,
      comp?.updatedAt ?? 0,
    );
    const step = funnelStep(p, screens, gens, comp);
    const stuckMs = step !== 'review' ? now - lastActivity : null;
    const stuckHours = stuckMs !== null ? Math.floor(stuckMs / 3_600_000) : null;
    const isStuck = stuckHours !== null && stuckHours >= 12;

    const screenCount = screens?.total ?? 0;
    const totalGens = gens?.total ?? 0;
    const avgGensPerScene = screenCount > 0 && totalGens > 0
      ? Math.round((totalGens / screenCount) * 10) / 10
      : 0;

    const promptRevisionCount = promptRevByProject.get(p.id) ?? 0;

    // Per-screen detail for expand panel
    const projectScreens = screenRows.filter((s) => s.videoProjectId === p.id);
    const scenesDetail = projectScreens.map((s) => {
      const sd = genDetailByScreen.get(s.id) ?? { genCount: 0, failedCount: 0, lastFeedback: null };
      return {
        screenNumber: s.screenNumber,
        approved: !!s.approvedGenerationId,
        genCount: sd.genCount,
        failedCount: sd.failedCount,
        creatorFeedback: sd.lastFeedback,
      };
    }).sort((a, b) => a.screenNumber - b.screenNumber);

    const creatorFeedbackCount = scenesDetail.filter((s) => s.creatorFeedback).length;

    return {
      id: p.id,
      name: p.name,
      userId: p.userId,
      userEmail: emailByUserId.get(p.userId) ?? p.userId,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      lastActivityAt: lastActivity,
      hasBreakdown: !!p.breakdownApprovedAt,
      screenCount,
      approvedScreenCount: screens?.approved ?? 0,
      totalGenerations: totalGens,
      completedGenerations: gens?.completed ?? 0,
      failedGenerations: gens?.failed ?? 0,
      inFlightGenerations: gens?.inFlight ?? 0,
      avgGensPerScene,
      promptRevisionCount,
      lastGenerationError: gens?.lastError ?? null,
      compilationStatus: comp?.status ?? null,
      compilationError: comp?.errorMessage ?? null,
      compilationCreatedAt: comp?.createdAt ?? null,
      funnelStep: step,
      stuckHours,
      isStuck,
      creatorFeedbackCount,
      scenes: scenesDetail,
    };
  });

  return NextResponse.json(result);
}
