/**
 * Vision pass that writes an Imagine clip's prompt in MiniMax H3 I2VA form.
 *
 * The studio's video button used to post the composer text straight into
 * `MiniMaxH3ImageToVideo.prompt`. H3 is conditioned on a structured prompt —
 * shot marker, `integrated_multimodal_description`, `overall_soundscape`,
 * `non_diegetic_music` — so a bare sentence like "si gira e sorride" reached
 * the sampler with none of the fields it reads, and the still it was supposed
 * to animate was never looked at. This runs the auxiliary vision model on that
 * still and has it write the four fields around the user's intent.
 * @module tool-comfy/video-prompt
 */

import type { ImagineHost } from '../../src/host.ts'
import { eyesOf } from './eyes.ts'
import { lookWith } from './imagine-models.ts'
import type { ModelRoute } from '../../../shared/imagine-types.ts'
import { labelledValue, stripFences } from './model-json.ts'

/*
 * No fixed wait on the vision pass (2026-09-21). It used to give up after 90 s
 * (135 for a continuation) and send H3 the user's bare line, on the theory
 * that a slow model should cost grounding rather than the clip. It cost the
 * clip: a bare line is exactly what H3 fills with a voice, and Qwen3.8 on
 * llama.cpp thinks for ~95 s before it writes. The render after it takes
 * minutes anyway, and the job's own deadline and cancel still bound the wait.
 */

/**
 * How the graph treats the still the vision pass is looking at.
 *
 * `first-frame` is the image-to-video graph, where the picture is frame zero
 * and the model is told so. `reference` is the loop graph: `MiniMaxH3Loop`
 * wraps the latent's end onto its start, and a pinned frame fights that wrap
 * (measured 2026-10-29: the loop point became the largest jump in the clip),
 * so the picture rides along as `<Picture 1>` instead.
 */
type StillRole = 'first-frame' | 'reference'

/**
 * The reply format both passes ask for: the language, the realism verdict, then
 * the four fields H3 reads.
 *
 * The language has to be said. Left to itself the model answers in the
 * language of the line it was given, and it was given the user's: a short
 * Italian request still came back in English, but a long one — a beat written
 * by the story planner — came back in Italian, so one chain wrote its first
 * clip in the language H3 was trained on and its second in another. One copy, because a field renamed in one of the two
 * instructions and not the other would send the sampler a prompt
 * {@link cleanVideoPrompt} silently rejects.
 * @param seconds - the clip length the description has to cover.
 * @param intent - the composer text the user typed, which decides whether the
 *   format asks for a voice or forbids one.
 * @param still - what the picture is to the graph: the opening frame, or the
 *   reference the sampler keeps beside every step (the loop graph, since the
 *   wrap leaves no room for a pinned frame).
 * @returns the format section of the instruction.
 */
const ALIGNMENT = {
  firstFrame: 'Picture 1 is fully referenced at 0.00 seconds and belongs to [Shot 1].',
  reference: 'Picture 1 is the reference for the subject and the setting; it is not the first frame of the clip.',
} as const

/**
 * The shortest written prompt worth sending.
 *
 * Below this the description is a caption rather than a shot: it names the
 * place and the action but not the person, the wardrobe or the objects, and
 * H3 fills the gaps by inventing them — which is how a white lace top comes
 * back as a different garment halfway through a clip.
 */
const MIN_PROMPT_WORDS = 80

function h3ReplyFormat(seconds: number, intent: string, still: StillRole = 'first-frame'): string {
  return `Write the prompt in ENGLISH, whatever language the request is in: it is the language H3 was trained on, and an Italian description renders worse. The only exception is words spoken or sung, which stay in their original language as the format below says.

Reply ONLY in this format and with no other text. The first line is a verdict on the IMAGE, not on the request:

realism: yes if the image is a photograph or a real shot (real people, places, objects); realism: no if it is drawn or synthetic (anime, manga, comic, 3D render, painting, illustration, pixel art).

${still === 'reference' ? ALIGNMENT.reference : ALIGNMENT.firstFrame}

integrated_multimodal_description: [Shot 1] [style]. MANDATORY ANCHOR, 1-2 sentences: who is in the photo and what they look like (the subject shown in Picture 1, the hair with its colour, the eyes), ONE GARMENT PER ITEM with its colour and its material, the key objects and where they are. Shape to imitate: "the woman shown in Picture 1 remains ..., preserving her appearance, the white lace top, the gold drop earrings, the cream sofa behind her and the framed painting on the wall". Only AFTER the anchor write what changes, in 2-3 actions with a physically plausible rhythm up to one outcome. The camera [Push In/Pull Out/Pan Left/Pan Right/Truck Left/Truck Right/Tilt Up/Tilt Down/Pedestal Up/Pedestal Down/Arc Shot/Tracking Shot/Static Shot/Zoom In/Zoom Out/Roll/Shake Slightly/POV] with [small/large] amplitude at [slow/fast] speed.${voiceField(intent)} [Visible on-screen text (signs, subtitles): double quotes, verbatim]. [Other shots: [Shot N] At 00:XX.000, the camera cuts to ...]

overall_soundscape: [ambience and physical sounds, 1-4 sentences, ONLY what is heard: wind, footsteps, fabric, breathing, a distant engine]

non_diegetic_music: [instruments, rhythm, dynamics] or N/A if there is none

Rules: the anchor comes BEFORE the actions and is never skipped: it is what holds the face, the hair and the clothes for the whole clip, and without it the model reinvents them. After the anchor do not restate the rest of the frame (every object, every corner): tell only what changes. Prefer concrete details to abstract words ("cinematic", "beautiful"). At most 1-2 camera movements, at most 2-3 actions, and the description must cover exactly ${seconds} seconds. NO NEGATIONS ABOUT AUDIO: do not write "no singing", "no voices", "no dialogue", "no vocal sounds" or any other sentence that names a prohibition — H3 has no negative branch, a prohibition names the thing and sometimes pronounces it. Describe only what is heard.`
}

/**
 * The clause that decides whether anyone in the clip has a voice.
 *
 * The singing clause used to be unconditional, and H3 read it as a field to
 * fill: asked for a clip with nobody singing, the vision pass still wrote a
 * speaker and a line, and the model obliged — measured 2026-09-21 on a single
 * 10-second clip of a still woman, whose soundtrack carried a sung voice at
 * -14 dBFS with no track and no lyrics anywhere in the request. A user asking
 * a third time that the clip NOT sing got the same audio, because the negative
 * arrived as the brief to *reinterpret* while this clause was the format to
 * *obey*.
 *
 * So the default is inverted: silence is what the format asks for unless the
 * user's own words put a voice in the clip. The test is deliberately narrow —
 * a singing or speaking word, or a request for lyrics — because the failure
 * this guards against is the model volunteering a voice, and a wider trigger
 * would let it volunteer one again on any line that merely mentions music.
 * @param intent - the composer text the user typed.
 * @returns the speaker clause, or the silence rule when nobody speaks.
 */
function voiceField(intent: string): string {
  return wantsVoice(intent)
    ? ' [If someone speaks or sings: speaker with a stable ID (S1), voice description, then says: [Language] exact words in the original language; if off camera use "says in an off-screen voiceover" and add "while his/her lips remain completely closed"]'
    // Only a positive state, in English: "NESSUNO parla e NESSUNO canta" sat in
    // the description — the field H3 turns into narration — and the model read
    // it out loud in some clips ("niente canto, solo ambiente, musica
    // strumentale" heard in the finished video, 2026-10-31). The absence of a
    // voice comes from having no line and no speaker, not from saying so.
    : ' Her lips stay closed and still.'
}

/**
 * Whether the user's own line puts a voice in the clip.
 *
 * Read off the user's words rather than inferred from the still: the still
 * cannot say whether this clip was meant to have a voice, and the vision pass
 * is looking at one frame of a person whose mouth is already open or closed
 * for reasons that have nothing to do with the soundtrack.
 *
 * A negation of the verb is not enough to mean "no voice", because "non canta
 * bene" is a complaint about the singing rather than a request to stop it. The
 * silence rule fires only on a negated verb that carries no qualifier, or on a
 * word that names a silent clip outright, so a note about the quality of a
 * voice leaves the voice in place.
 * @param intent - the composer text the user typed.
 * @returns true when the line asks for someone to speak or sing.
 */
export function wantsVoice(intent: string): boolean {
  if (SILENT_CLIP.test(intent)) return false
  if (SILENT_VERB.test(intent)) return false
  return VOICE_WORD.test(intent)
}

/** A word that names a clip with no voice, whatever else the line says. */
const SILENT_CLIP = new RegExp([
  '\\b(?:senza voce|senza voci|no voce|niente voce|muto|muta|silenzios\\w*|strumentale',
  '|without (?:a )?voice|no vocals?|silent|instrumental)\\b',
].join(''), 'i')

/**
 * A negated verb, but only when nothing qualifies it.
 *
 * "non canta bene", "non canta a tempo" and "non canta abbastanza" all
 * describe singing that is happening, so a qualifier after the verb cancels
 * the silence reading. A modal may sit between the negation and the verb,
 * because "non deve cantare" and "non deve parlare" are how the request is
 * usually phrased. The pattern is anchored on the negation rather than on a
 * word boundary, because the user's own phrasing reaches this as typed and
 * "NON DEVE CANTARE" is all capitals.
 */
const SILENT_VERB = new RegExp([
  "(?:non|senza|does not|doesn't|no longer)(?:\\s+\\S+){0,3}?\\s+",
  '(?:cant\\w*|parl\\w*|sing\\w*|speak\\w*)(?![\\p{L}\\p{N}])',
  '(?!\\s+(?:bene|male|a tempo|abbastanza|troppo|in tempo|forte|piano',
  '|cos[iì]|pi[uù]\\s+\\w|well|properly|in time|enough))',
].join(''), 'iu')

/** A word that puts a voice in the clip. */
const VOICE_WORD = new RegExp([
  '\\b(cant\\w*|cantat\\w*|cantante|voce|vocal\\w*|lip.?sync|labiale|parla\\w*',
  '|parlato|dialog\\w*|dice|pronuncia|sussurra|urla|testo della canzone|lyrics?',
  '|sing\\w*|sings|sung|speaks?|speaking|voiceover)\\b',
].join(''), 'i')

/**
 * Instructions for the vision model writing one clip's prompt.
 *
 * The user's line is the brief and is honoured literally: the model fills in
 * the fields H3 needs around it — camera, soundscape, music — rather than
 * reinterpreting what was asked for.
 *
 * The reply also opens with a `realism:` verdict on the still itself, which
 * selects the realism LoRA for the clip. It is asked of the same pass rather
 * than a second one: the model is already looking at the frame, and a second
 * vision call would double the wait before the clip starts.
 * @param intent - the composer text the user typed.
 * @param seconds - the clip length, which bounds how many actions fit.
 * @returns the instruction sent alongside the still.
 */
function videoPromptInstruction(intent: string, seconds: number, still: StillRole = 'first-frame'): string {
  const opening = still === 'reference'
    ? `Look at this image: it is the REFERENCE PHOTO of a ${seconds}-second video — the subject and the scene to start from, not the first frame.`
    : `Look at this image: it is the first frame of a ${seconds}-second video.`
  return `${opening}

The user asked for: "${intent}"

Write the prompt for MiniMax H3 I2VA that delivers EXACTLY that request. The user's request is binding: do not replace it and do not reinterpret it, complete it with what the model needs to know (camera movement, sound ambience, music).

${voiceRule(intent)}${h3ReplyFormat(seconds, intent, still)}`
}

/**
 * What the instruction says about the soundtrack before the format begins.
 *
 * The format alone was not enough: a model that reads "nessuno canta" inside a
 * field's brackets still writes the field, because the brackets read as a slot
 * to fill rather than a condition. Saying it once, plainly, before the format
 * is what makes the silence reach the sampler.
 * @param intent - the composer text the user typed.
 * @returns the paragraph that tells the model who, if anyone, has a voice.
 */
function voiceRule(intent: string): string {
  if (wantsVoice(intent)) return ''
  return [
    '',
    'AUDIO: in this video nobody sings and nobody speaks. No lines, no (S1),',
    'no <d> tag, and no human voice even in the background.',
    'IMPORTANT: in the prompt do NOT write prohibitions or negations about audio ("no singing",',
    '"no voices", "no dialogue", "no chanting", "no sound of voices"). H3 samples at',
    'cfg 1 and has no negative branch: a prohibition names the thing and makes it appear, and some',
    'of the time it pronounces it. Describe ONLY what is heard: in overall_soundscape the ambience',
    'and the physical sounds, in non_diegetic_music the instruments. Voices are kept out by',
    'leaving every line out.',
    '',
  ].join('\n')
}

/**
 * The audio half of an H3 prompt: the two fields that decide what a clip
 * sounds like.
 */
export interface Soundtrack {
  /** The `overall_soundscape` line, without its field name. */
  readonly soundscape?: string
  /** The `non_diegetic_music` line, without its field name. */
  readonly music?: string
}

/**
 * Read a written H3 prompt's two audio fields.
 *
 * A continuation that writes its own soundscape and its own music describes a
 * different room and a different track, and H3 obliges: the ambience and the
 * score change at the seam even when the picture does not. The fields are
 * lifted off the clip being continued and handed back to the model as text it
 * must copy, so both clips are conditioned on the same sound.
 * @param prompt - a written H3 prompt, or undefined when none is known.
 * @returns the fields that were present.
 */
export function soundtrackOf(prompt: string | undefined): Soundtrack {
  if (prompt === undefined) return {}
  const soundscape = labelledValue(prompt, 'overall_soundscape')
  const music = labelledValue(prompt, 'non_diegetic_music')
  return {
    ...soundscape === undefined ? {} : { soundscape },
    ...music === undefined ? {} : { music },
  }
}

/**
 * Instructions for the vision model writing the prompt of a continuation.
 *
 * Two things separate this from a first clip, and both were drift the studio
 * could see. The still is the LAST frame of a clip that is already running, so
 * the description has to open by holding that framing — the airlock — and then
 * carry on without a cut, instead of staging the shot again from scratch. And
 * the sound has already been decided: when the clip being continued was
 * written by this same pass, its two audio fields are handed over to be copied
 * verbatim rather than invented a second time.
 * @param intent - the composer text the user typed.
 * @param seconds - the continuation's length.
 * @param carried - the audio fields of the clip being continued, when known.
 * @returns the instruction sent alongside the last frame.
 */
function extendPromptInstruction(intent: string, seconds: number, carried: Soundtrack = {}): string {
  const audio = carried.soundscape === undefined && carried.music === undefined
    ? 'The video continues: the sound ambience and the music are already running, so describe how they continue, without introducing a new ambience or a new track.'
    : `The video continues and its soundtrack is already decided. Copy these lines WORD FOR WORD, without changing a single word:
${carried.soundscape === undefined ? '' : `overall_soundscape: ${carried.soundscape}\n`}${carried.music === undefined ? '' : `non_diegetic_music: ${carried.music}`}`
  return `Look at this image: it is the LAST frame of a video that has already started. Write the prompt of the piece that continues it, ${seconds} seconds long, as if the take had never been interrupted.

The user asked for: "${intent}"

Rules of the continuation, before everything else:
- Open by holding the same framing for the first two seconds, then carry on without any cut: "Hold the same framing for the first two seconds, then continue the shot without any cut."
- Open with a ONE-sentence anchor that names who is there, what they are wearing (garment by garment, with the colour) and the objects around, then carry on: same scene, same people, same clothes and same positions, without restaging anything.
- No [Shot 2] and no camera cut: one single shot that continues.
- One single camera movement, which continues the one in progress or stays still.
- ${audio}

Write the prompt for MiniMax H3 I2VA that delivers EXACTLY the user's request inside these constraints. The user's request is binding: do not replace it and do not reinterpret it.

${h3ReplyFormat(seconds, intent)}`
}

/**
 * Keep only the prompt body when the model wraps it in prose or a fence.
 *
 * A small vision model answers the format instruction well but still likes a
 * "Ecco il prompt:" preamble or a ```` ``` ```` fence, and both would be fed to
 * the sampler as part of the conditioning.
 * @param text - the raw model reply.
 * @returns the prompt body, or undefined when no H3 prompt is in there.
 */
function cleanVideoPrompt(text: string, alignment: string): string | undefined {
  const unfenced = stripFences(text)
  const field = unfenced.search(/integrated_multimodal_description\s*:/i)
  const shot = unfenced.search(/\[Shot 1\]/i)
  const at = field >= 0 ? field : shot
  if (at < 0) return undefined
  /*
   * The alignment line is put back from ALIGNMENT rather than required from
   * the reply. Until 2026-10-31 the parser sliced from the line, so every
   * reply that wrote it *inside* the description — which was every reply of
   * that morning, with both qwen3.8 and mimo — came back empty, the studio
   * fell through to the bare intent, and H3 was left to invent the person.
   * That fallback is what the wardrobe was changing to: the prompt that
   * described the clothes never reached the sampler. A reply that names the
   * shot without the field marker is wrapped instead of discarded.
   */
  const head = unfenced.slice(0, at)
  const written = head.split('\n').map(line => line.trim())
    .find(line => /^Picture 1 is (?:fully referenced|the reference)/i.test(line))
  const body = (field >= 0 ? unfenced.slice(field) : `integrated_multimodal_description: ${unfenced.slice(shot)}`).trim()
  if (body.length === 0) return undefined
  return `${written ?? alignment}\n\n${body}`
}

/**
 * Read the `realism:` verdict the vision pass opens its reply with.
 *
 * Absent or unreadable means "not realistic": the LoRA changes how people are
 * rendered, so an unanswered question must leave the clip as it would have
 * been rather than restyle it on a guess.
 * @param text - the raw model reply.
 * @returns whether the still was judged photographic.
 */
function readRealism(text: string): boolean {
  return /^\s*realism\s*:\s*yes\b/im.test(text)
}

/**
 * Put the realism LoRA's trigger word in the prompt's style slot.
 *
 * The word conditions the sampler and belongs where H3 reads the clip's style
 * — the head of `integrated_multimodal_description`, after the shot marker.
 * The vision model is asked for the prompt, not for this token, so it is
 * placed here where its position is known rather than left to the reply.
 * @param prompt - the written H3 prompt.
 * @param token - the LoRA's trigger word.
 * @returns the prompt carrying the token once.
 */
export function applyRealismToken(prompt: string, token: string): string {
  if (token.length === 0 || prompt.includes(token)) return prompt
  const shot = /(integrated_multimodal_description:\s*(?:\[Shot 1\]\s*)?)/i
  return shot.test(prompt) ? prompt.replace(shot, `$1${token}, `) : `${token}, ${prompt}`
}

/**
 * One clause that states what is NOT there.
 *
 * At cfg 1 there is no negative branch: "no singing" names singing, and the
 * model renders (or reads out) the thing the sentence meant to remove. Only
 * clauses that name a voice — singing, dialogue, lyrics, spoken words — are
 * matched: camera and wardrobe negations are a separate (and milder) matter.
 */
const NEGATIVE_AUDIO = /(?:\bno\b|\bnot\b|\bwithout\b|\bnever\b|\bniente\b|\bnessun[oa]?\b|\bsenza\b|\bnon\b)[^.;:!?]*?\b(?:voice|voices|vocal|vocals|singing|sung|lyrics?|dialogue|dialog|spoken|speech|talking|voci|canto|cantat\w*|parlat\w*|dialogo|voce)\b/i

/** A clause that puts a human voice in the audio fields. */
const VOICE_IN_AUDIO = /\b(?:human voices?|voices?|people talking|chatter|background voices|singing|singers?|sings|humming|voci|canto|cantat\w*|parlat\w*)\b/i

/**
 * Drop the clauses a pattern matches, punctuation and all.
 * @param text - the prose to clean.
 * @param doomed - which clauses are removed.
 * @returns the cleaned prose and the clauses taken out.
 */
function dropClauses(text: string, doomed: RegExp): { text: string; stripped: string[] } {
  const stripped: string[] = []
  const kept: string[] = []
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    // A colon too: "No dialogue: only the wind" keeps its second half.
    const clauses = sentence.split(/(?<=[,;:])\s+/)
    const words = clauses.filter(clause => {
      if (!doomed.test(clause)) return true
      stripped.push(clause.trim())
      return false
    })
    const joined = words.join(' ')
      .replace(/\s+/g, ' ')
      .replace(/\s+([.!?])/g, '$1')
      .replace(/[,;]\s*([.!?])/g, '$1')
      .replace(/^[,;\s]+/, '')
      .replace(/[,;]\s*$/, '')
      .trim()
    // A sentence that was nothing but the prohibition leaves no words behind.
    if (/[A-Za-zÀ-ÿ]{3}/.test(joined)) kept.push(/[.!?]$/.test(joined) ? joined : `${joined}.`)
  }
  return { text: kept.join(' '), stripped }
}

/**
 * Take the audio prohibitions out of one field's prose.
 *
 * The same rule as {@link sanitizeH3Prompt} for the callers that compose the
 * full-reference format themselves (the object swap): a prohibition in
 * `overall_soundscape` or `non_diegetic_music` is not a direction at cfg 1, it
 * is a line of narration the model may read out.
 * @param text - the field's prose.
 * @returns the cleaned prose and the clauses taken out.
 */
export function stripAudioDirections(text: string): { text: string; stripped: readonly string[] } {
  return dropClauses(text, NEGATIVE_AUDIO)
}

/**
 * Take the audio prohibitions out of a written H3 prompt.
 *
 * The writer is told not to write them, but it is a small vision model and it
 * keeps volunteering "No close dialogue, no singing, no distinct vocal sounds
 * present" in `overall_soundscape` (measured on a live loop, 2026-10-31): the
 * sampler either renders those words as sound or, worse, speaks them, which is
 * what the user heard as "niente canto, solo ambiente, musica strumentale".
 * Removing them is the only reliable fix, because the guide's own remedy is to
 * fill both fields with the sound that IS there.
 *
 * Only the base (I2VA) shape is touched: a `detailed_description` document is
 * left alone, because there a "does not sing" is the cue that keeps a mouth
 * closed over an instrumental intro (`listeningPrompt`), and the audio of
 * those shots is copied from a supplied track anyway.
 * @param prompt - the written H3 prompt.
 * @param options - `silent`, the user asked for a clip with no voice: voice
 *   mentions in the two audio fields go too, not only the prohibitions.
 * @returns the cleaned prompt and the clauses that were removed.
 */
function sanitizeH3Prompt(
  prompt: string,
  options: { readonly silent?: boolean } = {},
): { prompt: string; stripped: readonly string[] } {
  if (!/integrated_multimodal_description\s*:/i.test(prompt)) return { prompt, stripped: [] }
  /*
   * A line being sung is not prose: it is what the model has to pronounce,
   * word for word, and it stays in the user's language. "non sento la tua
   * voce" is a lyric, not a prohibition, and the clause splitter would have
   * thrown it away — so the `<d>` tags go behind placeholders while the
   * fields are cleaned, and come back untouched.
   */
  const sung: string[] = []
  const shielded = prompt.replace(/<d>[\s\S]*?<\/d>/gi, (tag) => {
    sung.push(tag)
    return `\u0000D${String(sung.length - 1)}\u0000`
  })
  const stripped: string[] = []
  const out: string[] = []
  /** The field whose prose is being read: its body runs over several lines. */
  let name: string | undefined
  const clean = (body: string, audio: boolean): string => {
    const doomed = options.silent === true && audio
      ? new RegExp(`${NEGATIVE_AUDIO.source}|${VOICE_IN_AUDIO.source}`, 'i')
      : NEGATIVE_AUDIO
    const cleaned = dropClauses(body, doomed)
    stripped.push(...cleaned.stripped)
    return cleaned.text
  }
  for (const line of shielded.split('\n')) {
    const header = /^(integrated_multimodal_description|overall_soundscape|non_diegetic_music)\s*:\s*(.*)$/i.exec(line)
    if (header !== null) {
      name = (header[1] ?? '').toLowerCase()
      const audio = name === 'overall_soundscape' || name === 'non_diegetic_music'
      const body = clean(header[2] ?? '', audio)
      // A field whose every word was a prohibition still needs a line.
      const fallback = name === 'overall_soundscape' ? 'Room tone only.' : 'N/A'
      out.push(`${header[1] ?? name}: ${audio && body.trim().length === 0 ? fallback : body.trim()}`)
      continue
    }
    if (name === undefined) {
      out.push(line)
      continue
    }
    // Inside a field: the description's paragraphs are its body as much as the
    // first line is, and the prohibitions sit at the end of those sentences.
    if (line.trim().length === 0) {
      out.push(line)
      continue
    }
    const audio = name === 'overall_soundscape' || name === 'non_diegetic_music'
    out.push(clean(line, audio))
  }
  const cleaned = out.join('\n').replace(/\u0000D(\d+)\u0000/g, (_all, index: string) => sung[Number(index)] ?? '')
  return { prompt: cleaned, stripped }
}

/**
 * The same brief for an animated background, where the clip has to come back
 * to the frame it left from.
 *
 * The graph hands the sampler the still as its first *and* last frame, so the
 * motion it writes has to close: a clip written like an ordinary shot ends
 * somewhere else, and the seam lands on the join between two segments of the
 * loop.
 * @param intent - the composer text the user typed.
 * @param seconds - the segment's length, which bounds how much motion fits.
 * @returns the instruction sent alongside the still.
 */
function loopPromptInstruction(intent: string, seconds: number): string {
  return `${videoPromptInstruction(intent, seconds, 'reference')}

ANIMATED BACKGROUND THAT REPEATS: the clip is a LOOP — the last frame joins the first with no seam, and the graph gets that by wrapping the start onto the end while it samples. Write the prompt so the loop closes by itself:
- The photo is the REFERENCE, not the first frame: write "Picture 1 is the reference for the subject and the setting." and name the subject <Picture 1>. Identity, clothes and setting stay those of the photo for the whole clip.
- Locked camera: "Locked-off static camera, no pan, no zoom." No camera movement, no cut.
- One clear subject doing ONE continuous or cyclic thing (breathing, swaying, turning, pulsing, floating, drifting), always in the same spot of the frame.
- No timelines and no "then"/"finally"; no event that is used up (a bite, a blink, an object appearing): at every pass it would be back where it started and it would read as a cut.
- Nothing that accumulates (puddles, growing smoke, footprints): describe the final state as already present from the first frame.
- Light, ambience and sound stable and even; no single sound event and no music with a rhythm to close. Close the description with "Continuous, smooth, unbroken motion throughout."`
}

/** Which H3 prompt a vision pass writes: a clip, an animated background, a continuation. */
type H3PromptKind = 'video' | 'loop' | 'extend'

/**
 * Write a clip's H3 prompt from a still and the user's intent.
 *
 * `video` animates the still; `loop` is an animated background, whose motion
 * has to come back to the frame it left from; `extend` continues a clip from
 * its last frame, with the airlock and the soundtrack of the clip being
 * continued when it is known.
 *
 * Never throws: a missing vision override, a slow model or a reply in the
 * wrong shape all fall back to the user's own text, because losing the clip
 * would be worse than sending a prompt that is merely unstructured. A clip
 * that falls back is not realistic either — the verdict travelled in the
 * reply that did not arrive.
 * @param ctx - the host context, which may carry the auxiliary service.
 * @param imagePath - absolute path of the still being read.
 * @param intent - the composer text the user typed.
 * @param seconds - the clip (or segment) length in seconds.
 * @param kind - which prompt to write.
 * @param options - `carried`, the audio fields of the clip being continued
 *   (`extend` only); `chosen`, the model the chip showed when the job started.
 * @returns the written prompt with the still's realism verdict, or undefined
 *   to keep the raw prompt.
 */
export async function writeH3Prompt(
  ctx: ImagineHost,
  imagePath: string,
  intent: string,
  seconds: number,
  kind: H3PromptKind,
  options: { readonly carried?: Soundtrack; readonly chosen?: ModelRoute } = {},
): Promise<{ prompt: string; realistic: boolean } | undefined> {
  const instruction = kind === 'extend'
    ? extendPromptInstruction(intent, seconds, options.carried ?? {})
    : kind === 'loop' ? loopPromptInstruction(intent, seconds) : videoPromptInstruction(intent, seconds)
  const alignment = kind === 'loop' ? ALIGNMENT.reference : ALIGNMENT.firstFrame
  return visionPass(ctx, imagePath, instruction, alignment, options.chosen, !wantsVoice(intent))
}

/** The longest scene a chained clip renders in one go, as Openjutsu's plans do. */
export const CHAIN_SCENE_SECONDS = 6

/**
 * The scenes a chained clip is cut into: as few as fit in six seconds each,
 * of equal length.
 * @param seconds - the whole clip.
 * @returns each scene's length in seconds.
 */
export function chainSceneSeconds(seconds: number): number[] {
  const count = Math.max(1, Math.ceil(seconds / CHAIN_SCENE_SECONDS - 1e-9))
  const each = Math.round((seconds / count) * 100) / 100
  return Array.from({ length: count }, () => each)
}

/** How a continuation scene opens: the graph carries the overlap, the prompt must not restage it. */
const CHAIN_CONTINUE = 'Continue directly from the incoming H3 Motion Context: same place, same people, same clothes, same light, one continuous take with no cut; begin the new action only after the carried overlap.'

function chainPromptInstruction(intent: string, scenes: readonly number[], carried?: Soundtrack, loop = false): string {
  const total = Math.round(scenes.reduce((a, b) => a + b, 0) * 100) / 100
  const blocks = scenes.map((length, index) => index === 0 && carried === undefined
    ? `=== SCENE 1 === (${String(length)} seconds, starts from this image)`
    : `=== SCENE ${String(index + 1)} === (${String(length)} seconds, continues ${index === 0 ? 'the clip this image ends' : `scene ${String(index)}`})`).join('\n')
  const opening = carried === undefined
    ? `Look at this image: it is the first frame of a ${String(total)}-second video. The video is ONE continuous take rendered as ${String(scenes.length)} consecutive scenes; each scene after the first continues exactly where the previous one ends.`
    : `Look at this image: it is the LAST frame of a video that has already started. Write the ${String(total)} seconds that continue it, as ONE continuous take rendered as ${String(scenes.length)} consecutive scenes, every one of them a continuation — scene 1 continues the clip, each next scene continues the one before. ${carried.soundscape === undefined && carried.music === undefined ? 'The soundscape and the music are already running: describe how they continue, without introducing new ones.' : `The soundtrack is already decided: copy these lines word for word in every scene.${carried.soundscape === undefined ? '' : `\noverall_soundscape: ${carried.soundscape}`}${carried.music === undefined ? '' : `\nnon_diegetic_music: ${carried.music}`}`}`
  return `${opening}

The user asked for: "${intent}"

${loop ? `It is a SEAMLESS LOOP: the last scene ends exactly on this opening frame — the same pose, position, expression and framing — so the video can repeat with no jump. Plan a gentle motion that leaves and comes back; the last scene's description says it settles back into the opening pose and reaches it on its final frame.

` : ''}Split the user's request across the scenes in time order: every scene carries its own part of the action and of anything said, and nothing — no action, no spoken line — is repeated in two scenes. The user's request is binding: do not replace it and do not reinterpret it.

${voiceRule(intent)}Reply with exactly these ${String(scenes.length)} blocks, each opened by its header line written as shown, and nothing else:
${blocks}

The first line of the reply, before SCENE 1, is the realism verdict on the IMAGE (realism: yes for a photograph or a real shot, realism: no for anything drawn or synthetic).

Each block is one MiniMax H3 prompt in this format:
${h3ReplyFormat(scenes[0] ?? CHAIN_SCENE_SECONDS, intent).replace(/^[\s\S]*?\n\n(?=integrated_multimodal_description)/, '')}

For ${carried === undefined ? 'scenes 2 and after' : 'every scene'}, the description opens with this sentence, word for word, before the anchor: "${CHAIN_CONTINUE}" — they have no Picture 1 line, and their soundscape and music continue the ones of scene 1 without introducing new ones. Each scene's description covers exactly its own length.`
}

/**
 * Write the scene prompts of a chained clip (the Context Loop plan) from a
 * still and the user's intent, in one vision call.
 *
 * Never throws and never leaves the run without prompts: a reply that does not
 * carry every scene falls back to the single clip prompt for the first scene
 * and a plain continuation for the others, so the clip still renders.
 * @param ctx - the host context.
 * @param imagePath - absolute path of the opening still.
 * @param intent - the composer text the user typed.
 * @param scenes - each scene's length (`chainSceneSeconds`).
 * @param chosen - the model the chip showed when the job started.
 * @returns one prompt per scene with the still's realism verdict, or undefined
 *   when no model could read the still at all.
 */
export async function writeH3ChainPrompts(
  ctx: ImagineHost,
  imagePath: string,
  intent: string,
  scenes: readonly number[],
  chosen?: ModelRoute,
  carried?: Soundtrack,
  loop = false,
): Promise<{ prompts: string[]; realistic: boolean } | undefined> {
  const eyes = eyesOf(ctx, chosen)
  if (eyes === undefined) return undefined
  const silent = !wantsVoice(intent)
  // A continuation is a chain even in one scene: every scene opens on the carried overlap.
  const result = scenes.length > 1 || carried !== undefined ? await lookWith(eyes.vision, imagePath, chainPromptInstruction(intent, scenes, carried, loop), eyes.route) : undefined
  if (result !== undefined) {
    const parts = stripFences(result.text).split(/^\s*=+\s*SCENE\s*\d+\s*=+.*$/im).slice(1)
    const prompts = parts.map((part, index) => {
      const cleaned = index === 0 && carried === undefined
        ? cleanVideoPrompt(part, ALIGNMENT.firstFrame)
        : cleanVideoPrompt(part.split('\n').filter(line => !/^\s*Picture 1 is /i.test(line)).join('\n'), '')?.trim()
      return cleaned === undefined ? undefined : sanitizeH3Prompt(cleaned, { silent }).prompt
    })
    if (prompts.length === scenes.length && prompts.every(prompt => prompt !== undefined)) {
      return { prompts: prompts as string[], realistic: readRealism(result.text) }
    }
    console.warn(`[imagine] chain prompt: ${String(prompts.filter(Boolean).length)} of ${String(scenes.length)} scenes readable, falling back to one clip prompt and plain continuations`)
  }
  const first = await writeH3Prompt(ctx, imagePath, intent, scenes[0] ?? CHAIN_SCENE_SECONDS, carried !== undefined ? 'extend' : loop ? 'loop' : 'video', {
    ...chosen === undefined ? {} : { chosen },
    ...carried === undefined ? {} : { carried },
  })
  if (first === undefined) return undefined
  const sound = soundtrackOf(first.prompt)
  const next = `integrated_multimodal_description: [Shot 1] ${CHAIN_CONTINUE} The action of the previous scene carries on naturally and the camera keeps its movement.\n\noverall_soundscape: ${sound.soundscape ?? 'The same ambience continues.'}\n\nnon_diegetic_music: ${sound.music ?? 'N/A'}`
  return { prompts: [first.prompt, ...scenes.slice(1).map(() => next)], realistic: first.realistic }
}

/**
 * Run the vision model on one still and read an H3 prompt out of the reply.
 * @param ctx - the host context, which may carry the auxiliary service.
 * @param imagePath - absolute path of the still being read.
 * @param instruction - what the model is asked to write.
 * @param chosen - the model the chip showed when the job started.
 * @returns the written prompt with the still's realism verdict, or undefined.
 */
async function visionPass(
  ctx: ImagineHost,
  imagePath: string,
  instruction: string,
  alignment: string,
  chosen?: ModelRoute,
  silent = false,
): Promise<{ prompt: string; realistic: boolean } | undefined> {
  // The chip's model: the eyes are the ones the user picked.
  const eyes = eyesOf(ctx, chosen)
  if (eyes === undefined) {
    console.warn('[imagine] video prompt: no model to look at the photo, using the bare line')
    return undefined
  }
  const { route } = eyes
  /*
   * Through `lookWith`, like every other look: the studio-wide limit on looks
   * in flight applies, and on the deadline the request itself is aborted.
   * Every way out of here used to be silent, and a clip that went to H3 as a
   * bare line could not say afterwards whether the model was slow, down, or
   * had answered in a shape the parser rejects (2026-09-21).
   */
  const result = await lookWith(eyes.vision, imagePath, instruction, route)
  if (result === undefined) {
    console.warn(`[imagine] video prompt: ${route.provider}/${route.model} did not answer or failed, using the bare line`)
    return undefined
  }
  const written = cleanVideoPrompt(result.text, alignment)
  if (written === undefined) {
    console.warn(`[imagine] video prompt: answer from ${route.provider}/${route.model} unreadable, using the bare line: ${JSON.stringify(result.text.slice(0, 300))}`)
    return undefined
  }
  /*
   * A prompt under MIN_PROMPT_WORDS is not rejected — the user's clip is worth
   * more than the shape of its text — but it is said out loud, because it is
   * the signature of a description that skipped the anchor: the next clip
   * carries someone else's clothes and nothing in the log said why.
   */
  const words = written.split(/\s+/).filter(word => word.length > 0).length
  if (words < MIN_PROMPT_WORDS) {
    console.warn(`[imagine] video prompt: ${String(words)} words, under ${String(MIN_PROMPT_WORDS)}: the anchor (face, clothes, objects) may be missing`)
  }
  /*
   * A prohibition on the soundtrack is not a direction at cfg 1: it names the
   * thing and the model renders it, sometimes as speech. Taken out here, where
   * every written clip prompt passes, so a model that ignored the instruction
   * cannot put "no singing" into a sampler again.
   */
  const cleaned = sanitizeH3Prompt(written, { silent })
  if (cleaned.stripped.length > 0) {
    console.warn(`[imagine] video prompt: removed ${String(cleaned.stripped.length)} negative audio directions: ${cleaned.stripped.join(' | ').slice(0, 400)}`)
  }
  return { prompt: cleaned.prompt, realistic: readRealism(result.text) }
}
