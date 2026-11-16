import ProjectFlow from '@/components/studio/ProjectFlow';

export default async function StudioProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectFlow projectId={Number(id)} />;
}
