/** Character B-roll Studio projects: a name, ONE base character image (V1) and the complete video script. */
import * as crypto from 'node:crypto';
import { desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { studioProjectPacks, studioProjects } from '@/db/schema.pg';
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

export async function listProjects(opts: { includeArchived?: boolean } = {}): Promise<Array<ProjectRow & { approvedPackCount: number }>> {
  const rows = await db.select().from(studioProjects).where(opts.includeArchived ? undefined : isNull(studioProjects.archivedAt)).orderBy(desc(studioProjects.createdAt));
  if (rows.length === 0) return [];
  const counts = await db.select({ projectId: studioProjectPacks.projectId, n: sql<number>`count(*)`.mapWith(Number) }).from(studioProjectPacks).groupBy(studioProjectPacks.projectId);
  const byProject = new Map(counts.map((c) => [c.projectId, c.n]));
  return rows.map((r) => ({ ...r, approvedPackCount: byProject.get(r.id) ?? 0 }));
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
