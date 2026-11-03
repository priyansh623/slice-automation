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

  return (
    <AppShell>
      <ProjectHeader projectId={id} projectName={project.name} steps={projectSteps} />

      <div className="page-body" style={{ maxWidth: 760 }}>
        <div style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.03em', color: 'var(--text-primary)', marginBottom: 4 }}>
            Compile video
          </h2>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
            Stitch your approved scene clips into a single video.
          </p>
        </div>

        {error && (
          <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>
        )}

        <div className="card">
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
                Scenes to include
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {project.screens.map((s) => (
                  <div key={s.id} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 14px',
                    background: 'var(--bg-page)',
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                  }}>
                    <div style={{
                      width: 20,
                      height: 20,
                      borderRadius: '50%',
                      background: s.approvedGenerationId ? '#111113' : 'var(--border)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      fontSize: 10,
                      color: '#fff',
                      fontWeight: 700,
                    }}>
                      {s.approvedGenerationId ? '✓' : s.screenNumber}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>Scene {s.screenNumber}</div>
                      {s.dialogue && (
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 1 }}>
                          {s.dialogue.slice(0, 80)}{s.dialogue.length > 80 ? '…' : ''}
                        </div>
                      )}
                    </div>
                    {!s.approvedGenerationId && (
                      <Link href={`/video-projects/${id}/screens/${s.screenNumber}`}>
                        <span style={{ fontSize: 12, color: 'var(--brand)', fontWeight: 500 }}>Approve →</span>
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {!allApproved && (
              <div style={{ padding: '12px 14px', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, fontSize: 13, color: '#78350F' }}>
                {approvedCount}/{totalCount} scenes approved. Approve all scenes before compiling.
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button
                onClick={handleCompile}
                disabled={submitting || !allApproved}
                style={{
                  padding: '10px 20px',
                  background: allApproved && !submitting ? '#111113' : 'var(--border)',
                  color: allApproved && !submitting ? '#fff' : 'var(--text-muted)',
                  border: 'none',
                  borderRadius: 'var(--radius-btn)',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: allApproved && !submitting ? 'pointer' : 'not-allowed',
                }}
              >
                {submitting ? 'Starting compilation…' : 'Compile all scenes'}
              </button>
              <Link href={`/video-projects/${id}`}>
                <button className="btn btn-secondary">Back to project</button>
              </Link>
            </div>

            {compilations.length > 0 && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                  Previous compilations
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {compilations.map((c) => (
                    <Link key={c.id} href={`/video-projects/${id}/review?cid=${c.id}`} style={{ textDecoration: 'none' }}>
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '10px 14px',
                        background: 'var(--bg-page)',
                        borderRadius: 8,
                        border: '1px solid var(--border)',
                        cursor: 'pointer',
                      }}>
                        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                          Compilation #{c.id}
                        </span>
                        <span style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          padding: '2px 8px',
                          borderRadius: 999,
                          fontSize: 12,
                          fontWeight: 500,
                          background: c.status === 'completed' ? '#F0FDF4' : c.status === 'failed' ? '#FEF2F2' : '#EFEBFF',
                          color: c.status === 'completed' ? '#15803D' : c.status === 'failed' ? '#991B1B' : 'var(--brand)',
                        }}>
                          {c.status}
                        </span>
                        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>
                          {new Date(c.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--brand)', fontWeight: 500 }}>View →</span>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
