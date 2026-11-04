'use client';

import { createContext, useContext } from 'react';

export interface Screen {
  id: number;
  screenNumber: number;
  dialogue: string;
  position: number;
  approvedGenerationId: number | null;
  durationSeconds: number | null;
  hasPrompt: boolean;
  latestGen: { id: number; status: string; videoStoragePath: string | null; updatedAt: number } | null;
  latestCompletedGen: { id: number; videoStoragePath: string } | null;
  promptTaskStatus: string | null;
}

export interface VideoProject {
  id: number;
  name: string;
  baseImagePreviewUrl?: string;
  screens: Screen[];
}

export interface ProjectContextValue {
  project: VideoProject | null;
  refreshProject: () => Promise<void>;
}

export const ProjectContext = createContext<ProjectContextValue>({
  project: null,
  refreshProject: async () => {},
});

export function useProject() {
  return useContext(ProjectContext);
}
