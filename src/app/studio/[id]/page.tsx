'use client';

import { useParams } from 'next/navigation';
import AppShell from '@/components/AppShell';
import ProjectView from '@/components/studio/ProjectView';

export default function StudioProjectPage() {
  const { id } = useParams<{ id: string }>();
  return <AppShell fullscreen><ProjectView projectId={Number(id)} /></AppShell>;
}
