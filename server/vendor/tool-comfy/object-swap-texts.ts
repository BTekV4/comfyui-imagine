/**
 * The texts an object swap is given: what to track in the clip, what the photo
 * of the new object shows, and the shot with the recipe's own instruction.
 *
 * An object swap runs on the windowed reference-to-video machinery
 * (`h3-windows.ts`, `swap-windows.ts`) that it once shared with the character
 * swap: the subject is a THING, so there is no identity to measure, no
 * costume to keep and no face to describe. What the graph still needs from the
 * host are the three texts its `StringFormat` joins — the tracker phrase, the
 * reference document and the shot document — and they change with the mode:
 *
 * - `change` puts the object of the photo where the tracked one was;
 * - `remove` takes the tracked object out of the shot;
 * - `background` replaces the setting around the tracked subject;
 * - `add` introduces an object that was not in the clip.
 *
 * The summary sentence and the retention analysis are written HERE, not asked
 * of the model: their markers (`attribute_transfer`, `partially_preserved`,
 * `fully_copy`, the `[video editing + audio reuse]` prefix) are fixed values of
 * the H3 reference format, and a paraphrase of them is a different request.
 * The vision pass writes only what it alone can see: the tracker phrase and the
 * play-by-play of the shot.
 * @module tool-comfy/object-swap-texts
 */

import { unlink } from 'node:fs/promises'
import type { ImagineHost } from '../../src/host.ts'
import { eyesOf } from './eyes.ts'
import type { ImagineObjectMode, ModelRoute } from '../../../shared/imagine-types.ts'
import { labelledValue, withoutMarkdown } from './model-json.ts'
import { h3ReferencePrompt } from './story.ts'
import { cleanAudioFields, clipStrip, readTwice } from './swap-reading.ts'

/**
 * A phrase as a text-conditioned tracker can use it.
 *
 * The phrases go to the tracker through the same CLIP the checkpoint ships: a
 * sentence there matches nothing, and a phrase carrying a full stop matches
 * nothing either.
 * @param value - the phrase the model wrote.
 * @returns the phrase without stops or quotes, at most 120 characters.
 */
function trackerPhrase(value: string): string {
  return value.replaceAll(/[."]/g, '').slice(0, 120).trim()
}

/**
 * Whether a mode carries a photo.
 *
 * `change` REQUIRES one (it is the new look of the object) and `add` will use
 * one when it has a graph. `remove` and `background` have none: their graphs
 * carry no image branch, so the gate refuses a photo sent with them instead of
 * ignoring it, because a client that sends one believes it is doing something.
 *
 * The reading below already knows what a `background` photo means — the new
 * place, not an object (`photoEntity`) — and it switches on by adding the mode
 * here the day that graph gains `ref_images`.
 * @param mode - the recipe the run asked for.
 * @returns true for the modes the photo belongs to.
 */
export function objectSwapUsesPhoto(mode: ImagineObjectMode): boolean {
  return mode === 'change' || mode === 'add'
}

/** The thing a mode's photo shows, as the H3 document names it. */
type PhotoEntity = 'object' | 'setting'

/**
 * What the mode's photo shows.
 * @param mode - the recipe the run asked for.
 * @returns the entity the reference document names.
 */
function photoEntity(mode: ImagineObjectMode): PhotoEntity {
  return mode === 'background' ? 'setting' : 'object'
}

/** The three texts the object swap graph is given. */
export interface ObjectSwapTexts {
  /** Noun phrase the segmenter looks for in the plate. */
  readonly track: string
  /** The reference document: the tracked thing, the plate, and the reused audio. */
  readonly reference: string
  /** The shot document: the summary, the play-by-play and the sound of it. */
  readonly scene: string
}

/**
 * What the vision pass is asked about the photo.
 *
 * `change` (and `add`, when it has a graph) carries a photo of an OBJECT: only
 * the object is described, never the photo's background, framing or light —
 * those come from the clip, and naming them here is how a swapped object drags
 * the photo's scene into the picture. `background` carries a photo of a PLACE
 * instead, and there it is the other way round: the place is what is wanted
 * and the people in the photo are not.
 * @param entity - what the photo shows for this mode.
 * @returns the instruction sent with the photo.
 */
function photoInstruction(entity: PhotoEntity): string {
  if (entity === 'setting') {
    return `Look at this PHOTO: it shows the new SETTING a video has to be moved into.

Reply ONLY with one line, with no other text.

setting: at most TWO ENGLISH lines describing the place as the video must show it: the space and its layout, the surfaces and their materials, the colours and the palette, the objects and furniture that belong to it, and the light it is in. Do NOT describe people, poses, framing or the camera: the people of the video stay exactly as they are.`
  }
  return `Look at this PHOTO: it shows the object to PUT INTO a video.
 
Reply ONLY with one line, with no other text.

object: at most TWO ENGLISH lines describing the object as it must appear in the video: what it is, its shape and proportions, its material and surface, its colours, its markings, text or logos and their position, and the details that make it recognisable. If somebody in the photo is wearing or holding the object, describe ONLY the object: its cut, fabric, colour and details, never the face, hair, skin, body, make-up or pose of the person. Do NOT describe the photo's background, framing, pose, light or composition.`
}

/**
 * The rule each mode gives the shot pass about the object it tracks.
 *
 * The pass writes the play-by-play of the TARGET shot, which is the plate with
 * the mode's change already applied — so each mode has to be told what the
 * target shot contains and, just as important, what it must not describe.
 * @param mode - the recipe the run asked for.
 * @param hasPhoto - whether a photo of the new object is in the run.
 * @returns the paragraph of rules for this mode.
 */
function modeRules(mode: ImagineObjectMode, hasPhoto: boolean): string {
  switch (mode) {
    case 'change':
      return `The TARGET shot is the source shot with the tracked object REPLACED by the object of the PHOTO. Write the account of the shot around it: where the tracked object is in the frame, what it is doing, how it is held, touched or moved, and how the light falls on it — but do NOT describe the look of the object that is there now, and do NOT describe the look of the object of the photo: it comes from the photo and naming it is what makes the model keep the old one. Where you would describe it, write "the object" and carry on.`
    case 'remove':
      return `The TARGET shot is the source shot with the tracked object GONE. Write the account of the shot as if the object had never been there: the surface or background behind it continues naturally, the light and the shadows stay those of the plate, and nothing moves differently. Do NOT describe the object itself, not even to say it is absent.`
    case 'background':
      return `The TARGET shot is the source shot with the SETTING replaced and the subject untouched: same person (or thing), same look, same wardrobe, same pose, same performance, same camera and same timing, in ${hasPhoto ? 'the new setting of the PHOTO' : 'the new setting the user asked for'}. Write the account of the shot with the new place in English, and do NOT describe the old setting, the subject's appearance or wardrobe: those stay exactly as they are.`
    case 'add':
      return hasPhoto
        ? `The TARGET shot is the source shot with the object of the PHOTO ADDED into the scene, where the user asked for it (or where the shot makes sense). Write the account of the shot with the object present: where it sits in the frame, what it rests on, its scale against the things around it, and how the light falls on it — but do NOT describe its look: it comes from the photo.`
        : `The TARGET shot is the source shot with one object ADDED into the scene, the one the user asked for. Write the account of the shot with that object present: where it sits in the frame, what it rests on, its scale against the things around it, and how the light falls on it.`
  }
}

/**
 * What the vision pass is asked about the plate's frames.
 *
 * Three frames of the same take, in time order, stacked: the tracker phrase has
 * to come from the plate (it is what the segmenter has to find there), and the
 * play-by-play has to be the plate's own action, not the user's imagination.
 * @param mode - the recipe the run asked for.
 * @param intent - the line the user wrote, which may be empty.
 * @param hasPhoto - whether a photo of the new object is in the run.
 * @returns the instruction sent with the strip of frames.
 */
function objectShotInstruction(mode: ImagineObjectMode, intent: string, hasPhoto: boolean): string {
  const brief = intent.trim().length === 0
    ? 'The user wrote nothing: describe the shot as it is.'
    : `The user asked for: "${intent}"`
  const what = mode === 'remove'
    ? 'the OBJECT to REMOVE from the shot: a garment, an accessory, a prop, a piece of furniture — never a person and never a body part'
    : mode === 'background'
      ? 'the subject whose setting is being replaced (the person, or the main thing in the foreground)'
      : mode === 'add'
        ? 'the place in the shot where the new object goes (a surface, a table, a hand, an empty area)'
        : 'the OBJECT to REPLACE in the shot: a garment, an accessory, a prop, a piece of furniture — never a person and never a body part'
  const trackRule = mode === 'background'
    ? 'The tracker phrase names the subject whose setting changes: the person (or the main thing) that must stay exactly as it is.'
    : `The tracker phrase names an OBJECT — clothing, an accessory, a prop, furniture. Never write "person", "woman", "man", "people", "body", "torso", "face", "hair", "hand" or any body part: in this mode the person stays who they are and only the object changes, so a phrase that names the person makes the model rewrite the person (measured 2026-11-06: "person, torso, body, clothing" turned the hand orange and swapped the face).`
  return `Look at this image: three frames IN TIME ORDER of the same TAKE, stacked from top to bottom.

${brief}

${modeRules(mode, hasPhoto)}

Reply ONLY with these labelled lines, in this order, with no other text. The sections go in ENGLISH (it is the prompt the video model reads).

track: 2-5 ENGLISH nouns, common and generic, with which an object detector finds in the plate ${what} (example: "bottle, glass", "table, surface"). No sentences, no style adjectives.

description: the body of the prompt, in ENGLISH, from 250 to 450 words, in playback order. First write ONE style sentence (light, palette, rendering), then \`[Shot 1] \` and the continuous account of the single shot: what is in frame and how it is composed, where everything sits, the setting and the light, what happens and how it changes, the camera movement (type, amplitude, speed), the sounds and the text or graphics overlaid on the picture with their position.

soundscape: one or two ENGLISH sentences about the ambience and the physical sounds that run through the whole clip.

music: in ENGLISH, the background music heard only by the viewer (instruments, tempo, dynamics), or exactly \`N/A\` if there is none.

Rules: ${trackRule} The PLACE is the one in the frames and does not move (except in the mode's rule above, which says otherwise); the SIZE of the shot must be stated with the same scale you see (extreme close-up, close-up, medium shot, full shot) without widening it; do not invent people, objects or text that are not in the frames.`
}

/** The sections of the shot reply this pass reads. */
interface ObjectSwapShot {
  /** The tracker phrase the segmenter reads. */
  track: string
  /** The 250-450 word play-by-play of the single shot. */
  description: string
  /** The ambience and physical sounds. */
  soundscape: string
  /** The audience-only score, or `N/A`. */
  music: string
}

/**
 * Read the sections of the shot reply.
 * @param text - the raw model reply.
 * @returns the tracker phrase and the written sections, or undefined.
 */
function parseShot(text: string): ObjectSwapShot | undefined {
  const cleaned = withoutMarkdown(text)
  const rawTrack = labelledValue(cleaned, 'track', 'description')
  const track = rawTrack === undefined ? undefined : trackerPhrase(rawTrack.replaceAll(/\s*\n\s*/g, ' '))
  const description = labelledValue(cleaned, 'description', '(?:soundscape|music)')
  const soundscape = labelledValue(cleaned, 'soundscape', 'music')
  const music = labelledValue(cleaned, 'music', null)
  if (track === undefined || track.length === 0) return undefined
  if (description === undefined) return undefined
  return { track, description, soundscape: soundscape ?? 'Room tone.', music: music ?? 'N/A' }
}

/**
 * The words that name a person or a body, never a thing.
 *
 * A tracker phrase is what SAM3 looks for: if it names the person, the mask is
 * the person and the run rewrites them instead of the object — measured
 * 2026-11-06 on the first end-to-end object swap: the reader answered
 * "person, torso, body, clothing", the gloved hand came back orange and the
 * woman of the reference photo arrived in the clip. Garment words are NOT here
 * on purpose: "clothing", "dress" and "top" are legitimate things to track.
 */
const PERSON_WORD = /\b(?:person|people|woman|women|man|men|girl|boy|human|body|bodies|torso|face|faces|head|hair|skin|arm|arms|hand|hands|leg|legs|figure|subject)\b/i

/**
 * The tracker phrase with the person taken out of it.
 *
 * A deterministic guard rather than a hope: a vision reader that sees a dress
 * on a person keeps describing the person however plainly it is told not to,
 * and a phrase that names the person makes the run rewrite the person. The
 * segments that name a person or a body are dropped; if nothing is left, the
 * phrase becomes `object`, which is weak but true, and never the person.
 *
 * Exported for `test/object-swap.test.ts` only; this module is its one caller.
 * @param phrase - the tracker phrase the shot pass wrote.
 * @returns the phrase that names only things.
 */
export function objectTrackOf(phrase: string): string {
  const kept = phrase
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0 && !PERSON_WORD.test(part))
  return kept.length === 0 ? 'object' : kept.join(', ')
}

/**
 * The description read out of the photo reply: the object, or the place.
 * @param text - the raw model reply.
 * @param entity - what the photo shows for this mode.
 * @returns the description, or undefined.
 */
function parsePhoto(text: string, entity: PhotoEntity): string | undefined {
  const cleaned = withoutMarkdown(text)
  const description = (labelledValue(cleaned, entity, null) ?? labelledValue(cleaned, 'object', null) ?? cleaned)
    .replaceAll(/\s*\n\s*/g, ' ')
    .slice(0, 700)
    .trim()
  return description.length === 0 ? undefined : description
}

/**
 * The task prefix and the one-sentence summary of the mode.
 *
 * The prefix is part of the H3 reference format (`[video editing + audio
 * reuse]`): it is what tells the model that the plate is edited and its
 * soundtrack reused rather than a new shot invented. The sentences are the
 * plan's own wording, kept in one place so the four modes stay parallel.
 * @param mode - the recipe the run asked for.
 * @param track - the tracker phrase, as a noun.
 * @param hasPhoto - whether a photo of the new object is in the run.
 * @returns the summary sentence.
 */
function summaryOf(mode: ImagineObjectMode, track: string, hasPhoto: boolean): string {
  const prefix = '[video editing + audio reuse]'
  switch (mode) {
    case 'change':
      return `${prefix} The target video is an edited version of the source footage in which the ${track} is replaced by the object in <Picture 1>. Everything else keeps its source look, timing and layout. The soundtrack is reused unchanged.`
    case 'remove':
      return `${prefix} The target video is an edited version of the source footage in which the ${track} is removed: the regenerated area shows only the background and surfaces that continue naturally around it, as if nothing had ever been there. Everything else keeps its source look, timing and layout. The soundtrack is reused unchanged.`
    case 'background':
      return `${prefix} The target video is an edited version of the source footage in which the setting around the ${track} becomes ${hasPhoto ? 'the place shown in <Picture 1>' : 'the new setting described below'}, while the ${track} keeps their exact look and performance. Everything else keeps its source timing and layout. The soundtrack is reused unchanged.`
    case 'add':
      return `${prefix} The target video is an edited version of the source footage in which ${hasPhoto ? 'the object in <Picture 1>' : 'one new object'} is added to the scene, where the description places it, while everything else keeps its source look, timing and layout. The soundtrack is reused unchanged.`
  }
}

/**
 * The retention analysis of the mode: what stays of the plate and what changes.
 *
 * The markers are the format's fixed values and the three lines have to agree
 * with the summary and with the body the model wrote — a prompt that preserves
 * what its own summary says is replaced is the contradiction that makes the
 * sampler keep the old object.
 * @param mode - the recipe the run asked for.
 * @param track - the tracker phrase.
 * @param hasPhoto - whether a photo of the new object is in the run.
 * @returns the lines of the retention analysis, in order.
 */
function retentionOf(mode: ImagineObjectMode, track: string, hasPhoto: boolean): readonly string[] {
  const subject = `<Subject 1> (appears in [Shot 1]): attribute_transfer - the shape, material, colours, markings and visible details of the object in <Picture 1> are transferred onto the ${track} in <Video 1>.`
  const audio = '<Audio 1>: fully_copy - the synchronized audio track of <Video 1> is reused 1:1 as the target video\'s complete final audio track.'
  const kept = 'the background, the place, the light, the exact camera angle, the framing and the camera movements of <Video 1> are preserved'
  switch (mode) {
    case 'change':
      return [subject, `<Video 1> (appears in [Shot 1]): partially_preserved - ${kept}, and so are the other objects, the people and the on-screen graphics of <Video 1>; only the ${track} changes, and it changes into the object of <Picture 1>.`, audio]
    case 'remove':
      return [`<Video 1> (appears in [Shot 1]): partially_preserved - ${kept}, and so are the other objects, the people and the on-screen graphics of <Video 1>; the ${track} is not there any more and the area it covered shows the background that continues behind it, exactly as if it had never been in the shot.`, audio]
    case 'background':
      return [
        ...hasPhoto
          ? ['<Subject 1> (appears in [Shot 1]): attribute_transfer - the place of <Picture 1> — its space, its surfaces and materials, its colours, the objects that belong to it and the light it is in — is transferred into the setting around the tracked subject in <Video 1>.']
          : [],
        `<Video 1> (appears in [Shot 1]): partially_preserved - the subject, its look, its clothing, its pose and its performance, the exact camera angle, the framing, the camera movements and the timing of <Video 1> are preserved; the setting around it is replaced, and it is ${hasPhoto ? 'the place of <Picture 1>' : 'the new setting described in the body of this prompt'}.`,
        audio,
      ]
    case 'add':
      return [
        ...hasPhoto ? [subject] : [],
        `<Video 1> (appears in [Shot 1]): partially_preserved - ${kept}, and so are the other objects, the people and the on-screen graphics of <Video 1>; ${hasPhoto ? 'the object of <Picture 1> is added into the shot and does not replace anything' : 'the new object is added into the shot and does not replace anything'}.`,
        audio,
      ]
  }
}

/**
 * Write the three texts by looking at the plate and, when the mode has one, at
 * the photo of the new object.
 *
 * Two reads, one image each, run together: the photo for the object, three
 * frames of the plate for the tracker phrase and the shot. Never throws — no
 * vision route, a reply in another shape or a strip that cannot be cut all
 * leave the graph's own texts in place (undefined), and the caller then writes
 * the user's own line where the shot goes, which is weaker than a written shot
 * and much stronger than the placeholders of a graph built around another clip.
 * @param ctx - the host context, which may carry the vision service.
 * @param options - the clip and the photo (absolute paths; the photo only for
 *   the modes that carry one), the recipe, the line the user wrote (may be
 *   empty), the clip's length for the frames the strip samples, and the model
 *   the composer's chip was showing.
 * @returns the texts, or undefined when nothing could be read.
 */
export async function writeObjectSwapTexts(
  ctx: ImagineHost,
  options: {
    readonly clipPath: string
    readonly referencePath?: string
    readonly mode: ImagineObjectMode
    readonly intent: string
    readonly duration: number
    readonly chosen?: ModelRoute
  },
): Promise<ObjectSwapTexts | undefined> {
  const { clipPath, mode, intent, duration, chosen } = options
  const referencePath = options.referencePath !== undefined && objectSwapUsesPhoto(mode)
    ? options.referencePath
    : undefined
  const eyes = eyesOf(ctx, chosen)
  if (eyes === undefined) {
    console.warn('[imagine] object swap: no model to look at the files, keeping the graph\'s texts')
    return undefined
  }
  const { vision, route } = eyes
  let strip: string | undefined
  try {
    strip = await clipStrip(clipPath, duration, 'object-swap-strip')
    const hasPhoto = referencePath !== undefined
    const entity = photoEntity(mode)
    const [photoReply, shotReply] = await Promise.all([
      referencePath === undefined ? Promise.resolve(undefined) : readTwice(vision, route, referencePath, photoInstruction(entity)),
      readTwice(vision, route, strip, objectShotInstruction(mode, intent, hasPhoto)),
    ])
    const shot = shotReply === undefined ? undefined : parseShot(shotReply.text)
    if (shot === undefined) {
      console.warn(`[imagine] object swap: ${route.provider}/${route.model} did not answer about the take or answered unreadably, keeping the graph's texts`)
      return undefined
    }
    const photo = photoReply === undefined ? undefined : parsePhoto(photoReply.text, entity)
    if (hasPhoto && photo === undefined) {
      console.warn(`[imagine] object swap: the photo (${entity}) was not readable, the reference line stays generic`)
    }
    return composeTexts(shot, photo, mode, hasPhoto)
  } catch (error: unknown) {
    console.warn(`[imagine] object swap: the strip of the take could not be prepared, keeping the graph's texts: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  } finally {
    if (strip !== undefined) await unlink(strip).catch(() => undefined)
  }
}

/**
 * Join the written sections into the two documents the graph's `StringFormat`
 * concatenates.
 * @param shot - the sections the shot pass wrote.
 * @param photo - the object (or the place, for `background`) read off the photo.
 * @param mode - the recipe the run asked for.
 * @param hasPhoto - whether a photo is in the run.
 * @returns the reference document and the shot document.
 */
function composeTexts(
  shot: ObjectSwapShot,
  photo: string | undefined,
  mode: ImagineObjectMode,
  hasPhoto: boolean,
): ObjectSwapTexts {
  /*
   * In «background» mode the subject to track IS the person: there the phrase
   * stays as the vision model wrote it. In the other modes person nouns are
   * removed, because the object is what changes.
   */
  const track = mode === 'background' ? shot.track : objectTrackOf(shot.track)
  const entity = photoEntity(mode)
  const reference = h3ReferencePrompt([
    ['subject_definitions', [
      ...hasPhoto
        ? [photo === undefined
          ? `<Subject 1> is the ${entity} in <Picture 1>.`
          : `<Subject 1> is the ${entity} in <Picture 1>, with ${photo}`]
        : [],
      '<Video 1> is the source video for the target video edit.',
      '<Audio 1> is the synchronized audio track of <Video 1> and is reused in the target video.',
    ]],
    ['retention_analysis', retentionOf(mode, track, hasPhoto)],
  ])
  // The two audio fields go out cleaned of prohibitions (`cleanAudioFields`).
  const audio = cleanAudioFields(shot.soundscape, shot.music, 'object swap')
  const scene = h3ReferencePrompt([
    ['summary', [summaryOf(mode, track, hasPhoto)]],
    ['detailed_description', [shot.description.trim()]],
    ['overall_soundscape', [audio.soundscape]],
    ['non_diegetic_music', [audio.music]],
  ])
  return { track, reference, scene }
}
