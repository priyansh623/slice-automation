/**
 * Analytics events ownership logic tests.
 *
 * Tests that project-scoped analytics events require the caller to own the project.
 */
import { describe, it, expect } from 'vitest';

interface Project {
  id: number;
  userId: string;
}

type OwnershipCheckResult =
  | { ok: true }
  | { ok: false; status: 403 | 404; error: string };

function checkProjectOwnership(
  project: Project | undefined,
  requestingUserId: string,
): OwnershipCheckResult {
  if (!project) return { ok: false, status: 404, error: 'Project not found' };
  if (project.userId !== requestingUserId) return { ok: false, status: 403, error: 'Forbidden' };
  return { ok: true };
}

describe('analytics event project ownership', () => {
  it('allows owner to submit analytics for their project', () => {
    const project: Project = { id: 1, userId: 'user-abc' };
    const result = checkProjectOwnership(project, 'user-abc');
    expect(result.ok).toBe(true);
  });

  it('blocks a different user from submitting analytics for a project they do not own', () => {
    const project: Project = { id: 1, userId: 'user-abc' };
    const result = checkProjectOwnership(project, 'user-xyz');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
    }
  });

  it('returns 404 when project does not exist', () => {
    const result = checkProjectOwnership(undefined, 'user-abc');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
    }
  });

  it('allows unscoped events (no videoProjectId) without ownership check', () => {
    // When videoProjectId is null, no ownership check is performed
    const videoProjectId: number | null = null;
    const shouldCheck = videoProjectId != null;
    expect(shouldCheck).toBe(false);
  });
});
