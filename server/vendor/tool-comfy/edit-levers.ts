/**
 * The one-step levers, and the change a "più X" is built from.
 *
 * A step is not a new request: "rendila più luminosa" after a result the user
 * accepted means that result with one more notch of light. The whitelist is
 * closed on purpose — brightness, warmth, colour, sharpness, contrast — so
 * "più sensuale" cannot become a lever for nudity, and any other "more" is
 * refused with the list instead of guessed.
 * @module tool-comfy/edit-levers
 */

import { languageOfPrompt } from './reply-language.ts'

/** One lever: the words that name it, and the phrase it adds in both languages. */
interface Lever {
  /** Its name in the refusal, English like the rest of the tool surface. */
  readonly id: string
  readonly pattern: RegExp
  readonly it: string
  readonly en: string
}

/** The closed list, most specific first. */
const LEVERS: readonly Lever[] = [
  { id: 'more colour', pattern: /colorat|colori più vivi|vivide|vivid|colourful|colorful|saturat/i, it: 'colori più vivi', en: 'more vivid colours' },
  { id: 'less colour', pattern: /meno color|desaturat|colori spenti|muted colour|pallid/i, it: 'colori più spenti', en: 'muted colours' },
  { id: 'contrast', pattern: /contrast/i, it: 'più contrasto', en: 'more contrast' },
  { id: 'brighter light', pattern: /luminos|più luce|brighter|lighter|more light|illuminat/i, it: 'luce più luminosa', en: 'brighter light' },
  { id: 'darker light', pattern: /più scur|scur[oa]\b|darker|less light|più bui|bui[oa]\b/i, it: 'luce più scura', en: 'darker light' },
  { id: 'warmer', pattern: /più cald|cald[oa]\b|warmer|warm tones|toni caldi/i, it: 'toni più caldi', en: 'warmer tones' },
  { id: 'cooler', pattern: /più fredd|fredd[oa]\b|cooler|cold tones|toni freddi/i, it: 'toni più freddi', en: 'cooler tones' },
  { id: 'sharper', pattern: /più nitid|nitid[oa]\b|sharper|more detail|più definit/i, it: 'più nitido', en: 'sharper detail' },
  { id: 'softer', pattern: /più morbid|morbid[oa]\b|softer|soft focus|più tenue/i, it: 'più morbido', en: 'softer rendering' },
]

/** "più", "meno", "more", "less" as a word, accents included. */
const STEP_REQUEST = /(?<![\p{L}])(?:più|meno|more|less)(?![\p{L}])/iu

/**
 * Whether a line asks for a step rather than a new request.
 * @param asked - the user's line.
 * @returns true when it says "more" or "less" of something.
 */
export function stepAsked(asked: string): boolean {
  return STEP_REQUEST.test(asked)
}

/** The lever a line names, when it names one. */
export function leverFor(asked: string): Lever | undefined {
  return LEVERS.find(lever => lever.pattern.test(asked))
}

/** The phrase a step adds, in the language the user wrote. */
function phraseOf(lever: Lever, asked: string): string {
  if (/(?<![\p{L}])più(?![\p{L}])/iu.test(asked)) return lever.it
  if (/(?<![\p{L}])more(?![\p{L}])/iu.test(asked)) return lever.en
  return languageOfPrompt(asked) === 'en' ? lever.en : lever.it
}

/** What a line that asks for one step resolves to. */
export type StepResolution =
  | { readonly change: string }
  | { readonly error: string }

/**
 * The change a "più X" is built from: the last accepted change, plus one delta.
 *
 * Without an accepted result there is nothing to step from: the model's own
 * prompt (the user's words) stands, and the caller keeps it. A lever the list
 * does not hold is refused rather than guessed: that is where "più sensuale"
 * would have become something nobody asked for.
 * @param asked - the user's line.
 * @param accepted - the change the last accepted result was made with.
 * @returns the resolved change, the refusal, or undefined when the line is not
 *   a step from an accepted result (the caller keeps its own prompt).
 */
export function resolveStep(asked: string, accepted?: string): StepResolution | undefined {
  if (!stepAsked(asked)) return undefined
  const lever = leverFor(asked)
  if (lever === undefined) {
    return {
      error: `the line asks for more of something that is not one of the studio's steps: ${LEVERS.map(entry => entry.id).join(', ')}. Say which one, and run the change the user names; a step never makes the picture more explicit`,
    }
  }
  const base = accepted?.trim() ?? ''
  if (base.length === 0) return undefined
  return { change: `${base}, ${phraseOf(lever, asked)}` }
}
