import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoProjects, videoScreens, screenPromptVersions, videoGenerations } from '@/db/schema.pg';
import { and, eq, inArray } from 'drizzle-orm';
import { requireUser, requireProjectOwner } from '@/lib/api-auth';

class BreakdownBlockedError extends Error {
  screenNumbers: number[];
  constructor(screenNumbers: number[]) {
    super(`Cannot remove screens with existing history: ${screenNumbers.join(', ')}`);
    this.name = 'BreakdownBlockedError';
    this.screenNumbers = screenNumbers;
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const { id } = await params;
  const projectId = parseInt(id, 10);
  if (isNaN(projectId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const ownerResult = await requireProjectOwner(projectId, user.id);
  if (ownerResult instanceof NextResponse) return ownerResult;

  const body = (await req.json()) as {
    screens: Array<{
      screenNumber: number;
      dialogue: string;
      position?: number;
      durationSeconds?: number | null;
      durationNote?: string | null;
    }>;
    approvedScript?: string | null;
  };

  if (!Array.isArray(body.screens)) {
    return NextResponse.json({ error: 'screens array required' }, { status: 400 });
  }

  const incomingNumbers = new Set(body.screens.map((s) => s.screenNumber));

  const existingScreens = await db
    .select()
    .from(videoScreens)
    .where(eq(videoScreens.videoProjectId, projectId));

  const removedScreens = existingScreens.filter((s) => !incomingNumbers.has(s.screenNumber));

  // Block removal of any screen with prompt version history or generation history
  if (removedScreens.length > 0) {
    const removedIds = removedScreens.map((s) => s.id);
    const blockedNumbers: number[] = [];

    // Run both checks independently — neither result gates the other
    const [pvRows, genRows] = await Promise.all([
      db
        .select({ videoScreenId: screenPromptVersions.videoScreenId })
        .from(screenPromptVersions)
        .where(inArray(screenPromptVersions.videoScreenId, removedIds))
        .limit(1),
      db
        .select({ videoScreenId: videoGenerations.videoScreenId })
        .from(videoGenerations)
        .where(inArray(videoGenerations.videoScreenId, removedIds))
        .limit(1),
    ]);

    const hasPromptVersions = pvRows.length > 0;
    const hasGenerations = genRows.length > 0;

    if (hasPromptVersions || hasGenerations) {
      // Identify exactly which removed screens have history
      const blockedScreenIds = new Set<number>();
      if (hasPromptVersions) pvRows.forEach((r) => blockedScreenIds.add(r.videoScreenId));
      if (hasGenerations) genRows.forEach((r) => blockedScreenIds.add(r.videoScreenId));
      for (const s of removedScreens) {
        if (blockedScreenIds.has(s.id)) blockedNumbers.push(s.screenNumber);
      }
      // If the limit(1) queries found any row, fall back to reporting all removed screens
      const reportedNumbers = blockedNumbers.length > 0 ? blockedNumbers : removedScreens.map((s) => s.screenNumber);
      const err = new BreakdownBlockedError(reportedNumbers);
      return NextResponse.json(
        { error: err.message, blockedScreenNumbers: err.screenNumbers },
        { status: 409 },
      );
    }
  }

  const now = Date.now();

  // Mark existing prompt versions as stale for screens whose dialogue changed
  const existingByNumber = new Map(existingScreens.map((s) => [s.screenNumber, s]));
  const dialogueChangedIds: number[] = [];
  for (const incoming of body.screens) {
    const existing = existingByNumber.get(incoming.screenNumber);
    if (existing && existing.dialogue !== incoming.dialogue) {
      dialogueChangedIds.push(existing.id);
    }
  }

  if (dialogueChangedIds.length > 0) {
    await db
      .update(screenPromptVersions)
      .set({ isStale: true })
      .where(inArray(screenPromptVersions.videoScreenId, dialogueChangedIds));
  }

  // Delete removed screens (verified above that they have no history)
  if (removedScreens.length > 0) {
    await db
      .delete(videoScreens)
      .where(
        and(
          eq(videoScreens.videoProjectId, projectId),
          inArray(
            videoScreens.screenNumber,
            removedScreens.map((s) => s.screenNumber),
          ),
        ),
      );
  }

  // Upsert screens: update existing, insert new
  for (const s of body.screens) {
    const existing = existingByNumber.get(s.screenNumber);
    if (existing) {
      await db
        .update(videoScreens)
        .set({
          dialogue: s.dialogue,
          position: s.position ?? s.screenNumber,
          durationSeconds: s.durationSeconds ?? null,
          durationNote: s.durationNote ?? null,
          updatedAt: now,
        })
        .where(eq(videoScreens.id, existing.id));
    } else {
      await db.insert(videoScreens).values({
        videoProjectId: projectId,
        screenNumber: s.screenNumber,
        dialogue: s.dialogue,
        position: s.position ?? s.screenNumber,
        durationSeconds: s.durationSeconds ?? null,
        durationNote: s.durationNote ?? null,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  await db
    .update(videoProjects)
    .set({
      breakdownApprovedAt: null,
      updatedAt: now,
      ...(body.approvedScript !== undefined ? { approvedScript: body.approvedScript } : {}),
    })
    .where(eq(videoProjects.id, projectId));

  const allScreens = await db.select().from(videoScreens).where(eq(videoScreens.videoProjectId, projectId));
  const screens = allScreens.sort((a, b) => a.position - b.position);

  return NextResponse.json({ screens });
}
