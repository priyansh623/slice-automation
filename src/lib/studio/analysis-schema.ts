import { METADATA_TEXT_FIELDS } from './metadata';

/** Which model reads the images. STUDIO_ANALYSIS_MODEL, then the B-roll setting, then the model the B-roll analysis already uses. */
export const studioAnalysisModel = (): string => process.env.STUDIO_ANALYSIS_MODEL || process.env.BROLL_ANALYSIS_MODEL || 'claude-sonnet-5-5';

/** Bumped when the prompt or schema change, so an image's metadata records which version produced it. */
export const ANALYSIS_VERSION = 1;

export const ANALYSIS_TOOL = 'record_image_metadata';

const DESCRIPTIONS: Record<(typeof METADATA_TEXT_FIELDS)[number], string> = {
  environment: 'Where the scene takes place (for example "modern open-plan kitchen", "airport departure hall", "city street at dusk").',
  activity: 'What is happening or being done (for example "chopping vegetables", "checking a phone at a counter").',
  objects_props: 'The notable objects and props visible, as a short comma-separated list.',
  camera_angle: 'The camera angle (for example "eye level", "high angle", "low angle", "over the shoulder", "top-down").',
  framing: 'The shot size or framing (for example "close-up", "medium shot", "wide shot", "full body").',
  character_position: 'Where a person stands or sits in the frame, or where one could be placed (for example "centre, seated at table", "left third, standing"). Say "no person visible" if there is none.',
  lighting: 'The light (for example "soft natural window light", "warm tungsten evening light", "harsh midday sun").',
  composition: 'How the frame is composed (for example "rule of thirds with a clear foreground", "symmetrical, leading lines").',
  description: 'One to three plain sentences describing what the image shows.',
};

export const ANALYSIS_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    ...Object.fromEntries(METADATA_TEXT_FIELDS.map((f) => [f, { type: 'string', description: DESCRIPTIONS[f] }])),
    tags: { type: 'array', items: { type: 'string' }, description: '5 to 15 short lowercase keywords for searching (places, activities, objects, mood).' },
  },
  required: [...METADATA_TEXT_FIELDS, 'tags'],
  additionalProperties: false,
} as const;

export const ANALYSIS_SYSTEM_PROMPT = [
  'You describe still images for a library of scene reference images used to plan short videos.',
  'Always answer by calling the record_image_metadata tool, with every field filled in. Use an empty string for a field you cannot identify.',
  'Describe only what is visible. Do not guess.',
  'Never identify anyone, and do not describe a person\'s gender, age, ethnicity, body, or appearance. Describe position, action and surroundings only.',
  'Keep each field short and factual; the description is at most three sentences.',
].join('\n');
