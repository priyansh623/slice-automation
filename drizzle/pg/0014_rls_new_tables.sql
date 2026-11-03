-- Migration 0014: Enable RLS on new tables
-- compilation_scene_selections and project_testers are written by Drizzle (service role)
-- and must be guarded from direct anon/authenticated reads.

ALTER TABLE compilation_scene_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_testers              ENABLE ROW LEVEL SECURITY;

-- Testers can see their own rows (for confirming invite acceptance etc.)
CREATE POLICY project_testers_select_own
  ON project_testers FOR SELECT
  USING (user_id = auth.uid());

-- Project owners can see all testers for their projects
CREATE POLICY project_testers_select_owner
  ON project_testers FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM video_projects vp
      WHERE vp.id = project_testers.video_project_id
        AND vp.user_id = auth.uid()
    )
  );

-- compilation_scene_selections: project owner can read their compilations
CREATE POLICY compilation_scene_selections_select_owner
  ON compilation_scene_selections FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM video_compilations vc
      JOIN video_projects vp ON vp.id = vc.video_project_id
      WHERE vc.id = compilation_scene_selections.compilation_id
        AND vp.user_id = auth.uid()
    )
  );
