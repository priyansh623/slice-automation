/**
 * Scene approval and compilation eligibility, shared by the pages and the server.
 *
 * A scene is approved when `approvedGenerationId` is set (the existing approval pointer; nothing else stores approval).
 * A deleted scene is kept in the table so its prompts and videos are never lost, but it is marked by a non-positive
 * `screenNumber` (see scene-management.ts) and is never part of the sequence: it counts for nothing here.
 */

export interface ApprovalScreenLike {
  screenNumber: number;
  approvedGenerationId: number | null;
}

/** True for a scene that is part of the project's sequence (not deleted). */
export function isActiveScreen(screen: { screenNumber: number }): boolean {
  return screen.screenNumber > 0;
}

export interface ApprovalSummary {
  total: number;
  approved: number;
  /** Scenes that still need an approved video, in order. */
  unapprovedScreenNumbers: number[];
  /** True when there is at least one scene and every one is approved: the only state in which compiling is allowed. */
  eligible: boolean;
  /** Why compiling is not possible, or null when it is. */
  reason: string | null;
}

export function summarizeApproval(screens: readonly ApprovalScreenLike[]): ApprovalSummary {
  const active = screens.filter(isActiveScreen).sort((a, b) => a.screenNumber - b.screenNumber);
  const unapproved = active.filter((s) => !s.approvedGenerationId);
  const eligible = active.length > 0 && unapproved.length === 0;
  let reason: string | null = null;
  if (active.length === 0) reason = 'Add a scene before compiling.';
  else if (unapproved.length > 0) {
    reason = unapproved.length === 1
      ? `1 scene still needs approval (Scene ${unapproved[0].screenNumber}).`
      : `${unapproved.length} scenes still need approval.`;
  }
  return {
    total: active.length,
    approved: active.length - unapproved.length,
    unapprovedScreenNumbers: unapproved.map((s) => s.screenNumber),
    eligible,
    reason,
  };
}
