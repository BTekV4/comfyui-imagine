/**
 * Finding one thing inside a photo, and the two host edits the written lane
 * can ask for without a graph.
 *
 * The written lane is a text call: it can decide that something has to come
 * out, but it cannot point at it. A vision pass with the picture in front of
 * it can, and the ask is not "where is X" but "what does the user mean by X,
 * given what this picture contains": a line asking for "la borsa" over a
 * photo whose description says "a red handbag" has to become that handbag
 * before a box around it means anything. The instruction below says so in as
 * many words, and {@link parseGrounding} reads the box back.
 *
 * The other two host edits: taking writing, a logo or a watermark out is the
 * masked removal (IOPaint's LaMa), which never redraws the photo; laying a
 * track over a clip is a mux. Both are recognised from the user's own words
 * as well as from the reading, because a full redraw cannot deliver either.
 *
 * Shared and free of Node and the DOM.
 * @module shared/imagine-grounding
 */

import { isRemovalEdit } from './imagine-edit.ts'
import { MIN_REGION_SIDE, type ImagineRegion } from './imagine-types.ts'

/** How much the box around a found thing is grown, as a share of its short side. */
export const GROUNDING_GROW = 0.08

/**
 * How soft the edge of a removal's mask is, as a share of the photo's short
 * side. LaMa fills a hard edge with a visible seam and often a halo; a soft
 * one lets the fill meet the surroundings over a few pixels.
 */
export const ERASE_FEATHER = 0.008

/** The words that name writing or a mark printed on a photo. */
const TEXT_MARK =
  /\b(?:scritt\w*|test[oi]|loghi?|logo|watermarks?|filigran\w*|marchi[oi]?|firma|firme|sottotitol\w*|caption|text|lettering|timbro)\b/i

/**
 * Whether a line asks for writing or a mark to be taken out of a photo.
 *
 * Only a removal: "cambia la scritta" is a local edit of that part, not the
 * eraser, and only the eraser leaves everything around it untouched.
 * @param text - the user's line, or the run's prompt.
 * @returns true for a removal of writing, a logo or a watermark.
 */
export function wantsTextRemoval(text: string): boolean {
  return TEXT_MARK.test(text) && isRemovalEdit(text)
}

/** The words that join an existing track to an existing clip. */
const JOIN_VERB = /\b(?:unisci|unire|unisc\w*|monta|montare|aggiungi|aggiungere|metti|mettere|sovrapponi|sovrapporre|add|put|join|merge|mux|lay)\b/i
/** The words that name a track. */
const TRACK_WORD = /\b(?:audio|traccia|canzone|musica|brano|voce|soundtrack|track|song|music|voice)\b/i
/** The words that name a clip. */
const CLIP_WORD = /\b(?:video|clip|filmat[oi]|filmino)\b/i

/**
 * Whether a line asks to lay a track over a clip that already exists.
 * @param text - the user's line.
 * @returns true when a verb joins a track and a clip.
 */
export function wantsAudioMerge(text: string): boolean {
  return JOIN_VERB.test(text) && TRACK_WORD.test(text) && CLIP_WORD.test(text)
}

/** What the vision model is told before it is shown the photo. */
export interface GroundingAsk {
  /** The thing the user named, as they named it. */
  readonly target: string
  /**
   * What is really visible in the photo, when the sight pass already looked.
   *
   * This is the "before the grounding, rephrase the name" step: the model is
   * told what the picture contains and asked to match the user's word to it,
   * so "la borsa" finds "the red handbag" instead of nothing.
   */
  readonly description?: string
}

/**
 * The question asked of a photo to find one thing in it.
 * @param ask - the target and what the photo contains.
 * @returns the instruction sent to the vision model.
 */
export function groundingInstruction(ask: GroundingAsk): string {
  const described = ask.description === undefined || ask.description.trim().length === 0
    ? 'The picture has not been described yet: work out what the user means from the picture itself.'
    : `What the picture really contains, as another pass described it: "${ask.description.replace(/\s+/g, ' ').trim()}"`
  return `Find ONE thing in this picture.

The user calls it: "${ask.target.trim()}"
${described}

First decide what the user means, using the description above to translate their word into what is really in the picture ("the bag" may be "the red handbag"; "the writing at the bottom" may be "the small white caption"). Then put the tightest box around exactly that thing.

Answer only with JSON, no prose and no code block:
{"found": true, "box": [x1, y1, x2, y2]}
where the four numbers are the box's left, top, right and bottom in thousandths of the picture's width and height (0-1000). If the picture does not contain what the user means, answer {"found": false}.`
}

/** One box of the model's answer, in any of the shapes it writes. */
function boxOf(value: unknown): ImagineRegion | undefined {
  if (Array.isArray(value) && value.length === 4) {
    const [x1, y1, x2, y2] = value.map(entry => typeof entry === 'number' ? entry : Number.NaN)
    if ([x1, y1, x2, y2].some(Number.isNaN)) return undefined
    const left = Math.min(x1 as number, x2 as number)
    const top = Math.min(y1 as number, y2 as number)
    return clampedRegion({
      x: left / 1000,
      y: top / 1000,
      w: Math.abs((x2 as number) - (x1 as number)) / 1000,
      h: Math.abs((y2 as number) - (y1 as number)) / 1000,
    })
  }
  if (typeof value === 'object' && value !== null) {
    const entry = value as Record<string, unknown>
    const x = entry.x
    const y = entry.y
    const w = entry.w ?? entry.width
    const h = entry.h ?? entry.height
    return [x, y, w, h].every(number => typeof number === 'number' && Number.isFinite(number))
      ? clampedRegion({ x: x as number, y: y as number, w: w as number, h: h as number })
      : undefined
  }
  return undefined
}

/** A region kept inside the frame, or undefined when it has no area. */
function clampedRegion(region: ImagineRegion): ImagineRegion | undefined {
  const left = Math.min(Math.max(region.x, 0), 1)
  const top = Math.min(Math.max(region.y, 0), 1)
  const width = Math.min(region.w, 1 - left)
  const height = Math.min(region.h, 1 - top)
  // A watermark can be one line high: a fraction of a percent is still a real
  // box, and the caller grows it before the mask is drawn.
  return width <= 0.002 || height <= 0.002 ? undefined : { x: left, y: top, w: width, h: height }
}

/**
 * Read the model's answer into the box of the thing it found.
 *
 * The reply may wrap its JSON in a fence or a sentence; both are tolerated,
 * as the studio does for every other model answer.
 * @param reply - the raw reply.
 * @returns the box as fractions of the photo, or undefined when it found none.
 */
export function parseGrounding(reply: string | undefined): ImagineRegion | undefined {
  if (reply === undefined) return undefined
  const text = reply.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let value: unknown
  try {
    value = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const entry = value as Record<string, unknown>
  if (entry.found === false) return undefined
  return boxOf(entry.box ?? entry.region ?? entry)
}

/**
 * The box grown by a share of its own short side, kept inside the photo.
 *
 * The growth is what stops the halo: LaMa rebuilds the pixels it is given,
 * and a mask that stops on the very edge of a printed mark leaves the
 * anti-aliased ring around it in the picture, which reads as a ghost of the
 * mark.
 * @param region - the box found.
 * @param grow - how much of the box's short side to add on every side.
 * @returns the grown box.
 */
export function grownRegion(region: ImagineRegion, grow = GROUNDING_GROW): ImagineRegion {
  const padX = region.w * grow
  const padY = region.h * grow
  const left = Math.max(0, region.x - padX)
  const top = Math.max(0, region.y - padY)
  const right = Math.min(1, region.x + region.w + padX)
  const bottom = Math.min(1, region.y + region.h + padY)
  return clampedRegion({ x: left, y: top, w: right - left, h: bottom - top })
    ?? { x: left, y: top, w: Math.max(MIN_REGION_SIDE, right - left), h: Math.max(MIN_REGION_SIDE, bottom - top) }
}
