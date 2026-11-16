/** Character B-roll Studio projects: a name, ONE base character image (V1) and the complete video script. */
import * as crypto from 'node:crypto';
import { desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { studioProjectPacks, studioProjects, studioSelections } from '@/db/schema.pg';
import { StudioError } from './repository';

export const MAX_PROJECT_NAME = 120;
export const MAX_SCRIPT_CHARS = 50_000;

export type ProjectRow = typeof studioProjects.$inferSelect;

const cleanName = (v: unknown): string => {
  const n = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (!n) throw new StudioError('A project needs a name.', 400, 'name_required');
  if (n.length > MAX_PROJECT_NAME) throw new StudioError(`The name is too long (max ${MAX_PROJECT_NAME} characters).`, 400, 'name_too_long');
  return n;
};

export const hashScript = (script: string): string => crypto.createHash('sha256').update(script.trim()).digest('hex');

export async function createProject(input: { name: unknown }, userId: string): Promise<ProjectRow> {
  const now = Date.now();
  const [row] = await db.insert(studioProjects).values({ name: cleanName(input.name), createdBy: userId, createdAt: now, updatedAt: now }).returning();
  return row;
}

export async function getProject(id: number): Promise<ProjectRow> {
  const row = (await db.select().from(studioProjects).where(eq(studioProjects.id, id)).limit(1))[0];
  if (!row) throw new StudioError('Project not found.', 404, 'project_not_found');
  return row;
}

/** What the Projects table needs to show each project's progress: how far it has got, counted from the project's own rows. */
export interface ProjectProgress { approvedPackCount: number; selectionCount: number; jobCount: number; jobsSucceeded: number; jobsActive: number; outputCount: number; outputsSaved: number }

export async function listProjects(opts: { includeArchived?: boolean } = {}): Promise<Array<ProjectRow & ProjectProgress>> {
  const rows = await db.select().from(studioProjects).where(opts.includeArchived ? undefined : isNull(studioProjects.archivedAt)).orderBy(desc(studioProjects.createdAt));
  if (rows.length === 0) return [];
  const counts = await db.select({ projectId: studioProjectPacks.projectId, n: sql<number>`count(*)`.mapWith(Number) }).from(studioProjectPacks).groupBy(studioProjectPacks.projectId);
  const sel = await db.select({ projectId: studioSelections.projectId, n: sql<number>`count(*)`.mapWith(Number) }).from(studioSelections).groupBy(studioSelections.projectId);
  const jobs = await db.execute(sql`select b.project_id as project_id, count(*)::int as total, count(*) filter (where j.status = 'succeeded')::int as succeeded, count(*) filter (where j.status in ('queued','submitting','submit_unknown','processing'))::int as active from studio_jobs j join studio_batches b on b.id = j.batch_id group by b.project_id`);
  const outs = await db.execute(sql`select project_id, count(*)::int as total, count(*) filter (where review_status = 'saved')::int as saved from studio_outputs group by project_id`);
  const rowsOf = <T,>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] }).rows ?? [])) as T[];
  const byProject = new Map(counts.map((c) => [c.projectId, c.n]));
  const bySel = new Map(sel.map((c) => [c.projectId, c.n]));
  const byJobs = new Map(rowsOf<{ project_id: number; total: number; succeeded: number; active: number }>(jobs).map((r) => [Number(r.project_id), r]));
  const byOuts = new Map(rowsOf<{ project_id: number; total: number; saved: number }>(outs).map((r) => [Number(r.project_id), r]));
  return rows.map((r) => ({
    ...r, approvedPackCount: byProject.get(r.id) ?? 0, selectionCount: bySel.get(r.id) ?? 0,
    jobCount: byJobs.get(r.id)?.total ?? 0, jobsSucceeded: byJobs.get(r.id)?.succeeded ?? 0, jobsActive: byJobs.get(r.id)?.active ?? 0,
    outputCount: byOuts.get(r.id)?.total ?? 0, outputsSaved: byOuts.get(r.id)?.saved ?? 0,
  }));
}

/** Renames and/or replaces the script. Recommendations made for an older script stay on record but are marked out of date by their hash. */
export async function updateProject(id: number, input: { name?: unknown; script?: unknown }): Promise<ProjectRow> {
  await getProject(id);
  const set: Partial<typeof studioProjects.$inferInsert> = { updatedAt: Date.now() };
  if (input.name !== undefined) set.name = cleanName(input.name);
  if (input.script !== undefined) {
    if (typeof input.script !== 'string') throw new StudioError('The script must be text.', 400, 'bad_script');
    if (input.script.length > MAX_SCRIPT_CHARS) throw new StudioError(`The script is too long (max ${MAX_SCRIPT_CHARS} characters).`, 400, 'script_too_long');
    set.script = input.script;
    set.scriptHash = input.script.trim() ? hashScript(input.script) : null;
  }
  if (Object.keys(set).length === 1) throw new StudioError('Nothing to change.', 400, 'nothing_to_change');
  const [row] = await db.update(studioProjects).set(set).where(eq(studioProjects.id, id)).returning();
  return row;
}

export async function setProjectArchived(id: number, archived: boolean): Promise<ProjectRow> {
  await getProject(id);
  const now = Date.now();
  const [row] = await db.update(studioProjects).set({ archivedAt: archived ? now : null, updatedAt: now }).where(eq(studioProjects.id, id)).returning();
  return row;
}

/** True when the stored recommendations were made for the project's current script. */
export const recommendationsAreCurrent = (p: Pick<ProjectRow, 'scriptHash' | 'recommendationsScriptHash' | 'recommendations'>): boolean =>
  Boolean(p.recommendations) && p.scriptHash !== null && p.scriptHash === p.recommendationsScriptHash;
