import { integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

// ── Phase 2: video production workflow ──────────────────────────────────────

export const workerLock = sqliteTable('worker_lock', {
  id: integer('id').primaryKey(),
  ownerToken: text('owner_token').notNull(),
  acquiredAt: integer('acquired_at').notNull(),
  heartbeatAt: integer('heartbeat_at').notNull(),
});

export const projects = sqliteTable('projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const screens = sqliteTable('screens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => projects.id),
  screenNumber: integer('screen_number').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => ({
  uniqueProjectScreen: unique().on(table.projectId, table.screenNumber),
}));

export const scriptSegments = sqliteTable('script_segments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  screenId: integer('screen_id').notNull().references(() => screens.id),
  origin: text('origin').notNull().default('human'),
  content: text('content').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: integer('created_at').notNull(),
});

export const screenPrompts = sqliteTable('screen_prompts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  screenId: integer('screen_id').notNull().references(() => screens.id),
  promptText: text('prompt_text').notNull(),
  model: text('model').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// ── Phase 2: video production workflow ──────────────────────────────────────

export const videoProjects = sqliteTable('video_projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  baseImagePath: text('base_image_path').notNull(),
  baseImageMediaId: text('base_image_media_id'),       // cached useapi.net mediaGenerationId after first upload
  originalScript: text('original_script').notNull(),
  approvedScript: text('approved_script'),               // typo-corrected version of originalScript; null = same as original
  skillVersion: text('skill_version').notNull().default('v3'),
  breakdownApprovedAt: integer('breakdown_approved_at'), // null = not yet approved
  creatorDescription: text('creator_description'),      // original text entered by creator at project creation
  creativeBrief: text('creative_brief'),                // JSON: structured creative decisions only (no creatorDescription)
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const videoScreens = sqliteTable('video_screens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  videoProjectId: integer('video_project_id').notNull().references(() => videoProjects.id),
  screenNumber: integer('screen_number').notNull(),
  dialogue: text('dialogue').notNull(),
  position: integer('position').notNull(),             // for reordering
  approvedGenerationId: integer('approved_generation_id'), // FK to videoGenerations.id, set explicitly
  durationSeconds: integer('duration_seconds'),        // assigned by script analysis (4/6/8/10)
  durationNote: text('duration_note'),                 // rationale for assigned duration
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => ({
  uniqueVideoProjectScreen: unique().on(table.videoProjectId, table.screenNumber),
}));

export const screenPromptVersions = sqliteTable('screen_prompt_versions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  videoScreenId: integer('video_screen_id').notNull().references(() => videoScreens.id),
  version: integer('version').notNull(),               // 1-based, auto-incremented per screen
  promptText: text('prompt_text').notNull(),
  source: text('source').notNull(),                    // 'claude' | 'manual'
  nlFeedback: text('nl_feedback'),                     // the NL instruction that produced this version (null for manual)
  feedbackScope: text('feedback_scope'),               // 'project' | 'scene' | null
  // Provenance (Scenes 2+ only): snapshot of what informed this prompt at generation time
  screen1PromptVersionId: integer('screen1_prompt_version_id'), // FK to screenPromptVersions.id
  creativeBriefSnapshot: text('creative_brief_snapshot'),       // JSON snapshot of videoProjects.creativeBrief
  createdAt: integer('created_at').notNull(),
});

export const videoGenerations = sqliteTable('video_generations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  videoScreenId: integer('video_screen_id').notNull().references(() => videoScreens.id),
  promptVersionId: integer('prompt_version_id').notNull().references(() => screenPromptVersions.id),
  jobId: text('job_id'),                               // useapi.net job ID, set after submission
  status: text('status').notNull().default('pending'), // pending | processing | completed | failed
  videoLocalPath: text('video_local_path'),
  durationSeconds: integer('duration_seconds'),        // actual duration sent to provider (4/6/8/10)
  errorMessage: text('error_message'),
  creatorFeedback: text('creator_feedback'),           // feedback on this specific generated clip
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const promptGenerationTasks = sqliteTable('prompt_generation_tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  videoProjectId: integer('video_project_id').notNull().references(() => videoProjects.id),
  videoScreenId: integer('video_screen_id').references(() => videoScreens.id), // null for extract_brief tasks
  taskType: text('task_type').notNull().default('generate_prompt'), // 'extract_brief' | 'generate_prompt'
  status: text('status').notNull().default('pending'), // pending | processing | completed | failed
  errorMessage: text('error_message'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const claudeConversations = sqliteTable('claude_conversations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  videoProjectId: integer('video_project_id').notNull().references(() => videoProjects.id),
  videoScreenId: integer('video_screen_id').references(() => videoScreens.id), // null = project-level thread
  messagesJson: text('messages_json').notNull().default('[]'), // full MessageParam[] array
  updatedAt: integer('updated_at').notNull(),
});
