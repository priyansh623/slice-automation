/** The steps shown in every project's header, in order. B-roll and Composition are their own steps. */
export const WORKFLOW = ['Script', 'Breakdown', 'B-roll', 'Scenes', 'Composition', 'Compile', 'Review'] as const;
export type WorkflowStep = (typeof WORKFLOW)[number];
export interface HeaderStep { label: string; status: 'complete' | 'active' | 'pending' }

/** Everything before `current` is complete, `current` is active, the rest pending. `scenesDone` marks Scenes complete while a later step is open. */
export function workflowSteps(current: WorkflowStep, opts: { scenesDone?: boolean } = {}): HeaderStep[] {
  const at = WORKFLOW.indexOf(current);
  return WORKFLOW.map((label, i) => ({
    label,
    status: i < at ? 'complete' : i === at ? 'active' : label === 'Scenes' && opts.scenesDone && at > 3 ? 'complete' : 'pending',
  }));
}

/** Where each step leads when it is clicked (only completed steps are clickable). Review has no page of its own. */
export const stepUrl = (projectId: number | string, label: string): string => {
  const base = `/video-projects/${projectId}`;
  switch (label) {
    case 'Script': case 'Breakdown': return base;
    case 'B-roll': return `${base}/broll`;
    case 'Scenes': return `${base}/screens/1`;
    case 'Composition': return `${base}/composition`;
    case 'Compile': return `${base}/compile`;
    default: return '';
  }
};
