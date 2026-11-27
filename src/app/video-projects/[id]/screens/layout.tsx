'use client';

import LoadError from '@/components/LoadError';
import AppShell from '@/components/AppShell';
import { fetchJson } from '@/lib/client/fetch-json';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ProjectContext } from '@/contexts/ProjectContext';
import type { VideoProject } from '@/contexts/ProjectContext';

export default function ScreensLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<VideoProject | null>(null);

  const [loadError, setLoadError] = useState('');
  const refreshProject = useCallback(async () => {
    if (!id) return;
    try {
      setProject(await fetchJson<VideoProject>(`/api/v1/video-projects/${id}`));
      setLoadError('');
    } catch (err) {
      setLoadError((err as Error).message);          // only shown when there is nothing to show; a failed refresh keeps the last good data
    }
  }, [id]);

  useEffect(() => { void refreshProject(); }, [refreshProject]);

  return (
    <ProjectContext.Provider value={{ project, refreshProject }}>
      {!project && loadError ? <AppShell><LoadError message={loadError} onRetry={() => { setLoadError(''); void refreshProject(); }} /></AppShell> : children}
    </ProjectContext.Provider>
  );
}
