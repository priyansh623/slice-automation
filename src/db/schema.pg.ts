import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// All Unix millisecond timestamps use BIGINT to avoid 2038 overflow.
// bigint mode:'number' returns a JS number (safe up to 2^53).

// ── Legacy tables (no user FK — service role only via RLS) ───────────────────

export const projects = pgTable('projects', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

export const screens = pgTable('screens', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull().references(() => projects.id),
  screenNumber: integer('screen_number').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (table) => ({
  uniqueProjectScreen: unique().on(table.projectId, table.screenNumber),
}));

export const scriptSegments = pgTable('script_segments', {
  id: serial('id').primaryKey(),
  screenId: integer('screen_id').notNull().references(() => screens.id),
  origin: text('origin').notNull().default('human'),
  content: text('content').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

export const screenPrompts = pgTable('screen_prompts', {
  id: serial('id').primaryKey(),
  screenId: integer('screen_id').notNull().references(() => screens.id),
  promptText: text('prompt_text').notNull(),
  model: text('model').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

// ── Core video workflow ───────────────────────────────────────────────────────

export const videoProjects = pgTable('video_projects', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id').notNull(),                      // Supabase Auth uid
  name: text('name').notNull(),
  baseImagePath: text('base_image_path').notNull(),       // Supabase Storage path (not signed URL)
  baseImageMediaId: text('base_image_media_id'),
  originalScript: text('original_script').notNull(),
  approvedScript: text('approved_script'),
  skillVersion: text('skill_version').notNull().default('v3'),
  breakdownApprovedAt: bigint('breakdown_approved_at', { mode: 'number' }),
  creatorDescription: text('creator_description'),
  creativeBrief: text('creative_brief'),
  scene1HookSnapshot: text('scene1_hook_snapshot'),       // snapshot of default hook at project start
  baseImageSignedUrl: text('base_image_signed_url'),       // cached signed URL (see migration 0015)
  baseImageSignedUrlExpiresAt: bigint('base_image_signed_url_expires_at', { mode: 'number' }), // Unix ms
  archivedAt: bigint('archived_at', { mode: 'number' }),   // set when admin archives the project
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

export const videoScreens = pgTable('video_screens', {
  id: serial('id').primaryKey(),
  videoProjectId: integer('video_project_id').notNull().references(() => videoProjects.id),
  screenNumber: integer('screen_number').notNull(),
  dialogue: text('dialogue').notNull(),
  position: integer('position').notNull(),
  approvedGenerationId: integer('approved_generation_id'),
  durationSeconds: integer('duration_seconds'),
  durationNote: text('duration_note'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (table) => ({
  uniqueVideoProjectScreen: unique().on(table.videoProjectId, table.screenNumber),
}));

export const screenPromptVersions = pgTable('screen_prompt_versions', {
  id: serial('id').primaryKey(),
  videoScreenId: integer('video_screen_id').notNull().references(() => videoScreens.id),
  version: integer('version').notNull(),
  promptText: text('prompt_text').notNull(),
  source: text('source').notNull(),                       // 'claude' | 'manual'
  nlFeedback: text('nl_feedback'),
  feedbackScope: text('feedback_scope'),                  // 'project' | 'scene' | null
  screen1PromptVersionId: integer('screen1_prompt_version_id'),
  creativeBriefSnapshot: text('creative_brief_snapshot'),
  isStale: boolean('is_stale').notNull().default(false),  // true when screen dialogue changed after this version was created
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

export const videoGenerations = pgTable('video_generations', {
  id: serial('id').primaryKey(),
  videoScreenId: integer('video_screen_id').notNull().references(() => videoScreens.id),
  promptVersionId: integer('prompt_version_id').notNull().references(() => screenPromptVersions.id),
  jobId: text('job_id'),
  status: text('status').notNull().default('pending'),    // pending | processing | completed | failed
  videoStoragePath: text('video_storage_path'),           // Supabase Storage path (replaces local path)
  mediaGenerationId: text('media_generation_id'),         // useapi.net mediaGenerationId for concatenate
  durationSeconds: integer('duration_seconds'),
  errorMessage: text('error_message'),
  creatorFeedback: text('creator_feedback'),
  claimedAt: bigint('claimed_at', { mode: 'number' }),      // lease timestamp; null = unclaimed
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

export const promptGenerationTasks = pgTable('prompt_generation_tasks', {
  id: serial('id').primaryKey(),
  videoProjectId: integer('video_project_id').notNull().references(() => videoProjects.id),
  videoScreenId: integer('video_screen_id').references(() => videoScreens.id),
  taskType: text('task_type').notNull().default('generate_prompt'), // 'extract_brief' | 'generate_prompt'
  status: text('status').notNull().default('pending'),    // pending | processing | completed | failed
  claimedAt: bigint('claimed_at', { mode: 'number' }),    // lease timestamp; null = unclaimed
  errorMessage: text('error_message'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

export const claudeConversations = pgTable('claude_conversations', {
  id: serial('id').primaryKey(),
  videoProjectId: integer('video_project_id').notNull().references(() => videoProjects.id),
  videoScreenId: integer('video_screen_id').references(() => videoScreens.id),
  messagesJson: text('messages_json').notNull().default('[]'),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

// ── Worker infrastructure ─────────────────────────────────────────────────────

export const workerLock = pgTable('worker_lock', {
  id: integer('id').primaryKey(),
  ownerToken: text('owner_token').notNull(),
  acquiredAt: bigint('acquired_at', { mode: 'number' }).notNull(),
  heartbeatAt: bigint('heartbeat_at', { mode: 'number' }).notNull(),
});

// ── Admin users ───────────────────────────────────────────────────────────────

export const adminUsers = pgTable('admin_users', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id').notNull().unique(),
  email: text('email').notNull(),
  addedAt: bigint('added_at', { mode: 'number' }).notNull(),
});

// ── Admin settings ────────────────────────────────────────────────────────────

export const adminSettings = pgTable('admin_settings', {
  id: integer('id').primaryKey().default(1),              // single-row table
  scene1HookInstruction: text('scene1_hook_instruction'), // default hook injected into Scene 1
  compilationCrf: integer('compilation_crf').notNull().default(23),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  lastSeenCredits: integer('last_seen_credits'),
  lastSeenCreditsAt: bigint('last_seen_credits_at', { mode: 'number' }),
});

// ── Video compilations ────────────────────────────────────────────────────────

export const videoCompilations = pgTable('video_compilations', {
  id: serial('id').primaryKey(),
  videoProjectId: integer('video_project_id').notNull().references(() => videoProjects.id),
  status: text('status').notNull().default('pending'),    // pending | processing | completed | failed
  claimedAt: bigint('claimed_at', { mode: 'number' }),    // lease timestamp
  outputStoragePath: text('output_storage_path'),         // Supabase Storage path of compiled video
  errorMessage: text('error_message'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

// ── Tester feedback ───────────────────────────────────────────────────────────

export const generationFeedback = pgTable('generation_feedback', {
  id: serial('id').primaryKey(),
  videoGenerationId: integer('video_generation_id').notNull().references(() => videoGenerations.id),
  userId: uuid('user_id').notNull(),                      // tester's auth uid
  hookQuality: integer('hook_quality'),                   // 1–5
  voiceDelivery: integer('voice_delivery'),
  speakingPace: integer('speaking_pace'),
  energyExpressions: integer('energy_expressions'),
  gesturesActions: integer('gestures_actions'),
  visualConsistency: integer('visual_consistency'),
  overallQuality: integer('overall_quality'),
  notes: text('notes'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

// ── Compilation scene selections ─────────────────────────────────────────────

export const compilationSceneSelections = pgTable('compilation_scene_selections', {
  id: serial('id').primaryKey(),
  compilationId: integer('compilation_id').notNull().references(() => videoCompilations.id),
  videoScreenId: integer('video_screen_id').notNull().references(() => videoScreens.id),
  videoGenerationId: integer('video_generation_id').notNull().references(() => videoGenerations.id),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

// ── Project testers ───────────────────────────────────────────────────────────

export const projectTesters = pgTable('project_testers', {
  id: serial('id').primaryKey(),
  videoProjectId: integer('video_project_id').notNull().references(() => videoProjects.id),
  userId: uuid('user_id').notNull(),
  invitedAt: bigint('invited_at', { mode: 'number' }).notNull(),
}, (table) => ({
  uniqueProjectUser: unique().on(table.videoProjectId, table.userId),
}));

// ── B-roll Library ───────────────────────────────────────────────────────────

export const brollClips = pgTable('broll_clips', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  title: text('title').notNull(),
  storagePath: text('storage_path').notNull(),
  thumbnailStoragePath: text('thumbnail_storage_path'),
  signedUrl: text('signed_url'),
  signedUrlExpiresAt: bigint('signed_url_expires_at', { mode: 'number' }),
  thumbnailSignedUrl: text('thumbnail_signed_url'),
  thumbnailSignedUrlExpiresAt: bigint('thumbnail_signed_url_expires_at', { mode: 'number' }),
  mimeType: text('mime_type').notNull().default('video/mp4'),
  fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }),
  durationSeconds: integer('duration_seconds'),
  aiTags: text('ai_tags'),                    // JSON string[]
  aiMood: text('ai_mood'),
  aiSceneType: text('ai_scene_type'),
  aiSubjects: text('ai_subjects'),             // JSON string[]
  aiSummary: text('ai_summary'),
  processingStatus: text('processing_status').notNull().default('pending'), // pending | processing | completed | failed | skipped
  processingError: text('processing_error'),
  claimedAt: bigint('claimed_at', { mode: 'number' }),
  reviewStatus: text('review_status').notNull().default('unreviewed'),     // unreviewed | approved | rejected
  reviewedAt: bigint('reviewed_at', { mode: 'number' }),
  reviewedBy: uuid('reviewed_by'),
  userTags: text('user_tags'),                 // JSON string[]
  category: text('category'),
  notes: text('notes'),
  qualityRating: integer('quality_rating'),    // 1–5
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

// ── Analytics ─────────────────────────────────────────────────────────────────

export const analyticsEvents = pgTable('analytics_events', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  videoProjectId: integer('video_project_id').references(() => videoProjects.id),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});
