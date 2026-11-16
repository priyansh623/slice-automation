/** The rules that keep a person out of scene metadata, and the composition detail that stays. Pure functions, no database. */
import { describe, it, expect } from 'vitest';
import { EXCLUDED, LEGITIMATE } from './helpers/person-corpus';
import { classifyProp, classifyTag, mentionsIndexedPerson, mentionsPerson, neutralisePossessives, projectRow, stripPersonWords } from '@/lib/studio/import/scene-metadata';

describe('person words', () => {
  it('detects people, not look-alike words', () => {
    for (const t of ['man in a white tee', 'Woman standing', 'her phone', 'a bearded guy', 'curly hair', 'gen z', 'busy_homemaker', 'young adult']) expect(mentionsPerson(t), t).toBe(true);
    for (const t of ['armchair', 'cold drink', 'manual', 'the kitchen', 'ceramic mug', 'hotel lounge', 'chalkboard menu', 'womanly'.slice(0, 0) + 'wooden table']) expect(mentionsPerson(t), t).toBe(false);
  });
  it('turns the possessives of the inventory into "the", and refuses anything else about a person', () => {
    expect(neutralisePossessives('Reclining on bed scrolling her phone')).toBe('Reclining on bed scrolling the phone');
    expect(neutralisePossessives('Holding a phone beside his shoulder')).toBe('Holding a phone beside the shoulder');
    expect(neutralisePossessives('A man holds a phone')).toBeNull();
  });
});

describe('objects and props: equipment is scene, clothing is not', () => {
  it.each([
    ['laptop (apple logo visible)', 'scene'], ['phone with ring chart app screen', 'scene'], ['ceramic mug', 'scene'], ['open brown leather wallet', 'scene'], ['long thermal receipt (bill)', 'scene'],
    ['small clip on microphone', 'scene'], ['loaded barbell with red plates', 'scene'], ['trekking pole', 'scene'], ['wine glasses', 'scene'], ['orange oven glove', 'scene'], ['tan leather cushion', 'scene'], ['royal enfield motorcycle', 'scene'],
    ['white tee', 'worn'], ['black sleeveless graphic tee', 'worn'], ['olive cargo trousers', 'worn'], ['baggy blue jeans', 'worn'], ['metal bracelet', 'worn'], ['round glasses', 'worn'], ['sunglasses hooked on collar', 'worn'], ['white sneakers', 'worn'], ['wristwatch', 'worn'],
  ])('%s -> %s', (term, cls) => { expect(classifyProp(term).class).toBe(cls); });
  it('every decision carries a reason that can be printed for review', () => { expect(classifyProp('white tee').reason).toMatch(/clothing/); expect(classifyProp('laptop').reason).toMatch(/object|prop/); });
});

describe('tags', () => {
  it.each([['kitchen', 'scene'], ['work from home', 'scene'], ['gym', 'scene'], ['black_polo', 'worn'], ['white_tshirt', 'worn'], ['glasses', 'worn'], ['smiling', 'expression'], ['thumbs_up', 'expression'], ['beard', 'person'], ['homemaker', 'person'], ['gen_z', 'person']])('%s -> %s', (t, cls) => { expect(classifyTag(t).class).toBe(cls); });
});

describe('projecting an inventory row', () => {
  const row = {
    env_type: 'home_kitchen', env_detail: 'Modern kitchen with a marble counter', activity_primary: 'cooking', activity_detail: 'Tossing noodles with tongs into her bowl, smiling',
    objects_props: 'steel pan; tongs; white tee; round glasses; phone on counter', semantic_tags: 'kitchen;noodles;white_tshirt;smiling;beard', script_concepts: 'cooking_at_home;homemaker;saving_money',
    indoor_outdoor: 'indoor', time_of_day: 'day', camera_angle: 'slightly_high', shot_type: 'medium', lighting_type: 'indoor_mixed', lighting_detail: 'Overhead spots, steam visible',
    subject_position: 'center', subject_scale: 'large', body_pose: 'standing leaning forward', gaze_direction: 'down_at_food', face_visibility: 'partial_looking_down', hands_note: 'both hands hold tongs',
    persona_description: 'woman, long dark hair, white tee', scene_description: 'Woman in a white tee cooks noodles.', expression: 'calm', flags: 'FACE_PARTIAL;ACCESSORY;OUTFIT_DIFFERS;BRAND_UI', flag_notes: 'bracelet on wrist', brand_or_text_in_scene: 'none',
  };
  const { imported, audit } = projectRow(row);
  it('keeps the scene', () => {
    expect(imported.fields).toMatchObject({ environment: 'home kitchen', activity: 'cooking', objects_props: 'steel pan, tongs, phone on counter', camera_angle: 'slightly high', framing: 'medium' });
    expect(imported.fields!.description).toBe('Modern kitchen with a marble counter. Tossing noodles with tongs into the bowl, smiling.');
    expect(imported.fields!.tags).toEqual(['kitchen', 'noodles', 'cooking at home', 'saving money', 'indoor', 'day']);
  });
  it('keeps the composition for character replacement, separate from the scene fields', () => {
    expect(imported.composition).toEqual({ pose: 'standing leaning forward', gaze: 'down at food', face_visibility: 'partial looking down', subject_position: 'center', subject_scale: 'large', hand_interaction: 'both hands hold tongs' });
    expect(JSON.stringify(imported.fields)).not.toMatch(/leaning|gaze|partial|down at food/);
  });
  it('drops everything about the person and says what it dropped', () => {
    expect(JSON.stringify(imported)).not.toMatch(/woman|persona|white tee|round glasses|beard|homemaker|calm|bracelet|ACCESSORY|OUTFIT/i);
    expect(audit.droppedProps.map((d) => d.term)).toEqual(['white tee', 'round glasses']);
    expect(audit.droppedTags.map((d) => d.term).sort()).toEqual(['beard', 'homemaker', 'smiling', 'white_tshirt']);
    expect(audit.droppedFlags).toEqual(['ACCESSORY', 'OUTFIT_DIFFERS']);
    expect(audit.droppedText).toContain('flag_notes');
  });
  it('keeps the replacement-risk and brand flags', () => { expect(imported.operational!.flags).toEqual(['FACE_PARTIAL', 'BRAND_UI']); expect(imported.operational!.brand).toMatchObject({ slice: true }); });
});

describe('precision: person descriptions are excluded, legitimate scene terms are kept', () => {
  it.each(EXCLUDED)('excludes the person description in %j', (text, gone) => {
    expect(mentionsIndexedPerson(text), text).toBe(true);
    const kept = stripPersonWords(text).toLowerCase();
    for (const w of gone) expect(kept, `${text} -> ${kept}`).not.toContain(w.toLowerCase());
  });
  it.each(LEGITIMATE)('keeps the scene term %j whole', (text) => {
    expect(mentionsPerson(text), text).toBe(false);
    expect(mentionsIndexedPerson(text), text).toBe(false);
    expect(stripPersonWords(text)).toBe(text);
  });
  it('keeps what is left of a mixed text: only the person part goes', () => {
    expect(stripPersonWords('a young woman in a hair salon with an old building outside')).toBe('a in a hair salon with an old building outside');
    expect(stripPersonWords('young audience, bearded man at the mic, hair dryer')).toBe('young audience, at the mic, hair dryer');
  });
  it('classifyProp and classifyTag keep scene terms that merely contain an age, hair or build word', () => {
    for (const t of ['hair dryer', 'old fashioned lamp', 'slim laptop', 'wavy wallpaper']) expect(classifyProp(t).class, t).toBe('scene');
    for (const t of ['hair salon', 'old building', 'young audience']) expect(classifyTag(t).class, t).toBe('scene');
    expect(classifyProp('young woman').class).toBe('person');
    expect(classifyTag('bearded man').class).toBe('person');
  });
});
