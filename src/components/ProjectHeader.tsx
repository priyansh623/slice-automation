'use client';

import { useRouter } from 'next/navigation';
import { ArrowLeft, Check, ChevronRight } from 'lucide-react';

interface Step {
  label: string;
  status: 'complete' | 'active' | 'pending';
}

interface Props {
  projectId: number | string;
  projectName: string;
  creatorName?: string;
  steps: Step[];
  statusLabel?: string;
  statusBg?: string;
  statusFg?: string;
}

const STEP_URLS = (projectId: number | string) => [
  `/video-projects/${projectId}`,
  `/video-projects/${projectId}`,
  `/video-projects/${projectId}/screens/1`,
  `/video-projects/${projectId}/compile`,
  '',
];

export default function ProjectHeader({
  projectId,
  projectName,
  creatorName,
  steps,
  statusLabel,
  statusBg = '#F0F0EC',
  statusFg = '#111113',
}: Props) {
  const router = useRouter();
  const urls = STEP_URLS(projectId);

  return (
    <header style={{
      height: 64,
      flexShrink: 0,
      background: '#FFFFFF',
      borderBottom: '1px solid #ECECE8',
      display: 'grid',
      gridTemplateColumns: 'minmax(0,1fr) auto minmax(0,1fr)',
      alignItems: 'center',
      gap: 16,
      padding: '0 20px',
    }}>
      {/* Left: back button + project name + creator subtitle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <button
          onClick={() => router.push('/video-projects')}
          title="All projects"
          style={{
            width: 32,
            height: 32,
            flexShrink: 0,
            borderRadius: 8,
            border: '1px solid #E4E4E0',
            background: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <ArrowLeft size={16} />
        </button>
        <div style={{ minWidth: 0 }}>
          <div style={{
            font: '700 15px/1.25 Satoshi',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {projectName}
          </div>
          {creatorName && (
            <div style={{
              font: '400 12px/1.3 Satoshi',
              color: '#75757C',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              marginTop: 2,
            }}>
              {creatorName}
            </div>
          )}
        </div>
      </div>

      {/* Center: stepper */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {steps.map((step, i) => {
          const isComplete = step.status === 'complete';
          const isActive = step.status === 'active';
          const canClick = isComplete && !!urls[i];

          const circleBg = isComplete ? '#EFEBFF' : isActive ? '#6C47FF' : '#EFEFEC';
          const circleFg = isComplete ? '#6C47FF' : isActive ? '#fff' : '#9A9AA0';
          const labelFg = isActive ? '#111113' : isComplete ? '#111113' : '#9A9AA0';
          const fontWeight = isActive ? '700' : isComplete ? '500' : '400';

          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button
                onClick={canClick ? () => router.push(urls[i]) : undefined}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 8px',
                  border: 'none',
                  background: 'transparent',
                  borderRadius: 8,
                  cursor: canClick ? 'pointer' : 'default',
                  font: `${fontWeight} 13px/1 Satoshi`,
                  color: labelFg,
                }}
              >
                <span style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: circleBg,
                  color: circleFg,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  font: '700 11px/1 Satoshi',
                  flexShrink: 0,
                }}>
                  {isComplete
                    ? <Check size={12} />
                    : i + 1}
                </span>
                {step.label}
              </button>
              {i < steps.length - 1 && (
                <ChevronRight size={14} color="#C4C4C9" />
              )}
            </div>
          );
        })}
      </div>

      {/* Right: status pill */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12 }}>
        {statusLabel && (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            height: 24,
            padding: '0 9px',
            borderRadius: 999,
            font: '500 12px/1 Satoshi',
            background: statusBg,
            color: statusFg,
            whiteSpace: 'nowrap',
          }}>
            {statusLabel}
          </span>
        )}
      </div>
    </header>
  );
}
