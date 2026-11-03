-- Migration 0012: Add compilation_scene_selections table
-- Records which video generation was selected for each screen in a compilation.
-- Decouples compilation content from the per-screen approvedGenerationId snapshot.

CREATE TABLE IF NOT EXISTS compilation_scene_selections (
  id          SERIAL PRIMARY KEY,
  compilation_id     INTEGER NOT NULL REFERENCES video_compilations(id) ON DELETE CASCADE,
  video_screen_id    INTEGER NOT NULL REFERENCES video_screens(id),
  video_generation_id INTEGER NOT NULL REFERENCES video_generations(id),
  created_at  BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_css_compilation_id  ON compilation_scene_selections(compilation_id);
CREATE INDEX IF NOT EXISTS idx_css_video_screen_id ON compilation_scene_selections(video_screen_id);
