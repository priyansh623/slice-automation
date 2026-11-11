const SKILL_V1 = `# UGC Video Prompt Skill

Converts ad scripts into structured, scene-by-scene video generation prompts optimised for Google Flow / Omni Flash. Each prompt is production-ready — character locked, dialogue split by character count, pacing controlled, audio described.

---

## Step 1 — Lock the Character

Before splitting any dialogue, extract and lock the character description from the reference image (if provided). Output as a single paragraph, no bullets.

**What to include:**
- Nationality/ethnicity as told by the user (e.g. "Indian woman", "Brazilian woman", "Korean woman") + age range
- Hair (length, texture, color)
- Skin tone
- Outfit (every visible item — top, bottom, accessories, nails)
- Prop in hand if any (mic, hanger, phone, product, baby, etc.)
- Framing style (handheld selfie, medium shot, close crop, etc.)
- Background note: the reference image is sent in R2V mode and locks the character's appearance, not the background.

**What NOT to include:**
- Room description (Google Flow generates its own background in R2V mode)
- Any detail that could drift between scenes
- Assume nationality — always wait for user to specify or ask if not provided

**Example output:**
> Brazilian woman, 28, long wavy dark hair, warm olive skin, natural minimal makeup. Wearing a white linen crop top and high-waisted beige trousers, gold hoop earrings. Hands relaxed at sides. Confident, relaxed energy.

---

## Step 2 — Split Dialogue by Character Count

Never split by word count or feel. Always split by **character count** to control pacing accurately.

**Available time slots:** 4 sec, 6 sec, 8 sec, 10 sec (Google Flow max per clip is 8 sec — flag if user picks 10 sec).

**Formula:**
- Count total characters in the full script
- Divide by total seconds across all scenes
- That gives chars/sec (usually ~11–13)
- Multiply by each scene's seconds to get target char count per scene

**Show the split first** before writing prompts. Example:
\`\`\`
Total chars: 420 | Chars/sec: 12
Scene 1 → 4 sec → 48 chars → "The easiest way to upgrade a man's look—"
Scene 2 → 6 sec → 72 chars → "start with the pants. The right color..."
\`\`\`

Ask user to confirm split before building full prompts.

---

## Step 3 — Write Scene Prompts

Each scene uses this exact format — no deviation:

\`\`\`
**Scene [N] — [Timecode start] to [Timecode end]**

**Character**
[Single para character description. Omit if user says "character stays same" — just write: Same character.]

**Dialogue**
*"[Exact dialogue for this scene]"*

**Expression**
[What her face and body do during this dialogue. Be specific — which word triggers which gesture/expression. No generic instructions.]

**Audio**
[Voice quality, pace, energy, room tone. Always end with: No music, no reverb.]
\`\`\`

---

## Expression Writing Rules

These are the core patterns that make prompts feel real vs. fake:

**DO:**
- Tie every expression note to a specific word in the dialogue: "eyebrows up on 'Men'" not "looks surprised"
- Use dry/understated delivery for confident moments: "states it like a fact, not a performance"
- Describe gesture precisely: "index finger sweeps left to right across top row, then drops to bottom row"
- Note energy shifts within a scene: "quick on hook, slows into the story"
- For finger/hand gestures: always describe direction, timing, and what triggers the drop

**DON'T:**
- "Big performative smile" — too fake
- "Excited energy" without specifics
- Generic: "she looks happy" / "she nods"
- Over-describe expressions that should be subtle

**Common expression patterns by scene type:**

| Scene type | Expression note |
|---|---|
| Hook / scroll-stopper | Dry, direct, one eyebrow up. No smile. |
| Story / recall | Soft smile, slight lean forward, eyes warm |
| Product reveal | Genuine impressed nod, not salesy |
| Feature list | Tick off fingers, one per feature |
| Cultural humour moment | Small real laugh, quick gesture relevant to the culture — ask user if unsure |
| CTA | Direct eye contact, point at lens on "yours/today", warm but not big |

---

## Audio Writing Rules

Always write audio as its own section. Key rules:

- **Selfie/handheld:** "Clean handheld selfie audio — voice close, warm, intimate, right in your ear. No echo, no reverb."
- **Seated/room:** "Clean warm indoor room audio. [Tone descriptor] voice — [confident / warm / conversational]. No music, no reverb."
- **Vlogging mic:** "Small black handheld vlogging mic held close to chin — voice warm, present, zero reverb. Soft natural room tone. No music."
- Always describe the emotional tone of the voice, not just the technical setup
- Match voice descriptor to the character's nationality and persona as specified by user (e.g. "warm Brazilian accent", "composed British voice", "upbeat Australian tone")
- If baby is in scene: explicitly write "Baby quiet and settled in arms — no crying, no fussing"
- If green screen: "Clean handheld audio" — never describe room ambience

---

## Special Scenarios

### Hook with finger gesture (green screen or layout)
When model is pointing to images that will be added in edit:
> Free hand comes up — index finger points to top left of frame — sweeps right across top row — drops down and sweeps across bottom row — like she's presenting pictures the editor will place on screen. Hand drops naturally after the last word.

### Model holding product on hanger
> Holding [product] on wooden hanger up in right hand at shoulder height, facing camera clearly. Never puts it down. Free left hand gestures for emphasis.

### Walk-in hook
> She takes one casual step forward, raises [mic/phone] to her mouth and delivers the line. Lands in frame with [expression].

### No background description rule
Never describe the room in the prompt body. The reference image is submitted in R2V mode and locks the character's appearance. Google Flow generates its own background.

---

## Timing Reference

| Chars | Approx seconds |
|---|---|
| 44–52 | 4 sec |
| 65–78 | 6 sec |
| 88–104 | 8 sec |
| 110–130 | 10 sec |

Google Flow hard limit: **8 seconds per clip**. If user requests 10 sec, flag it and suggest splitting into two 5-sec clips.

---

## Output Rules

- Never describe the background in scene prompts — only in environment variant prompts
- Never write "big performative smile" or "excited energy" without specifics
- Always show the character count split before writing full prompts (user can correct)
- If user says "next" — give the next scene only, same format
- If user says "combine scene X and Y" — merge dialogue, merge expression beats, keep single audio section
- If user says "only changed scenes" — compare old vs new script, output only scenes where dialogue changed
- If user says "give para description" — output character as single clean paragraph, no bullets`;

const SKILL_V2 = `# UGC Video Prompt Skill v2

Converts UGC ad scripts into Google Flow / Omni Flash video prompts using R2V (Reference-to-Video) mode. The character reference image locks appearance, not the background.

---

## 1. Reference Image Handling

The reference image is submitted via referenceImage_1 (R2V mode). It locks the character's appearance across all scenes. It does not pin or lock the background.

When writing the Character section:
- Describe what is visible in the reference image: hair, skin tone, outfit, accessories, props held, framing
- Use one phrase for overall energy: "confident and direct", "warm and conversational", etc.
- Do not describe the background or room

Do not describe nationality unless the creator specifies it. Do not guess from the image or name.

---

## 2. Scene Timing by Word Count

Count spoken words. Use these estimates:

| Words | Duration |
|---|---|
| 10-15 | 4 seconds |
| 18-24 | 6 seconds |
| 28-36 | 8 seconds |
| 38-50 | 10 seconds |

All four durations (4, 6, 8, 10 seconds) are supported by omni-flash.

For Hinglish or bilingual scripts: add 10-15% to the estimate. Language switches and pauses add time.

Split dialogue at natural spoken units: complete thoughts, sentence ends, natural pauses. Never split mid-phrase or mid-sentence.

---

## 3. Voice Identity

Every project has a consistent voice. Establish it in Scene 1 and carry it through all scenes.

Describe in three dimensions:
- Texture: warm, dry, breathy, direct, conversational
- Pace: unhurried, measured, energetic, quick
- Accent or register: only if specified by the creator

In subsequent scenes, reference the same voice. Only note shifts when the script's tone clearly changes (e.g., a CTA that is more urgent than the body copy).

---

## 4. Scene Prompt Format

\`\`\`
**Scene [N] - [duration]s**

**Character**
[Scene 1: full description from the reference image. Scenes 2+: "Same character." unless something changes - outfit swap, prop change, or different framing.]

**Dialogue**
*"[Exact dialogue verbatim. No paraphrasing or summarising.]"*

**Expression**
[One or two specific, purposeful notes - or write: No deliberate gesture. Default is restrained: natural delivery, no added movement.]

**Audio**
[Voice texture, pace, and delivery. Two sentences. End with: No music, no reverb.]
\`\`\`

---

## 5. Expression Rules

The default is restrained. Do not add movement for its own sake.

Add an expression only when:
- The line is a genuine question or reveal and a natural reaction would be expected
- The line references a physical product and a brief, natural gesture fits the moment
- The scene is a CTA and directness is called for

Expression rules:
- Maximum two specific actions per scene
- No smile unless warmth is natural to the line
- No word-by-word choreography (tying every gesture to a specific word)
- No generic energy descriptions: not "excited", not "enthusiastic", not "animated"

**Avoid:**
- "Big smile"
- "Excited energy"
- "Gestures enthusiastically"
- Any expression that reads as performative or overly rehearsed

---

## 6. Feedback Interpretation

When asked to revise a prompt, follow these rules:

1. Identify exactly what was criticised. Assume everything else is fine.
2. Change only what was criticised. Preserve: character description, dialogue, timing, audio format.
3. If feedback uses "across all scenes", "throughout", "in every scene", "his voice throughout", or similar language: apply the change to this scene and note it may be project-wide.
4. Do not creatively interpret ambiguous feedback. Ask one clarifying question if the meaning is genuinely unclear.
5. Return the complete revised prompt, not just the changed section.

Common phrases and how to handle them:
- "More energy" - increase pace descriptor in Audio; optionally add one restrained expression note
- "Less gestures" or "tone it down" - remove or simplify Expression section
- "Sounds scripted" or "too rehearsed" - simplify Expression to default restrained baseline
- "Voice feels off" - revise Audio tone and texture description
- "Wrong vibe" - ask one clarifying question before revising

---

## 7. Validation Checklist

Before returning any prompt, verify:
- Dialogue section contains the full dialogue verbatim
- Scene duration is consistent with the word count
- No contradictory directions in the same scene (e.g., "intimate whisper" and "projects loudly to camera")
- Expression has at most two specific actions, or is written as "No deliberate gesture"
- Audio voice description is consistent with the established voice identity
- No background or room description in any scene section`;

const SKILL_V3 = `# UGC Video Prompt Skill — Slice-first

Converts ad scripts into scene-by-scene Google Flow / Omni Flash prompts. Built around Slice ads (UPI credit card, digital savings account): Indian creators, English or Hinglish, convincing-friend energy, solo talking-head, two-person podcast, and real-life skit formats.

Every prompt must be self-contained and paste-ready: Flow generates each clip independently and remembers nothing from the previous one. The rules below come from real generation failures and fixes. Treat them as hard rules. For non-Slice brands, see Other brands at the end.

---

## Hard rules (never break)

- Never change the script wording. Not one word. If something looks like a typo (e.g. "interest fee" vs "interest-free"), keep it and flag it in one line. Never drop claim qualifiers ("up to", "tak").
- Full character description in every scene. Never "Same character" or "Same as above".
- Audio block identical, word for word, in every scene. Line-specific delivery goes in Dialogue/Expression, never in Audio.
- Hook is always its own scene (~4 sec).
- Never split a sentence across scenes.
- As few scenes as possible. Use the longest clips the cap allows; 4/6 sec only when a sentence can't group cleanly.
- No bullet points inside any prompt section. Bullets break Flow. Prose only.
- No background music.
- Same voice, tone, loudness and energy across all scenes unless the user asks for a shift.
- Measure character counts with Python (Bash), never by eye.
- No finger counting, no pointing, hands never touch face/head/hair/glasses, nothing over-dramatic.

---

## Slice basics

Products and claims seen in scripts: Slice UPI Credit Card (RuPay credit card linked to your UPI app, scan any QR and pay by credit card; up to 3% cashback on UPI spends; split big purchases into 3 interest-free installments; weekly rewards / additional discounts on clothing, travel, groceries; monthly billing and interest-free period; all transactions in one place), Slice Digital Savings Account. Use the script's claims exactly as written.

**Pronunciation (always in Audio paragraph 2):**
- "slice" → "slyce"
- "UPI" → the letters "U-P-I"
- "%" → "percent" ("3%" → "three percent")
- Rupee amounts in English words ("₹25,000" → "twenty-five thousand rupees", "₹1500" → "fifteen hundred rupees")
- Add any new term from the script the same way (e.g. RuPay, CIBIL) and confirm with the user if unsure.

Language: English with a natural urban Indian accent, or Hinglish (Hindi with English words). Keep all instructions in English even when the dialogue is Hinglish.

Default persona: an Indian creator talking to a close friend about a money hack that genuinely helped them. Warm, lively, genuinely convincing. Never salesy, never announcer, never reading a script.

Script angles you'll see: relatable money hack ("I used to overspend with no cashback"), freelancer cards, second UPI credit card, credit-score building, travel and student budgeting, kirana/shop QR payment skits.

---

## Formats

### A. Solo talking-head (direct to lens)
One creator, holding a small wireless mic at the chest or chin, looks straight into the lens like it's a close friend. Uses Character + Audio templates below as-is.

### B. Two-person podcast (host + guest)
Host (Speaker 1) asks; guest (Speaker 2) gives the advice. Each speaker gets their own clip, own locked Character block, and they share one locked Audio block that describes both voices and says "Only the on-screen speaker talks." Eye-line: each looks off-camera at the co-host (state frame left/right), never into the lens, unless the user says otherwise. Guest persona that worked: "fun and very casual, like chatting with a close friend over chai, but the advice lands serious and credible, never jokey or salesy." Host reactions are silent reaction cutaways (mouth closed throughout, no lip movement; relatable / curious / impressed). Say where each goes in the edit. If a host line is followed by a smile, write it as a separate silent reaction clip.

### C. Skit (shop / real-life)
Separate labelled blocks for every character in frame: Character — Customer, Character — Shopkeeper. If the phone screen is shown, add UI — Phone Screen: exact numbers and text from the uploaded UI reference, "No text drift, no invented UI elements, no altered numbers." Phone is held flat and steady over the QR, no shake. Optional faint UPI success beep timed to the end of the line.

---

## Step 1 — Lock the Character

One prose paragraph from the reference image, pasted into every scene.

Order:
1. Clean video frame with absolutely no text of any kind.
2. "Indian man/woman" (or as the user specifies) + age, city if given.
3. Hair (in full), facial hair, glasses, skin tone, earrings/chains.
4. Outfit, every visible item. Logos on caps/clothes as "small, blurred, unreadable".
5. Position and prop: seated/standing/reclining, which hand holds the mic, "never puts it down". Podcast: "black podcast mic on a boom arm in front of his chest at frame right".
6. One short background line matching the reference ("plain white wall in bright, soft daylight" / "purple-pink studio lighting").
7. Framing: shot size, static camera, vertical 9:16, natural UGC look.
8. Camera framing and distance must exactly match the reference image: same crop, same distance from subject, same eye-line. No zooming in, no zooming out, no reframing across scenes.
9. Eye-line: He looks straight into the lens as if it's his close friend sitting across from him. (podcast: He looks off-camera toward frame left at his co-host, never into the lens.)
10. Warm, lively, convincing friend energy, kept identical in every scene.
11. No other people or objects added. [Upload reference image as start frame to lock background.]

Reference image rule: Flow copies whatever is in the start frame. Remove unwanted props/text, swap branded app UI, or add a visible mic in Nano Banana before generating. Flag mismatches before writing prompts.

**Example (solo):**
Clean video frame with absolutely no text of any kind. Young Indian man, mid-20s, short dark hair under a red baseball cap with a small, blurred, unreadable embroidered gold emblem. He has light stubble, fair-wheatish skin and a small silver hoop earring. He wears a plain white crew-neck t-shirt, light-wash blue jeans and a silver chain bracelet on his right wrist. He reclines casually on a black leather sofa, propped on his left elbow, holding a small black wireless mic with a grey fluffy windscreen in both hands at his chest. Behind him is a plain white wall in bright, soft daylight. Medium-wide shot, static camera, vertical 9:16, natural UGC look. Camera framing and distance must exactly match the reference image: same crop, same distance from subject, same eye-line. No zooming in, no zooming out, no reframing across scenes. He looks straight into the lens as if it's his close friend sitting across from him. Warm, lively, convincing friend energy, kept identical in every scene. No other people or objects added. [Upload reference image as start frame to lock background.]

**Example (podcast guest):**
Clean video frame with absolutely no text of any kind. Indian man, mid-30s, shoulder-length voluminous curly black hair with a receding hairline, thick black square-frame glasses, medium brown skin, light stubble, heavyset build. Wearing a plain white crew-neck T-shirt. Seated back, relaxed, black podcast mic on a boom arm in front of his chest at frame right. Purple-pink studio lighting. Medium shot, camera slightly off-axis, static, vertical 9:16. Camera framing and distance must exactly match the reference image: same crop, same distance from subject, same eye-line. No zooming in, no zooming out, no reframing across scenes. He looks off-camera toward frame left at his co-host, never into the lens. Fun, casual but credible energy, kept identical in every scene. No other people or objects added. [Upload reference image as start frame to lock background.]

---

## Step 2 — Lock the Audio block

Four prose paragraphs + the no-text line. Written once, pasted word for word into every scene.

**Solo template (default):**
Audio Recorded on the small wireless mic he holds at his chest: close, crisp and loud, with zero echo, zero room reverb and zero background noise.

The exact same voice in every clip: [an early-20s] Indian man with a warm, clear, bright, medium-pitched voice, speaking natural [Hinglish (Hindi with English words) / English] with a neutral urban Indian accent, not American, not British. He says "slice" as "slyce", "UPI" as the letters "U-P-I", "3%" as "three percent" and "[₹ amount]" as "[amount in words] rupees", in English.

This is a real conversation, not a script. He talks directly to a close friend, warm, energetic and genuinely convincing, like he's sharing a money hack he really uses and wants his friend to try it too. Natural conversational rhythm: casual on the small words, real punch on the key words, intonation rising and falling naturally. He smiles while talking. Never flat, monotone, robotic, rehearsed, salesy or announcer-like.

His loudness, energy, pitch range, timbre, accent and speed stay identical in every clip: lively and confident, never shouting or whispering. The pace is quick, flowing and continuous, with no breaks or pauses inside a line, no hesitations and no stutters. Voice only, no background music.

No on-screen text: no subtitles, no captions, no words on screen, no burned-in text, no lower thirds, no watermarks, no logos.

**Podcast template:**
Audio Podcast studio audio from close mics: voices close, warm and present, zero reverb, subtle studio room tone. Not a radio announcer, not a voiceover.

Both men speak [English / Hinglish] with a natural, educated, urban North Indian accent, Hindi-native, clear and articulate, neither exaggerated nor anglicised. They say "slice" as "slyce", "UPI" as "U-P-I" and "3%" as "three percent". Speaker 1 ([outfit]) has a mid-pitch, easy, curious questioning tone. Speaker 2 ([outfit]) has a mid-low, warm, slightly husky male voice, full-bodied, right up on the mic.

Speaker 2 is fun and very casual, like chatting with a close friend over chai, with pitch rising on key words and settling back down, but the advice lands serious and credible, never jokey or salesy. Only the on-screen speaker talks.

Loud, steady, projected volume that never drops or trails off at the end of lines. Loudness, pitch, timbre, accent and pace identical in every clip. Flowing and continuous, no hesitations. No music.

No on-screen text: no subtitles, no captions, no words on screen, no burned-in text, no lower thirds, no watermarks, no logos.

Female creator: swap pronouns and use "[age] Indian woman with a warm, clear, bright voice". Keep everything else.

**Persona dial (paragraph 3 only, when the user asks):**
- More energy: "high-energy, playful, punchy, big smile in the voice".
- Calmer: "calm, low, matter-of-fact, minimal emotion, like quietly telling a friend".
- Dry humour: "dry, bored-confident, understated, lets the words carry the joke".

**Audio rules learned:**
- Accent goes in both Character and Audio; always "not American, not British".
- Never use voice-texture words ("squeezed", "groan", "melodic"): they change the voice.
- Never put line-specific delivery in Audio: that causes voice drift.
- If a line sounds too quiet or trails off, strengthen "loud, steady, projected volume that never drops" in the locked block (it then applies to every scene).
- If the user shares a reference clip they like, analyse loudness and pitch (ffmpeg) and describe that voice in paragraph 2.

---

## Step 3 — Split by character count

Measure with Python. Never by word count or feel.

Clip cap: Flow / Omni Flash 1.1 clips up to 10 sec (slots 4/6/8/10). Extend chains up to ~40 sec.

Pacing: 12 chars/sec baseline. Hinglish and fast friend-energy delivery run up to 14–17 chars/sec and are workable. Flag anything faster.

| Chars | Approx seconds |
|---|---|
| 44–52 | 4 sec |
| 65–78 | 6 sec |
| 88–104 | 8 sec |
| 110–130 | 10 sec |

Clip length must match speech length. Too long → the model repeats or loops words. Too short → the line gets cut off. Sentence longer than 10 sec: don't split it. Generate the first clip, then Extend from a natural comma; write that in the scene heading, e.g. (generate 8 sec, Extend from "in one place,").

Show the split first and wait for confirmation.

---

## Step 4 — Scene format

\`\`\`
**Scene [N] — [start] to [end] ([X] sec)**

**Character**
[Full locked paragraph]

**Dialogue**
*"[exact dialogue]"*

[Delivery paragraph]

**Expression**
[Prose]

**Audio**
[Full locked block, identical every scene, ending with the No on-screen text line]
\`\`\`

**Dialogue delivery paragraph (always, under the line):**
He starts speaking on the very first frame and says the full line exactly once[, in one continuous breath, with no pauses at the commas], finishing before the clip ends. He says each word only once: no repeating, no restarting, no extra words. [He says "3%" as "three percent".] He's talking to his friend, not reading. He leans on "[key phrase]" and "[key phrase]". After "[last word]" he stops talking completely, stays silent until the clip ends and holds a smile to camera.

Key phrases to lean on in Slice lines are usually the benefit: "three percent cashback", "interest-free", "weekly rewards", "additional discounts", "directly credit card se pay".

If subtitles still burn in: switch to inline He says: "..." and put the No on-screen text line before Character as well as after Audio.

---

## Expression

One prose paragraph, two or three beats tied to quoted phrases, ending with the guard sentence.

Structure:
1. Opening phrase: one face/head move that sets up the line (lean in, raised eyebrows, teasing "wait for it" look).
2. List / middle phrase: quick, easy, relatable nods, relaxed smile; say where the free hand rests.
3. Payoff (the benefit): the biggest reaction in the scene — big convincing grin, firm nod, palm opens gently.
4. Guard: No finger counting, no pointing, nothing over-dramatic. Add "no number gestures" on percentage/amount lines; "hands never touch face, head, hair or glasses" for podcast guests with glasses.

**Worked Slice examples:**

Expression — benefit reveal: On "And the crazy part?" he leans forward slightly off the sofa back with a teasing "wait for it" look and raised eyebrows. On "I also get up to three percent cashback on all these payments" he breaks into a big, excited, convincing grin and gives a quick nod. No number gestures, no pointing, no finger counting, nothing over-dramatic.

Expression — list line (Hinglish): Through "food order karna ho, shopping karni ho ya restaurant mein bill pay karna ho" he gives quick, easy, relatable nods with a relaxed smile, and his left hand stays near his waist. On "main apne regular UPI payments par cashback kama sakta hoon" his eyebrows lift, he gives a big convincing grin, and his left hand opens gently, palm up. No finger counting, no pointing, nothing over-dramatic.

Expression — podcast guest recommendation: On "So one good option" he leans in easily toward his co-host, the smile settling into a straight, serious face. On "Slice UPI Credit Card" he gives one small, firm nod, landing the name clearly, like a genuine tip, not a pitch. His eyes stay on the co-host. Hands never touch his face, head, hair or glasses. No finger counting, no pointing, nothing over-dramatic.

Expression — silent host reaction: No dialogue. His mouth stays closed throughout, no lip movement. He listens to his co-host off-frame, eyebrows lift slightly and a small impressed half-smile spreads, followed by one slow nod. No hand movement, nothing over-dramatic.

Expression — CTA: On "Download Slice today" he looks straight into the lens, sincere and warm, like real friend advice. Easy nod on "today". After the last word his mouth closes, pitch drops and he holds a warm closed-mouth smile, still, until the clip ends. No pointing, nothing over-dramatic.

Register: natural, gentle, subtle, convincing. Turn energy up only when asked, and then use literal cues ("eyebrows shoot up", "toothy grin"), not adjectives. Turn it down (flat, dry, minimal movement) when the user says "too expressive" or "tone down the reaction".

**Don't:**
- Finger counting, ticking off features, number gestures, pointing at the lens.
- Hands touching face, head, hair, glasses; anything covering the mouth while speaking.
- Pause words ("pauses", "slows", "holds a beat", "stretched"): they insert audio gaps.
- Laughs, gasps, sighs that add sounds to the dialogue.
- Dropping/putting down the mic or phone; new objects appearing.
- Bullets, generic "he looks happy / he nods".

**Do:**
- Match the expression to what the line means.
- One arc per scene, not a gesture on every word.
- Start each scene as a fresh take (small reset, fresh head tilt).
- End every clip with a silent hold so nothing ends abruptly.

---

## Voice consistency and fixes

Flow may still give a different voice per clip. When the user reports drift or a new voice mid-chain: use Extend from the previous clip rather than a fresh Frames to Video generation, and reroll the odd take. Post-fix with ElevenLabs speech-to-speech or Higgsfield Voice Change. For level/tone mismatch and weird pauses between joined clips, run the audio clean-up pass (ffmpeg: denoise, pause-cut, loudness/EQ match). Most consistent: record the full script once in ElevenLabs and lip-sync each clip.

---

## Other brands

Same structure and hard rules. Swap: nationality/accent and its "not X, not Y" guard, pronunciation line, persona in Audio paragraph 3, and the eye-line/energy lines in Character.

- Jisr (Saudi): Najdi Arabic dialogue + transliteration, English instructions, "Jisr" never "JISR", laptop video-call eye-line, off-screen colleague with no lip-sync, controlled frustration.
- XYXX: "X-Y-X-X" / "ex-why-ex-ex".
- BlissClub / Typsy: Indian English, raw iPhone front-mic audio ("not a voiceover, not a radio or podcast voice"), product on hanger or prop mic held still.
- Ruvimo (US): American accent "not British", inline She says: dialogue to avoid subtitles.
- Special setups that still apply: hanger hold ("never puts it down, free hand gestures"), walk-in hook (one casual step forward, raises mic), green screen ("clean handheld audio"), baby in arms ("quiet and settled, no crying").

---

## Iteration commands

- "next" → next scene only, carrying forward every correction so far.
- "scene X [change]" → change only that scene.
- "combine scene X and Y" → merge into one scene, single Audio block, flag if over the cap.
- "only changed scenes" → output only scenes whose dialogue changed.
- "give para description" → character as one clean paragraph.

When the user pastes a prior prompt that worked, use it as the template and change only what they ask.`;

const SKILLS: Record<string, string> = {
  v1: SKILL_V1,
  v2: SKILL_V2,
  v3: SKILL_V3,
};

export function getSkillContent(version: string): string {
  const content = SKILLS[version];
  if (!content) {
    throw new Error(`Unknown UGC skill version: "${version}". Available: ${Object.keys(SKILLS).join(', ')}`);
  }
  return content;
}

export const AVAILABLE_SKILL_VERSIONS = Object.keys(SKILLS);
export const DEFAULT_SKILL_VERSION = 'v3';
