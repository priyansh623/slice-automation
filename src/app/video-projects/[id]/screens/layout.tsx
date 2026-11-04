'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ProjectContext } from '@/contexts/ProjectContext';
import type { VideoProject } from '@/contexts/ProjectContext';

export default function ScreensLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<VideoProject | null>(null);

  const refreshProject = useCallback(async () => {
    if (!id) return;
    const res = await fetch(`/api/v1/video-projects/${id}`);
    if (!res.ok) return;
    setProject(await res.json() as VideoProject);
  }, [id]);

  useEffect(() => { void refreshProject(); }, [refreshProject]);

  return (
    <ProjectContext.Provider value={{ project, refreshProject }}>
      {children}
    </ProjectContext.Provider>
  );
}
