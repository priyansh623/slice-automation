'use client';

/**
 * The supplied Character B-roll Studio design, as shared pieces. Every value below is copied from the prototype's inline styles
 * (Character B-roll Studio.dc.html); nothing here is a new decision. Hover and focus rules live in globals.css (.stu-*).
 */
import type { CSSProperties, ReactNode } from 'react';

export const primaryBtn: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 8, height: 38, padding: '0 16px', borderRadius: 9, background: '#6C47FF', color: '#fff', border: 'none', font: '500 14px/1 Satoshi', cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap' };
export const secondaryBtn: CSSProperties = { height: 38, padding: '0 16px', borderRadius: 9, background: '#fff', border: '1px solid #E4E4E0', font: '500 14px/1 Satoshi', cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap' };
export const smallBtn: CSSProperties = { height: 30, padding: '0 10px', borderRadius: 8, background: '#fff', border: '1px solid #E4E4E0', font: '500 12px/1 Satoshi', cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap' };
export const card: CSSProperties = { background: '#fff', border: '1px solid #ECECE8', borderRadius: 14 };
export const inputBox: CSSProperties = { height: 38, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 12px', font: '400 14px/1 Satoshi', outline: 'none' };
export const alertRed: CSSProperties = { padding: '12px 16px', borderRadius: 10, background: '#FEF2F2', border: '1px solid #FECACA', color: '#DC2626', font: '500 13px/1.5 Satoshi' };
export const alertGreen: CSSProperties = { padding: '12px 16px', borderRadius: 10, background: '#F0FDF4', border: '1px solid #BBF7D0', color: '#16A34A', font: '500 13px/1.5 Satoshi' };

export const pillBtn = (a: boolean) => ({ bg: a ? '#6C47FF' : 'transparent', fg: a ? '#fff' : '#5E5E65', cc: a ? '#CFC2FF' : '#A3A3A9' });

/** The segmented filter (All / Needs attention / ...) with counts. */
export function Segmented({ items }: { items: Array<{ label: string; count: number; active: boolean; onClick: () => void }> }) {
  return (
    <div style={{ display: 'flex', gap: 4, padding: 3, borderRadius: 10, background: '#EFEFEC' }}>
      {items.map((f) => { const p = pillBtn(f.active); return (
        <button key={f.label} onClick={f.onClick} style={{ height: 30, padding: '0 12px', border: 'none', borderRadius: 7, background: p.bg, color: p.fg, font: '500 13px/1 Satoshi', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, whiteSpace: 'nowrap' }}>{f.label}<span style={{ color: p.cc }}>{f.count}</span></button>
      ); })}
    </div>
  );
}

export const PulseDots = () => <span style={{ display: 'flex', gap: 4 }}><span className="stu-pd" /><span className="stu-pd" /><span className="stu-pd" /></span>;

/** A status chip over a 9:16 tile (top right). */
export const TileChip = ({ text, bg, fg }: { text: string; bg: string; fg: string }) => (
  <span style={{ position: 'absolute', top: 8, right: 8, height: 20, padding: '0 8px', borderRadius: 999, background: bg, color: fg, font: '500 10px/20px Satoshi' }}>{text}</span>
);

export const CodeChip = ({ code, pos }: { code: string; pos?: CSSProperties }) => (
  <span style={{ position: 'absolute', bottom: 8, left: 8, background: 'rgba(0,0,0,0.5)', color: '#fff', font: '500 11px/1 Satoshi', padding: '4px 7px', borderRadius: 6, ...pos }}>{code}</span>
);

/** The modal frame: overlay, white card (radius 16), width per modal. */
export function Modal({ width, onClose, children }: { width: number; onClose: () => void; children: ReactNode }) {
  return (
    <div className="stu-scope" onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 16, padding: '28px 28px 24px', width: '100%', maxWidth: width, boxShadow: '0 16px 48px rgba(0,0,0,0.18)' }}>{children}</div>
    </div>
  );
}

/** The 64px white header of the Studio list pages: title, Projects | Repository tabs, primary action. */
export function StudioListHeader({ tab, onProjects, onRepository, action }: { tab: 'projects' | 'repository'; onProjects: () => void; onRepository: () => void; action: { label: string; icon: string; onClick: () => void } }) {
  const t = (active: boolean): CSSProperties => ({ border: 'none', background: 'transparent', cursor: 'pointer', height: '100%', padding: 0, font: '500 14px/1 Satoshi', color: active ? '#111113' : '#75757C', borderBottom: `2px solid ${active ? '#6C47FF' : 'transparent'}` });
  return (
    <header style={{ height: 64, flexShrink: 0, background: '#fff', borderBottom: '1px solid #ECECE8', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 28, height: '100%' }}>
        <div style={{ font: '700 18px/1 Satoshi', letterSpacing: '-0.3px', whiteSpace: 'nowrap' }}>Character B-roll Studio</div>
        <div style={{ display: 'flex', gap: 24, height: '100%' }}>
          <button onClick={onProjects} style={t(tab === 'projects')}>Projects</button>
          <button onClick={onRepository} style={t(tab === 'repository')}>Repository</button>
        </div>
      </div>
      <button className="stu-primary" onClick={action.onClick} style={primaryBtn}><span style={{ fontSize: 18, lineHeight: 1 }}>{action.icon}</span>{action.label}</button>
    </header>
  );
}
