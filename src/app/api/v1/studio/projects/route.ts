import { NextResponse } from 'next/server';
import { studioRoute, readJson } from '@/lib/studio/api';
import { createProject, listProjects } from '@/lib/studio/projects';
import { serializeProject } from '@/lib/studio/project-api';

// Every Studio project (shared workspace: all signed-in users see and manage all of them).
// A read that has not answered in a minute will not answer: fail (the page offers Retry) instead of hanging to the platform's 300 s limit.
export const maxDuration = 60;

export const GET = studioRoute(async ({ req, user }) => {
  const rows = await listProjects({ includeArchived: req.nextUrl.searchParams.get('includeArchived') === '1' });
  const projects = await Promise.all(rows.map(async (r) => ({ ...(await serializeProject(r)), ownerEmail: r.createdBy === user.id ? (user.email ?? null) : null, approvedPackCount: r.approvedPackCount, selectionCount: r.selectionCount, jobCount: r.jobCount, jobsSucceeded: r.jobsSucceeded, jobsActive: r.jobsActive, outputCount: r.outputCount, outputsSaved: r.outputsSaved })));
  return NextResponse.json({ projects });
});

export const POST = studioRoute(async ({ req, user }) => {
  const body = await readJson(req);
  const project = await createProject({ name: body.name }, user.id);
  return NextResponse.json({ project: await serializeProject(project, { full: true }) }, { status: 201 });
});
