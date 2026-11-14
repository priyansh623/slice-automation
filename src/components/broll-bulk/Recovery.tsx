'use client';
import { summariseSession, type Session, type SessionEntry } from '@/lib/broll-bulk/session';
import { Button, Chip, T, font } from './ui';

const STAGE: Record<SessionEntry['stage'], { label: string; tone: 'neutral' | 'accent' | 'ok' | 'warn' }> = {
  analysed: { label: 'Analysed', tone: 'accent' }, reviewed: { label: 'Reviewed', tone: 'accent' }, uploaded: { label: 'Uploaded', tone: 'ok' }, upload_incomplete: { label: 'Upload not finished', tone: 'warn' },
};

/**
 * Shown when work from an earlier visit is waiting. It explains what was kept, what was not, and that nothing happens until the
 * user selects the files again and approves the upload again.
 */
export function RecoveryBanner({ saved, missing, expired, hasItems, onSelect, onDiscard }: {
  saved: Session | null; missing: SessionEntry[]; expired: boolean; hasItems: boolean; onSelect: () => void; onDiscard: () => void;
}) {
  if (expired && !saved && !hasItems) {
    return (
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: '10px 14px', marginBottom: 14, font: font(400, 13, 1.5), color: T.muted }}>
        Saved work from an earlier visit has expired (it is kept for 24 hours). Select your videos again to re-run the analysis.
      </div>
    );
  }
  if (!saved || missing.length === 0) return null;
  const sum = summariseSession({ ...saved, entries: missing });
  return (
    <div style={{ background: T.accentSoft, border: '1px solid #DDD6FE', borderRadius: 12, padding: '12px 14px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <div style={{ font: font(700, 14, 1.3) }}>{hasItems ? 'Some videos from your earlier visit have not been selected again' : 'You have an unfinished batch from an earlier visit'}</div>
        {sum.analysed > 0 && <Chip tone="accent">{sum.analysed} analysed</Chip>}
        {sum.reviewed > 0 && <Chip tone="accent">{sum.reviewed} reviewed</Chip>}
        {sum.uploaded > 0 && <Chip tone="ok">{sum.uploaded} already uploaded</Chip>}
        {sum.incomplete > 0 && <Chip tone="warn">{sum.incomplete} upload not finished</Chip>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <Button size="sm" kind="primary" onClick={onSelect}>Select the files again</Button>
          <Button size="sm" onClick={onDiscard}>Discard saved work</Button>
        </div>
      </div>
      <div style={{ font: font(400, 12.5, 1.55), color: '#4C1D95', marginBottom: 8 }}>
        Your videos cannot be kept by the browser, so select the same files again and your edits come back (they are matched by content, not by name).
        Nothing is uploaded until you approve it again, and a restored batch is never treated as approved. Saved work is kept for 24 hours and holds no video, frames or text read from the footage.
      </div>
      <div style={{ display: 'grid', gap: 4, maxHeight: 150, overflowY: 'auto' }}>
        {missing.slice(0, 30).map((e) => (
          <div key={e.sha256} style={{ display: 'flex', alignItems: 'center', gap: 8, font: font(400, 12.5, 1.3), background: '#fff', border: `1px solid ${T.border}`, borderRadius: 8, padding: '5px 10px' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={e.fileName}>{e.edit.title || e.fileName}</span>
            <span style={{ color: T.faint }}>{e.fileName}</span>
            <Chip tone={STAGE[e.stage].tone}>{STAGE[e.stage].label}</Chip>
            {e.stage === 'uploaded' ? <Chip tone="ok">clip #{e.clipId}</Chip> : <Chip>file not selected yet</Chip>}
          </div>
        ))}
        {missing.length > 30 && <div style={{ font: font(400, 12, 1.3), color: T.muted }}>…and {missing.length - 30} more</div>}
      </div>
    </div>
  );
}
