import { NextResponse } from 'next/server';
import { studioRoute, readJson, parseId } from '@/lib/studio/api';
import { getProject, setProjectArchived, updateProject } from '@/lib/studio/projects';
import { serializeProject } from '@/lib/studio/project-api';

export const GET = studioRoute<{ id: string }>(async ({ params, user }) => {
  const project = await getProject(parseId(params.id));
  return NextResponse.json({ project: { ...(await serializeProject(project, { full: true })), ownerEmail: project.createdBy === user.id ? (user.email ?? null) : null } });
});

// Renames the project and/or saves the complete script, and/or archives or restores it ({ archived: true | false }). Everything
// sent is applied (name, script and archived together); nothing is ever deleted.
export const PUT = studioRoute<{ id: string }>(async ({ req, params }) => {
  const id = parseId(params.id);
  const body = await readJson(req);
  let project = await getProject(id);
  // An empty request still goes to updateProject, which answers 400 "nothing to change".
  if (body.name !== undefined || body.script !== undefined || body.archived === undefined) project = await updateProject(id, { name: body.name, script: body.script });
  if (body.archived !== undefined) project = await setProjectArchived(id, body.archived === true);
  return NextResponse.json({ project: await serializeProject(project, { full: true }) });
});
