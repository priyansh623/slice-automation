'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import AppShell from '@/components/AppShell';
import ProjectHeader from '@/components/ProjectHeader';

interface Screen {
  id: number;
  screenNumber: number;
  dialogue: string;
  approvedGenerationId: number | null;
}

interface VideoProject {
  id: number;
  name: string;
  screens: Screen[];
}

interface Compilation {
  id: number;
  videoProjectId: number;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export default function CompilePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [project, setProject] = useState<VideoProject | null>(null);
  const [compilations, setCompilations] = useState<Compilation[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      fetch(`/api/v1/video-projects/${id}`).then((r) => r.json()),
      fetch(`/api/v1/video-projects/${id}/compilations`).then((r) => r.json()),
    ]).then(([proj, comps]) => {
      setProject(proj);
      setCompilations(Array.isArray(comps) ? comps : []);
    });
  }, [id]);

  async function handleCompile() {
    if (!project) return;
    const approvedScenes = project.screens.filter((s) => s.approvedGenerationId);
    if (approvedScenes.length === 0) {
      setError('No approved scenes to compile.');
      return;
    }
    setSubmitting(true);
    setError('');
    const res = await fetch(`/api/v1/video-projects/${id}/compilations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenes: approvedScenes.map((s) => ({
          videoScreenId: s.id,
          videoGenerationId: s.approvedGenerationId!,
        })),
      }),
    });
    if (!res.ok) {
      const d = await res.json();
      setError(d.error ?? 'Failed to start compilation');
      setSubmitting(false);
      return;
    }
    const compilation: Compilation = await res.json();
    router.push(`/video-projects/${id}/review?cid=${compilation.id}`);
  }

  if (!project) {
    return (
      <AppShell>
        <div className="page-body">
          <div className="skeleton" style={{ height: 28, width: '40%', marginBottom: 16 }} />
        </div>
      </AppShell>
    );
  }

  const approvedCount = project.screens.filter((s) => s.approvedGenerationId).length;
  const totalCount = project.screens.length;
  const allApproved = approvedCount === totalCount && totalCount > 0;

  const projectSteps = [
    { label: 'Breakdown', status: 'complete' as const },
    { label: 'Scenes', status: allApproved ? ('complete' as const) : ('active' as const) },
    { label: 'Compile', status: 'active' as const },
  ];

  const tones = ['#E8E3D8', '#D8E3E8', '#E3D8E8', '#D8E8E3', '#E8DDD8', '#E3E8D8'];

  return (
    <AppShell>
      <ProjectHeader projectId={id} projectName={project.name} steps={projectSteps} />

      <div style={{ flex: 1, overflow: 'auto' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '48px 32px 80px' }}>
          {/* Title row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, minHeight: 44 }}>
            <h1 style={{ margin: 0, font: '700 26px/1.2 Satoshi', letterSpacing: '-0.02em' }}>
              Compile video
            </h1>
            {compilations.some((c) => c.status === 'completed') && (
              <Link href={`/video-projects/${id}/review?cid=${compilations.find(c => c.status === 'completed')!.id}`} style={{ textDecoration: 'none' }}>
                <button style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 40, padding: '0 18px', borderRadius: 9, background: '#6C47FF', color: '#fff', border: 'none', font: '500 14px/1 Satoshi', cursor: 'pointer' }}>
                  <i className="icon-play" style={{ fontSize: 14 }} />
                  Review video
                </button>
              </Link>
            )}
          </div>

          {error && (
            <div className="alert alert-error" style={{ marginTop: 16 }}>{error}</div>
          )}

          {/* Scene list */}
          <div style={{ marginTop: 32, borderTop: '1px solid #ECECE8' }}>
            {project.screens.map((s, i) => (
              <div key={s.id} style={{
                display: 'grid',
                gridTemplateColumns: '26px minmax(0,1fr) auto',
                gap: 16,
                alignItems: 'center',
                padding: '12px 0',
                borderBottom: '1px solid #F0F0EE',
              }}>
                <span style={{
                  width: 26,
                  height: 42,
                  borderRadius: 5,
                  backgroundColor: tones[i % tones.length],
                  display: 'block',
                  flexShrink: 0,
                }} />
                <div>
                  <div style={{ font: '700 14px/1.3 Satoshi' }}>Scene {s.screenNumber}</div>
                  <div style={{ font: '400 13px/1.4 Satoshi', color: '#75757C', marginTop: 2 }}>
                    {s.approvedGenerationId ? 'Generation approved' : 'No approved generation'}
                    {s.dialogue ? ` · ${s.dialogue.slice(0, 50)}${s.dialogue.length > 50 ? '…' : ''}` : ''}
                  </div>
                </div>
                <Link href={`/video-projects/${id}/screens/${s.screenNumber}`} style={{ textDecoration: 'none' }}>
                  <button style={{ height: 30, padding: '0 12px', borderRadius: 8, background: '#fff', border: '1px solid #E4E4E0', font: '500 13px/1 Satoshi', cursor: 'pointer' }}>
                    {s.approvedGenerationId ? 'Change' : 'Approve'}
                  </button>
                </Link>
              </div>
            ))}
          </div>

          {!allApproved && (
            <div style={{ marginTop: 16, font: '400 14px/1.5 Satoshi', color: '#5E5E65' }}>
              {approvedCount}/{totalCount} scenes approved. Approve all scenes before compiling.
            </div>
          )}

          {/* Compile button */}
          <div style={{ marginTop: 28, display: 'flex', gap: 10 }}>
            <button
              onClick={handleCompile}
              disabled={submitting || !allApproved}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                height: 40,
                padding: '0 18px',
                borderRadius: 9,
                background: allApproved && !submitting ? '#6C47FF' : '#E4E4E0',
                color: allApproved && !submitting ? '#fff' : '#A3A3A9',
                border: 'none',
                font: '700 14px/1 Satoshi',
                cursor: allApproved && !submitting ? 'pointer' : 'not-allowed',
              }}
            >
              {submitting ? 'Starting…' : 'Compile all scenes'}
            </button>
          </div>

          {/* Previous compilations */}
          {compilations.length > 0 && (
            <div style={{ marginTop: 32 }}>
              <div style={{ font: '500 12px/1 Satoshi', color: '#9A9AA0', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>
                Previous compilations
              </div>
              <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, overflow: 'hidden' }}>
                {compilations.map((c, i) => (
                  <Link key={c.id} href={`/video-projects/${id}/review?cid=${c.id}`} style={{ textDecoration: 'none', display: 'block' }}>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '12px 16px',
                      borderBottom: i < compilations.length - 1 ? '1px solid #F3F3F1' : 'none',
                      cursor: 'pointer',
                    }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = '#FAFAF8')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <span style={{ font: '500 13px/1 Satoshi' }}>Compilation #{c.id}</span>
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        height: 22,
                        padding: '0 8px',
                        borderRadius: 999,
                        font: '500 12px/1 Satoshi',
                        background: c.status === 'completed' ? '#EFEBFF' : c.status === 'failed' ? '#FEF2F2' : '#F0F0EC',
                        color: c.status === 'completed' ? '#6C47FF' : c.status === 'failed' ? '#DC2626' : '#111113',
                      }}>
                        {c.status}
                      </span>
                      <span style={{ marginLeft: 'auto', font: '400 12px/1 Satoshi', color: '#9A9AA0' }}>
                        {new Date(c.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      </span>
                      <i className="icon-chevron-right" style={{ fontSize: 15, color: '#A3A3A9' }} />
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
