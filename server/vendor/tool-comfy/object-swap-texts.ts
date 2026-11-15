/**
 * The texts an object swap is given: what the tracker follows in the clip and
 * what it becomes.
 *
 * Every shipped object-swap graph is an Openjutsu chain (`H3ObjectSwapPlan`
 * feeding `MiniMaxH3ChainLoopStart`): it plans the clip, cuts its own windows,
 * describes the photo and writes each shot's prompt with its own vision model.
 * What it still wants from the host are two SHORT texts, the plan's `target`
 * and `change_to`, and their meaning changes with the mode:
 *
 * - `change`: target is the object to replace, change_to what it becomes;
 * - `remove`: target is the object to take out, change_to what shows instead;
 * - `background`: target is the subject that stays, change_to the new setting;
 * - `add`: change_to is the object to add (the graph places it in the box the
 *   user drew and takes no target).
 *
 * Until 2026-11-15 this module wrote the reference and shot documents of the
 * windowed H3 graph it was built for (subject definitions, retention analysis,
 * a 250-450 word play-by-play, soundscape and music), and `change_to` received
 * a whole multi-section document where the plan expects a phrase. The vision
 * pass is now asked only for the two phrases, which also makes it shorter.
 * @module tool-comfy/object-swap-texts
 */

import { unlink } from 'node:fs/promises'
import type { ImagineHost } from '../../src/host.ts'
import { eyesOf } from './eyes.ts'
import type { ImagineObjectMode, ModelRoute } from '../../../shared/imagine-types.ts'
import { labelledValue, withoutMarkdown } from './model-json.ts'
import { clipStrip, readTwice } from './swap-reading.ts'

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
 * `change` REQUIRES one (it is the new look of the object) and `add` takes one
 * on its photo graph. `remove` and `background` have none: their graphs carry
 * no image branch, so the gate refuses a photo sent with them instead of
 * ignoring it, because a client that sends one believes it is doing something.
 * @param mode - the recipe the run asked for.
 * @returns true for the modes the photo belongs to.
 */
export function objectSwapUsesPhoto(mode: ImagineObjectMode): boolean {
  return mode === 'change' || mode === 'add'
}

/**
 * A `change_to` phrase as the plan can use it: one line, no quotes, bounded.
 *
 * The plan writes it into the prompt of every window it renders, so a stray
 * newline or a paragraph would be repeated in each of them.
 * @param value - the phrase the model wrote.
 * @returns the phrase on one line, at most 200 characters, without a final stop.
 */
function changePhrase(value: string): string {
  return value.replaceAll(/\s*\n\s*/g, ' ').replaceAll('"', '').slice(0, 200).trim().replace(/\.$/, '')
}

/** The texts the object swap graph is given. */
export interface ObjectSwapTexts {
  /** The plan's `target`: the noun phrase the segmenter looks for in the plate. */
  readonly track: string
  /**
   * The plan's `change_to`: what the tracked thing becomes, what shows
   * instead of it, the new setting or the object to add, as a short phrase.
   * May be empty when nothing says what it becomes: the graph's own empty
   * value, and the plan then goes by the photo it describes itself.
   */
  readonly reference: string
  /**
   * One English sentence that says what the run does, for the job card (the
   * runner shows it as the written prompt). No graph pin reads it any more.
   */
  readonly scene: string
}

/**
 * What the vision pass is asked about the photo of a mode that carries one.
 *
 * Only the object is named, never the photo's background, framing or light:
 * those come from the clip, and naming them is how a swapped object drags the
 * photo's scene into the picture.
 * @returns the instruction sent with the photo.
 */
function photoInstruction(): string {
  return `Look at this PHOTO: it shows the object to PUT INTO a video.

Reply ONLY with one line, with no other text.

change_to: a short ENGLISH noun phrase, at most 15 words, naming the object and what makes it recognisable: what it is, its main colours and material, a marking or logo if it has one (example: "a red leather handbag with a gold clasp"). If somebody in the photo is wearing or holding it, name ONLY the object, never the person. No sentence, no full stop.`
}

/**
 * What each mode asks for in the two lines of the shot reply.
 * @param mode - the recipe the run asked for.
 * @param hasPhoto - whether a photo of the new object is in the run.
 * @returns what `target` must name, and what `change_to` must say.
 */
function modeLines(mode: ImagineObjectMode, hasPhoto: boolean): { readonly target: string; readonly changeTo: string } {
  const fromPhoto = 'the object of a PHOTO you do not see: name it from the user\'s request, or write exactly "the object in the photo" if the request does not say'
  switch (mode) {
    case 'change':
      return {
        target: 'the OBJECT to REPLACE in the shot: a garment, an accessory, a prop, a piece of furniture — never a person and never a body part',
        changeTo: hasPhoto ? `what it becomes: ${fromPhoto}` : 'what it becomes, as the user asked',
      }
    case 'remove':
      return {
        target: 'the OBJECT to REMOVE from the shot: a garment, an accessory, a prop, a piece of furniture — never a person and never a body part',
        changeTo: 'what shows where the object was once it is gone: the surface or background that continues behind it, as the frames show it (example: "the bare wooden table top")',
      }
    case 'background':
      return {
        target: 'the subject that STAYS while its setting is replaced (the person, or the main thing in the foreground)',
        changeTo: 'the NEW SETTING the user asked for, as a place (example: "a sunny beach with palm trees"); if the user did not say, choose one that suits the shot',
      }
    case 'add':
      return {
        target: 'the place in the shot where the new object goes (a surface, a table, a hand, an empty area)',
        changeTo: hasPhoto ? `the object to ADD: ${fromPhoto}` : 'the object to ADD, as the user asked',
      }
  }
}

/**
 * What the vision pass is asked about the plate's frames.
 *
 * Three frames of the same take, in time order, stacked: the tracker phrase has
 * to come from the plate (it is what the segmenter has to find there), and
 * what shows instead of a removed object is what the plate has behind it.
 * @param mode - the recipe the run asked for.
 * @param intent - the line the user wrote, which may be empty.
 * @param hasPhoto - whether a photo of the new object is in the run.
 * @returns the instruction sent with the strip of frames.
 */
function objectShotInstruction(mode: ImagineObjectMode, intent: string, hasPhoto: boolean): string {
  const brief = intent.trim().length === 0
    ? 'The user wrote nothing else.'
    : `The user asked for: "${intent}"`
  const lines = modeLines(mode, hasPhoto)
  const trackRule = mode === 'background'
    ? 'The target names the subject whose setting changes: the person (or the main thing) that must stay exactly as it is.'
    : `The target names an OBJECT — clothing, an accessory, a prop, furniture. Never write "person", "woman", "man", "people", "body", "torso", "face", "hair", "hand" or any body part: in this mode the person stays who they are and only the object changes, so a phrase that names the person makes the model rewrite the person (measured 2026-11-06: "person, torso, body, clothing" turned the hand orange and swapped the face).`
  return `Look at this image: three frames IN TIME ORDER of the same TAKE, stacked from top to bottom. The take is being edited: ${mode === 'remove' ? 'an object is removed' : mode === 'background' ? 'its setting is replaced' : mode === 'add' ? 'an object is added' : 'an object is replaced'}.

${brief}

Reply ONLY with these two labelled lines, in this order, with no other text, both in ENGLISH.

target: 2-5 ENGLISH nouns, common and generic, with which an object detector finds in the frames ${lines.target} (example: "bottle, glass", "table, surface"). No sentences, no style adjectives.

change_to: a short ENGLISH phrase, at most 15 words, naming ${lines.changeTo}. No sentence, no full stop.

Rules: ${trackRule} Do not invent people, objects or text that are not in the frames, except what the change_to line asks for.`
}

/** The two lines of the shot reply. */
interface ObjectSwapShot {
  /** The tracker phrase the segmenter reads. */
  readonly track: string
  /** What it becomes, or undefined when the reply has no such line. */
  readonly changeTo: string | undefined
}

/**
 * Read the two lines of the shot reply.
 *
 * `track:` is read too, the label the old reply format used, so a model that
 * keeps answering in it still gives a target.
 * @param text - the raw model reply.
 * @returns the tracker phrase and the change, or undefined without a target.
 */
function parseShot(text: string): ObjectSwapShot | undefined {
  const cleaned = withoutMarkdown(text)
  const rawTrack = labelledValue(cleaned, '(?:target|track)', '(?:change_to|description)')
  const track = rawTrack === undefined ? undefined : trackerPhrase(rawTrack.replaceAll(/\s*\n\s*/g, ' '))
  if (track === undefined || track.length === 0) return undefined
  const rawChange = labelledValue(cleaned, 'change_to', null)
  const changeTo = rawChange === undefined ? undefined : changePhrase(rawChange)
  return { track, changeTo: changeTo === undefined || changeTo.length === 0 ? undefined : changeTo }
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
 * The object named by the photo reply.
 * @param text - the raw model reply.
 * @returns the phrase, or undefined.
 */
function parsePhoto(text: string): string | undefined {
  const cleaned = withoutMarkdown(text)
  const phrase = changePhrase(labelledValue(cleaned, 'change_to', null) ?? labelledValue(cleaned, 'object', null) ?? cleaned)
  return phrase.length === 0 ? undefined : phrase
}

/**
 * The sentence the job card shows for the run.
 * @param mode - the recipe the run asked for.
 * @param track - the tracker phrase.
 * @param changeTo - what it becomes, possibly empty.
 * @returns one English sentence.
 */
function summaryOf(mode: ImagineObjectMode, track: string, changeTo: string): string {
  const into = changeTo.length === 0 ? '' : changeTo
  switch (mode) {
    case 'change':
      return into.length === 0 ? `Replace the ${track} with the object in the photo.` : `Replace the ${track} with ${into}.`
    case 'remove':
      return into.length === 0 ? `Remove the ${track}.` : `Remove the ${track}: ${into} shows instead.`
    case 'background':
      return into.length === 0 ? `Keep the ${track} and replace the setting around it.` : `Keep the ${track} and move it to ${into}.`
    case 'add':
      return into.length === 0 ? 'Add the object in the photo.' : `Add ${into}.`
  }
}

/**
 * Write the two texts by looking at the plate and, when the mode has one, at
 * the photo of the new object.
 *
 * Two reads, one image each, run together: three frames of the plate for the
 * target (and, without a readable photo, what it becomes), the photo for the
 * object it becomes. Never throws — no vision route, a reply in another shape
 * or a strip that cannot be cut all leave the graph's own texts in place
 * (undefined).
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
    const [photoReply, shotReply] = await Promise.all([
      referencePath === undefined ? Promise.resolve(undefined) : readTwice(vision, route, referencePath, photoInstruction()),
      readTwice(vision, route, strip, objectShotInstruction(mode, intent, hasPhoto)),
    ])
    if (hasPhoto && (photoReply === undefined || parsePhoto(photoReply.text) === undefined)) {
      console.warn('[imagine] object swap: the photo was not readable, change_to comes from the take\'s reading')
    }
    const texts = shotReply === undefined ? undefined : objectSwapTextsOf(mode, shotReply.text, photoReply?.text)
    if (texts === undefined) {
      console.warn(`[imagine] object swap: ${route.provider}/${route.model} did not answer about the take or answered unreadably, keeping the graph's texts`)
    }
    return texts
  } catch (error: unknown) {
    console.warn(`[imagine] object swap: the strip of the take could not be prepared, keeping the graph's texts: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  } finally {
    if (strip !== undefined) await unlink(strip).catch(() => undefined)
  }
}

/**
 * The texts out of the two replies.
 *
 * The photo's own phrase wins over the take's guess at it: the take's reader
 * never saw the photo. A placeholder the take's reader was told to write for
 * an unseen photo is left out, so the plan falls back on its own description
 * of the picture instead of reading those words as the object.
 *
 * Exported for `test/object-swap.test.ts`; {@link writeObjectSwapTexts} is its
 * one caller.
 * @param mode - the recipe the run asked for.
 * @param shotText - the raw reply about the take.
 * @param photoText - the raw reply about the photo, when the run has one.
 * @returns the target, what it becomes and the job card's sentence, or
 *   undefined when the take's reply names no target.
 */
export function objectSwapTextsOf(mode: ImagineObjectMode, shotText: string, photoText?: string): ObjectSwapTexts | undefined {
  const shot = parseShot(shotText)
  if (shot === undefined) return undefined
  const photo = photoText === undefined ? undefined : parsePhoto(photoText)
  /*
   * In «background» mode the subject to track IS the person: there the phrase
   * stays as the vision model wrote it. In the other modes person nouns are
   * removed, because the object is what changes.
   */
  const track = mode === 'background' ? shot.track : objectTrackOf(shot.track)
  const guessed = shot.changeTo !== undefined && /^the object in the photo$/i.test(shot.changeTo) ? undefined : shot.changeTo
  const reference = photo ?? guessed ?? ''
  return { track, reference, scene: summaryOf(mode, track, reference) }
}
