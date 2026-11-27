/**
 * Deleting a project is a SOFT delete, in one transaction. Nothing is removed: every scene, prompt, video, compilation, overlay, Character item and
 * Studio link stays in the database and in storage, so a mistake (or a bug) can never destroy approved work.
 *
 * A user-deleted project is marked with a NEGATIVE `archived_at` (the negated deletion time). A positive value keeps its old meaning, "archived by an
 * admin", which still shows in the Projects list as before. The admin dashboard lists both under "Show archived", and Unarchive restores either.
 * (The same sign convention already marks deleted scenes; see services/scene-management.ts.) No schema change is needed.
 *
 * Work that has not been sent to a provider yet is cancelled in the same transaction so a deleted project spends nothing more. Work already accepted
 * by a provider is left to finish and be stored: it is already paid for.
 */
import { and, eq, gte, isNull, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { characterBrollItems, promptGenerationTasks, videoCompilations, videoGenerations, videoProjects, videoScreens } from '@/db/schema.pg';

export const PROJECT_DELETED_MESSAGE = 'The project was deleted before this could start.';

export const isDeletedProject = (p: { archivedAt: number | null } | undefined | null): boolean => !!p && p.archivedAt != null && p.archivedAt < 0;

/** SQL condition for "not deleted by a user" (active, or archived by an admin). */
export const notDeleted = () => or(isNull(videoProjects.archivedAt), gte(videoProjects.archivedAt, 0));

/** Returns false when there is no such project (or it is already deleted). Throws, leaving everything unchanged, if any step fails. */
export async function softDeleteProject(projectId: number, now = Date.now()): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [project] = await tx.select({ archivedAt: videoProjects.archivedAt }).from(videoProjects).where(eq(videoProjects.id, projectId)).for('update');
    if (!project || isDeletedProject(project)) return false;
    await tx.update(videoProjects).set({ archivedAt: -now, updatedAt: now }).where(eq(videoProjects.id, projectId));

    await tx.update(promptGenerationTasks).set({ status: 'failed', errorMessage: PROJECT_DELETED_MESSAGE, claimedAt: null, updatedAt: now })
      .where(and(eq(promptGenerationTasks.videoProjectId, projectId), eq(promptGenerationTasks.status, 'pending')));
    await tx.update(videoGenerations).set({ status: 'failed', errorMessage: PROJECT_DELETED_MESSAGE, claimedAt: null, updatedAt: now })
      .where(and(eq(videoGenerations.status, 'queued'), isNull(videoGenerations.jobId),
        sql`${videoGenerations.videoScreenId} in (select ${videoScreens.id} from ${videoScreens} where ${videoScreens.videoProjectId} = ${projectId})`));
    await tx.update(videoCompilations).set({ status: 'failed', errorMessage: PROJECT_DELETED_MESSAGE, claimedAt: null, updatedAt: now })
      .where(and(eq(videoCompilations.videoProjectId, projectId), eq(videoCompilations.status, 'pending')));
    await tx.update(characterBrollItems).set({ clipStatus: 'failed', clipErrorCode: 'project_deleted', clipErrorMessage: PROJECT_DELETED_MESSAGE, clipRetryable: true, claimedAt: null, updatedAt: now })
      .where(and(eq(characterBrollItems.videoProjectId, projectId), eq(characterBrollItems.clipStatus, 'queued')));
    // Image generation for this project's Character B-roll runs through a linked Studio project: unsent jobs are cancelled too.
    await tx.execute(sql`update studio_jobs set status = 'canceled', claimed_at = null, next_poll_at = null, finished_at = ${now}, updated_at = ${now}, error_message = ${PROJECT_DELETED_MESSAGE}
      where status = 'queued' and project_id in (select id from studio_projects where video_project_id = ${projectId})`);
    return true;
  });
}

/** True when the video project has been deleted by a user. For callers that hold only its id (workers, locked transactions). */
export async function isVideoProjectDeleted(projectId: number, h: Pick<typeof db, 'select'> = db): Promise<boolean> {
  const [p] = await h.select({ archivedAt: videoProjects.archivedAt }).from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1);
  return isDeletedProject(p);
}

/** A Studio project that holds the Character B-roll jobs of a deleted video project must not start anything either. */
export async function isStudioProjectOfDeletedVideo(studioProjectId: number, h: Pick<typeof db, 'execute'> = db): Promise<boolean> {
  const result = (await h.execute(sql`select 1 as hit from studio_projects sp join video_projects vp on vp.id = sp.video_project_id where sp.id = ${studioProjectId} and vp.archived_at < 0`)) as unknown as { rows?: unknown[] } & unknown[];
  return (result.rows ?? result).length > 0;
}
