/**
 * Turns one row of the source inventory into the imported metadata layer, keeping the SCENE and dropping the PERSON.
 *
 * A Scene Pack is defined by the scenes it holds. The person in a source image is incidental: the character reference is a
 * separate project input and replaces that person later. So nothing that describes the person (who they are, how they look,
 * what they wear) is ever imported, indexed, shown, recommended on or used to rank, filter or hide an image. What stays:
 *
 *   scene      environment, activity, scene objects, camera angle, framing, lighting, description, tags  -> `fields`
 *   composition how the subject is framed (pose, gaze, face visibility, position, scale, hands)           -> `composition`
 *              (kept for character replacement; never searched, never a filter)
 *   operational replacement-risk and brand flags, review state                                              -> `operational`
 *   technical   file facts and checksums                                                                    -> `technical`
 *
 * Every decision below is a named rule with a reason, so a run can print exactly what was kept and what was dropped.
 */
import type { ImportedLayer, MetadataRecord } from '../metadata';

/**
 * What counts as a description of a PERSON, as precisely as a text rule can be. The aim is to exclude attributes of the person in
 * the picture (who they are, how old, how they look, what they wear) and to keep every legitimate scene term: "hair salon",
 * "old building", "young audience", "slim laptop", "Indian restaurant", "wavy pattern", "a ring light" are all scenes.
 *
 * A word is therefore excluded only when it names a person or is attached to one:
 *   1. a person noun or pronoun (man, woman, he, she, mother, gen z ...), with any age, build or origin words directly before it
 *      ("young woman", "elderly man", "slim Indian guy");
 *   2. those same modifiers directly before a general person word ("young people", "elderly person", "young adult");
 *   3. appearance words that only ever describe a person (beard, moustache, stubble, complexion, bald, "dark-haired");
 *   4. descriptive hair, skin, build and age phrases ("long curly hair", "fair skin", "athletic build", "35 years old");
 *   5. clothing and personal accessories that are unambiguous (tee, jacket, jeans, sunglasses ...).
 * Not excluded on their own: person, people, old, young, adult, hair, skin, slim, athletic, curly, wavy, ring, watch, cap, chain, glasses.
 *
 * This list is the single source for the profiles, the prompts and the importer. Migration 0027 holds the same patterns in SQL
 * (studio_scene_text) so that nothing about a person can enter the search index; a test keeps the two identical and runs both on a corpus.
 * "<B>" is a word boundary (\b in JavaScript, \y in PostgreSQL).
 */
const MODIFIERS = 'young|old|elderly|middle-aged|teenage|adult|slim|athletic|muscular|bearded|bald|tall|short|fit|handsome|pretty|indian|asian|caucasian|african|european|latino|hispanic|white|black|brown|south asian|east asian';
const PERSON_NOUNS = 'man|men|woman|women|male|female|boy|girl|guy|lady|gentleman|husband|wife|mother|father|homemaker|housewife|teen|teenager|gen z|he|she|him|himself|herself';
const CLOTHING = 't-shirt|tshirt|tee|polo|sweatshirt|shirt|overshirt|jacket|hoodie|trousers|pyjama|pyjamas|pajama|pajamas|jeans|beanie|sunglasses|spectacles|bracelet|wristwatch|necklace|sneakers|loungewear';
export const PERSON_PATTERNS: readonly string[] = [
  `<B>(?:(?:${MODIFIERS})[ -]+){0,3}(?:${PERSON_NOUNS})<B>`,
  `<B>(?:${MODIFIERS})[ -]+(?:person|persons|people|adults|adult|children|child|kids|kid)<B>`,
  `<B>(?:beard|bearded|moustache|mustache|stubble|complexion|bald)<B>`,
  `<B>(?:[a-z]+[ -])?haired<B>`,
  `<B>(?:his|her|their|long|short|curly|wavy|straight|black|brown|blond|blonde|grey|gray|dark|red|tied|messy)[ -]+hair<B>`,
  `<B>hair[ -]+(?:tied|bun|ponytail|pulled)<B>`,
  `<B>(?:fair|dark|light|olive|tanned|smooth|clear|brown)[ -]+skin<B>`,
  `<B>skin[ -]+(?:tone|colou?r)<B>`,
  `<B>(?:slim|athletic|muscular|lean|stocky|curvy)[ -]+(?:build|physique|body|figure|frame)<B>`,
  `<B>[0-9]{1,2}[ -]years?[ -]old<B>`,
  `<B>aged?[ ]+[0-9]{1,2}<B>`,
  `<B>in (?:his|her) (?:early |mid |late )?(?:[2-9]0s|twenties|thirties|forties|fifties)<B>`,
  // Possessive pronouns come LAST: where a longer pattern starts at the same word ("her hair", "in her 30s") the longer one must win in
  // JavaScript (first alternative) exactly as it does in PostgreSQL (longest match).
  `<B>(?:his|her|hers)<B>`,
];
export const CLOTHING_PATTERN = `<B>(?:${CLOTHING})<B>`;
const toJs = (src: string) => src.replace(/<B>/g, '\\b');
const PERSON_RE = new RegExp(PERSON_PATTERNS.map(toJs).join('|'), 'i');
const INDEX_RE = new RegExp([...PERSON_PATTERNS, CLOTHING_PATTERN].map(toJs).join('|'), 'gi');
const norm = (t: string) => t.replace(/_/g, ' ');
/** True if the text names or describes a person (not clothing; see mentionsIndexedPerson). */
export const mentionsPerson = (text: string): boolean => PERSON_RE.test(norm(text));
/** The text with every person or clothing description removed: what the search index and the recommendation profiles may keep of it. */
export const stripPersonWords = (text: string): string => norm(text).replace(INDEX_RE, ' ').replace(/\s+/g, ' ').trim();
/** True if the text holds a person or clothing description that must not be indexed or used as a recommendation signal. */
export const mentionsIndexedPerson = (text: string): boolean => { INDEX_RE.lastIndex = 0; const hit = INDEX_RE.test(norm(text)); INDEX_RE.lastIndex = 0; return hit; };

/** Possessives are the only person words the inventory's activity text uses ("scrolling her phone"). They become "the". */
export function neutralisePossessives(text: string): string | null {
  const t = text.replace(/\b(his|her)\b/gi, 'the');
  return mentionsPerson(t) ? null : t;
}

export type Rule = { class: 'scene' | 'worn' | 'person' | 'expression'; reason: string };

/** Clothing and personal accessories: worn by the person, not part of the scene. */
const WORN = /(^|\b)((round |reading )?glasses$)|\b(tee|t-?shirt|tshirt|polo|sweatshirt|shirt|overshirt|jacket|hoodie|tank|sleeveless|trousers|pyjama|pajama|jeans|cargo|shorts|beanie|cap|hat|bracelet|wristwatch|watch|ring|necklace|chain|sunglasses|spectacles|thread band|wrist wraps?|sneakers|shoes|loungewear|linen|apron)\b/i;
/** Things that look like clothing words but are scene objects (kitchenware, glassware, kitchen textiles). */
const SCENE_EXCEPTIONS = /\b(wine glass(es)?|drinking glass(es)?|glass(es)? (door|jar|front)|oven glove|tea towel|bedsheet|cushion|curtain)\b/i;
/** Equipment that makes a scene recognisable even though a person holds it: it IS scene content. */
const SCENE_GEAR = /\b(laptop|phone|smartphone|mug|cup|card|receipt|wallet|bill|microphone|mic|barbell|dumbbell|dumbbells|machine|rack|pole|handlebar|motorcycle|tongs|pan|pot|bowl|plate|pizza|box(es)?|boxes)\b/i;

/** Classifies one object or prop term. Equipment and surroundings are scene content; clothing and personal accessories are not. */
export function classifyProp(term: string): Rule {
  const t = term.trim();
  if (mentionsPerson(t)) return { class: 'person', reason: 'names or describes a person' };
  if (SCENE_EXCEPTIONS.test(t)) return { class: 'scene', reason: 'kitchenware, glassware or furnishing, not clothing' };
  if (WORN.test(t) && !SCENE_GEAR.test(t)) return { class: 'worn', reason: 'clothing or a personal accessory' };
  return { class: 'scene', reason: 'an object or prop in the scene' };
}

const EXPRESSION_TAGS = new Set(['smiling', 'surprised', 'thinking', 'focused', 'disappointed', 'thumbs up', 'confident', 'happy']);
/** Classifies one tag or script concept. */
export function classifyTag(tag: string): Rule {
  const t = tag.trim().toLowerCase().replace(/_/g, ' ');
  if (mentionsPerson(t)) return { class: 'person', reason: 'names or describes a person' };
  if (EXPRESSION_TAGS.has(t)) return { class: 'expression', reason: 'a facial expression, not a scene' };
  if (WORN.test(t) && !SCENE_EXCEPTIONS.test(t)) return { class: 'worn', reason: 'clothing or a personal accessory' };
  return { class: 'scene', reason: 'a scene, place, activity or object' };
}

const humanise = (v: string): string => v.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
const clean = (v: string | undefined): string => (v ?? '').replace(/\s+/g, ' ').trim();
const list = (v: string | undefined): string[] => clean(v).split(';').map((x) => x.trim()).filter(Boolean);
const sentence = (v: string): string => (/[.!?]$/.test(v) ? v : `${v}.`);

/** The columns of the inventory CSV that this module reads. */
export interface InventoryRow {
  [column: string]: string;
}

/** Replacement-risk and brand flags that are kept. The rest describe the person (accessories, outfit, identity continuity) and are dropped. */
export const KEPT_FLAGS = new Set([
  'FACE_NOT_VISIBLE', 'FACE_PARTIAL', 'SMALL_SUBJECT', 'CROPPED_SUBJECT', 'HAND_OBJECT_INTERACTION', 'MULTI_PERSON_BG', 'REFLECTION',
  'BRAND_UI', 'BRAND_TEXT', 'REGIONAL_SIGNAGE', 'NIGHT_LOW_LIGHT', 'LENS_FLARE', 'ALT_DIMENSION', 'NEAR_DUP_COMPOSITION', 'NEAR_DUP_BG', 'FILENAME_MISMATCH',
]);
export const DROPPED_FLAGS = new Set(['ACCESSORY', 'OUTFIT_DIFFERS', 'IDENTITY_CONTINUITY_UNCONFIRMED']);

export interface ProjectionAudit {
  droppedProps: Array<{ term: string; reason: string }>;
  droppedTags: Array<{ term: string; reason: string }>;
  droppedText: string[];
  droppedFlags: string[];
}

export interface Projection { imported: ImportedLayer; audit: ProjectionAudit }

/** Projects one inventory row. `nameOf` resolves a sibling file name in the same source folder to its permanent image ID. */
export function projectRow(row: InventoryRow, opts: { nameOf?: (file: string) => string | undefined } = {}): Projection {
  const audit: ProjectionAudit = { droppedProps: [], droppedTags: [], droppedText: [], droppedFlags: [] };

  const props: string[] = [];
  for (const t of list(row.objects_props)) {
    const r = classifyProp(t);
    if (r.class === 'scene') props.push(t); else audit.droppedProps.push({ term: t, reason: r.reason });
  }

  const tags: string[] = [];
  for (const raw of [...list(row.semantic_tags), ...list(row.script_concepts), clean(row.indoor_outdoor), clean(row.time_of_day)]) {
    if (!raw) continue;
    const r = classifyTag(raw);
    const tag = humanise(raw).toLowerCase().slice(0, 40);
    if (r.class === 'scene') { if (!tags.includes(tag)) tags.push(tag); } else audit.droppedTags.push({ term: raw, reason: r.reason });
  }

  // description = where it is + what is going on, from the two scene fields of the inventory. The inventory's own
  // "scene_description" opens with the person ("Man in white tee ...") and is therefore not used.
  const env = clean(row.env_detail);
  let act = clean(row.activity_detail);
  if (mentionsPerson(env)) { audit.droppedText.push('env_detail'); }
  if (act) {
    const n = neutralisePossessives(act);
    if (n === null) { audit.droppedText.push('activity_detail'); act = ''; } else act = n;
  }
  const description = [mentionsPerson(env) ? '' : env, act].filter(Boolean).map(sentence).join(' ');

  const lighting = [humanise(clean(row.lighting_type)), clean(row.lighting_detail)].filter(Boolean).join(' - ');

  const fields: MetadataRecord = {};
  const put = (k: keyof MetadataRecord, v: string | string[] | undefined) => { if (Array.isArray(v) ? v.length > 0 : v) fields[k] = v as never; };
  put('environment', humanise(clean(row.env_type)));
  put('activity', humanise(clean(row.activity_primary)));
  put('objects_props', props.join(', '));
  put('camera_angle', humanise(clean(row.camera_angle)));
  put('framing', humanise(clean(row.shot_type)));
  put('character_position', [humanise(clean(row.subject_position)), humanise(clean(row.subject_scale))].filter(Boolean).join(', '));
  put('lighting', lighting);
  put('description', description);
  put('tags', tags);

  const composition: NonNullable<ImportedLayer['composition']> = {};
  const comp = (k: keyof typeof composition, col: string) => { const v = humanise(clean(row[col])); if (v && !mentionsPerson(v)) composition[k] = v; else if (v) audit.droppedText.push(col); };
  comp('pose', 'body_pose'); comp('gaze', 'gaze_direction'); comp('face_visibility', 'face_visibility'); comp('subject_position', 'subject_position'); comp('subject_scale', 'subject_scale');
  const hands = clean(row.hands_note); if (hands && !mentionsPerson(hands)) composition.hand_interaction = hands; else if (hands) audit.droppedText.push('hands_note');

  const allFlags = list(row.flags);
  const flags = allFlags.filter((f) => KEPT_FLAGS.has(f));
  audit.droppedFlags.push(...allFlags.filter((f) => !KEPT_FLAGS.has(f)));
  const brandTexts = clean(row.brand_or_text_in_scene);
  const operational: NonNullable<ImportedLayer['operational']> = {
    flags,
    brand: {
      slice: flags.includes('BRAND_UI') || undefined,
      third_party: flags.includes('BRAND_TEXT') || undefined,
      notes: brandTexts && !/^none$/i.test(brandTexts) && !mentionsPerson(brandTexts) ? [brandTexts] : undefined,
    },
  };
  if (opts.nameOf) {
    const dups = list(row.near_duplicate_composition_with).map((f) => opts.nameOf!(f.split('/').pop()!.trim())).filter((x): x is string => !!x);
    if (dups.length) operational.near_duplicates = dups;
  }
  // The flag notes are free text written about the picture and include descriptions of the person: they are not imported.
  if (clean(row.flag_notes)) audit.droppedText.push('flag_notes');

  const imported: ImportedLayer = { fields, composition, operational };
  return { imported, audit };
}
