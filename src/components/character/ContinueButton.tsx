'use client';

import { useRouter } from 'next/navigation';
import { summarizeApproval, type ApprovalScreenLike } from '@/lib/scene-approval';

/**
 * The header action of the Scenes screen: on to Composition. It opens once every Flow scene has an approved video. Character clips are not required
 * (a clip that is not ready yet appears in Composition by itself when it is).
 */
export default function ContinueButton({ projectId, screens }: { projectId: number | string; screens: readonly ApprovalScreenLike[] }) {
  const router = useRouter();
  const summary = summarizeApproval(screens);
  const eligible = summary.reason === null;
  return (
    <button onClick={() => router.push(`/video-projects/${projectId}/composition`)} disabled={!eligible}
      title={eligible ? 'Arrange the scenes and B-roll on the timeline' : (summary.reason ?? undefined)}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 36, padding: '0 16px', borderRadius: 9, font: '600 13px/1 Satoshi', whiteSpace: 'nowrap', border: 'none', background: eligible ? '#6C47FF' : '#EFEFEC', color: eligible ? '#fff' : '#A3A3A9', cursor: eligible ? 'pointer' : 'not-allowed' }}>
      Continue to Composition
    </button>
  );
}
