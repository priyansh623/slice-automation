'use client';
import type { CSSProperties, ReactNode } from 'react';

/** The existing Soma Slice palette (see the B-roll library page): purple accent, warm greys, Satoshi. */
export const T = {
  accent: '#6C47FF', accentDark: '#5A36E8', accentSoft: '#F5F3FF',
  text: '#111113', muted: '#75757C', faint: '#A3A3A9', border: '#E4E4E0', borderStrong: '#D6D6D1', surface: '#F6F6F4', card: '#fff',
  danger: '#DC2626', dangerSoft: '#FEF2F2', dangerBorder: '#FECACA',
  warn: '#B45309', warnSoft: '#FFFBEB', warnBorder: '#FDE68A',
  ok: '#15803D', okSoft: '#F0FDF4', okBorder: '#BBF7D0',
};
export const font = (weight: number, size: number, line: number | string = 1.4) => `${weight} ${size}px/${line} Satoshi`;

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';
const TONES: Record<Tone, { bg: string; fg: string; bd: string }> = {
  neutral: { bg: T.surface, fg: '#5E5E65', bd: T.border },
  accent: { bg: T.accentSoft, fg: T.accent, bd: '#DDD6FE' },
  ok: { bg: T.okSoft, fg: T.ok, bd: T.okBorder },
  warn: { bg: T.warnSoft, fg: T.warn, bd: T.warnBorder },
  danger: { bg: T.dangerSoft, fg: T.danger, bd: T.dangerBorder },
};

export function Chip({ tone = 'neutral', children, title, onClick, style }: { tone?: Tone; children: ReactNode; title?: string; onClick?: () => void; style?: CSSProperties }) {
  const c = TONES[tone];
  return (
    <span title={title} onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 22, padding: '0 8px', borderRadius: 999, background: c.bg, color: c.fg, border: `1px solid ${c.bd}`, font: font(500, 12, 1), whiteSpace: 'nowrap', cursor: onClick ? 'pointer' : 'default', ...style }}>
      {children}
    </span>
  );
}

export function Button({ children, onClick, disabled, kind = 'secondary', size = 'md', title, style }: { children: ReactNode; onClick?: () => void; disabled?: boolean; kind?: 'primary' | 'secondary' | 'danger' | 'ghost'; size?: 'sm' | 'md'; title?: string; style?: CSSProperties }) {
  const h = size === 'sm' ? 30 : 38;
  const base: CSSProperties = { height: h, padding: size === 'sm' ? '0 10px' : '0 16px', borderRadius: 9, font: font(kind === 'primary' ? 700 : 500, size === 'sm' ? 13 : 14, 1), cursor: disabled ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' };
  const look: CSSProperties =
    kind === 'primary' ? { background: disabled ? T.border : T.accent, color: disabled ? T.faint : '#fff', border: 'none' }
    : kind === 'danger' ? { background: '#fff', color: T.danger, border: `1px solid ${T.dangerBorder}` }
    : kind === 'ghost' ? { background: 'transparent', color: '#5E5E65', border: '1px solid transparent' }
    : { background: '#fff', color: T.text, border: `1px solid ${T.border}` };
  return <button title={title} onClick={onClick} disabled={disabled} style={{ ...base, ...look, opacity: disabled && kind !== 'primary' ? 0.55 : 1, ...style }}>{children}</button>;
}

export const inputStyle: CSSProperties = { width: '100%', height: 36, border: `1px solid ${T.border}`, borderRadius: 8, padding: '0 10px', font: font(400, 14, 1), outline: 'none', boxSizing: 'border-box', background: '#fff', color: T.text };

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ font: font(500, 13, 1), marginBottom: 6, color: T.text }}>{label}{hint ? <span style={{ color: T.faint, fontWeight: 400 }}> {hint}</span> : null}</div>
      {children}
    </div>
  );
}

export function ProgressBar({ value, tone = 'accent' }: { value: number; tone?: 'accent' | 'ok' | 'danger' }) {
  const color = tone === 'ok' ? T.ok : tone === 'danger' ? T.danger : T.accent;
  return (
    <div style={{ height: 6, borderRadius: 999, background: T.border, overflow: 'hidden' }}>
      <div style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`, height: '100%', background: color, transition: 'width 0.2s' }} />
    </div>
  );
}

export function ModalShell({ title, children, onClose, width = 480 }: { title: string; children: ReactNode; onClose: () => void; width?: number }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1300, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: '24px 24px 20px', width: '100%', maxWidth: width, maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 16px 48px rgba(0,0,0,0.18)' }}>
        <div style={{ font: font(700, 18, 1.3), marginBottom: 12 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

export const PRIVACY_LABEL: Record<string, string> = {
  face: 'Identifiable face', name: 'Name or name tag', phone: 'Phone number', email: 'Email address', travel_document: 'Travel document',
  payment_details: 'Payment details', financial_info: 'Financial information', receipt: 'Receipt', address: 'Address', other_pii: 'Personal information',
};
