'use client';

import Link from 'next/link';

interface Step {
  label: string;
  status: 'complete' | 'active' | 'pending';
}

interface Props {
  projectId: number | string;
  projectName: string;
  steps: Step[];
}

export default function ProjectHeader({ projectId, projectName, steps }: Props) {
  return (
    <div style={{
      background: 'var(--bg-card)',
      borderBottom: '1px solid var(--border)',
      padding: '0 32px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      height: 56,
      flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Link href="/video-projects" style={{ fontSize: 13, color: 'var(--text-muted)' }}>Projects</Link>
        <span style={{ color: 'var(--text-muted)' }}>›</span>
        <Link href={`/video-projects/${projectId}`} style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
          {projectName}
        </Link>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {steps.map((step, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {i > 0 && (
              <div style={{ width: 24, height: 1, background: 'var(--border)' }} />
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{
                width: 20,
                height: 20,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                fontWeight: 700,
                flexShrink: 0,
                background: step.status === 'complete' ? '#111113' : step.status === 'active' ? 'var(--brand)' : 'var(--bg-page)',
                color: step.status === 'pending' ? 'var(--text-muted)' : '#fff',
                border: step.status === 'pending' ? '1px solid var(--border)' : 'none',
              }}>
                {step.status === 'complete' ? '✓' : i + 1}
              </div>
              <span style={{
                fontSize: 12,
                fontWeight: step.status === 'active' ? 600 : 400,
                color: step.status === 'pending' ? 'var(--text-muted)' : 'var(--text-primary)',
              }}>
                {step.label}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
