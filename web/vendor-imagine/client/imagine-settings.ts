/**
 * Imagine resolution / duration mapping onto this deployment's Comfy
 * workflows: stills write EmptyLatentImage WxH; video writes the MiniMax
 * ResolutionSelector label plus megapixels, and PrimitiveFloat seconds.
 * @module imagine-settings
 */

import {
  IMAGINE_ASPECTS, MAX_STORY_SECONDS, MIN_SHOT_SECONDS, UPSCALE_IMAGE_SHORT,
  upscaleBlocked, type ImagineAspect, type ImagineResolution,
} from '../../../shared/imagine-media.ts'
import type { MediaKind } from '../../../shared/imagine-types.ts'
import { VIDEO_MEGAPIXELS, clipSecondsFor } from '../../../shared/imagine-sizing.ts'

/*
 * The size and length math the MCP server shares lives in
 * `shared/imagine-sizing.ts`; re-exported here so the page imports one module.
 */
export {
  LOOP_SECONDS, VIDEO_RESOLUTIONS, clampResolution, clampSeconds, clipSecondsFor, megapixelsFor, sizeFor,
  canvasMegapixelsFor, videoAspectLabel, videoSecondsFor, SWAP_RESOLUTIONS, swapResolutionOf,
} from '../../../shared/imagine-sizing.ts'

/**
 * What the composer is set to send, one per card on the home view.
 *
 * `speak` is the odd one: a card picks it, no toolbar chip offers it, and the
 * send reads it as the text-to-speech action.
 */
export type ImagineMode = 'image' | 'video' | 'loop' | 'music' | 'look' | 'style' | 'speak'
  // "Recreate video": one clip in, the studio redraws its opening frame and
  // shoots the scene again from that picture.
  | 'recreate'
  // "Regenerate detail": the clip redone at 1.5x by the Open-H3 refiner, with
  // its original audio. Not an upscale: the model redraws the detail.
  | 'regenerate'

/*
 * The chain's length is clamped with the director's own `MAX_STORY_SECONDS`
 * and `MIN_SHOT_SECONDS`, from `shared/imagine-media.ts`. This file kept its
 * own copies until 2026-10-22 — 180 against the director's 300, under a comment
 * claiming the two matched — so a length asked for in words ("a five-minute
 * video") was cut to three minutes before it ever reached the host.
 */

/** Longest single clip; past this a duration is rendered as a chain. */
export const STORY_MIN_SECONDS = 20

/**
 * Shortest shot the chain will render — `MIN_SHOT_SECONDS` from shared. The
 * clamp's floor is the shot's, not the duration button's: the chain is also how
 * a video is made from nothing, so it runs at lengths under that rung.
 */
const STORY_FLOOR_SECONDS = MIN_SHOT_SECONDS

/**
 * Budgets the 720p step used before its current one. Clips generated at them
 * are still 720p clips and keep the HD badge.
 */
const PREVIOUS_720P_MEGAPIXELS = [0.8, 1.0] as const

/**
 * Whether a duration is longer than one clip, and so runs as a chain.
 * @param resolution - the selected resolution.
 * @param seconds - the selected duration.
 * @returns true when the run needs several clips.
 */
export function isStoryLength(resolution: ImagineResolution, seconds: number): boolean {
  const clips = clipSecondsFor(resolution)
  return seconds > (clips[clips.length - 1] ?? 10)
}

/**
 * Keep a chained video's duration inside what the chain can render.
 *
 * The ladder clamp cannot do this job: a story asked for in words is any
 * number of seconds, and a value off the four rungs the button offered would
 * come back as the ten-second clip the user did not ask for.
 * @param seconds - the duration asked for.
 * @returns a duration between the shortest and longest chain.
 */
export function clampStorySeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return STORY_MIN_SECONDS
  return Math.max(STORY_FLOOR_SECONDS, Math.min(MAX_STORY_SECONDS, Math.round(seconds)))
}

/**
 * The two sides of a composer aspect, in the order they are named: '9:16' is
 * [9, 16].
 *
 * Read off the aspect's own spelling, as `sizeFor` in shared/imagine-sizing.ts
 * reads it, rather than from a second hand-kept table of the same eight
 * pairs. Every `ImagineAspect` is two positive integers around a colon.
 * @param aspect - composer aspect.
 * @returns width and height parts.
 */
function aspectSides(aspect: ImagineAspect): readonly [number, number] {
  const [w = 1, h = 1] = aspect.split(':').map(Number)
  return [w, h]
}

/**
 * The `multiple` the video workflow's ResolutionSelector rounds to.
 *
 * Mirrors `comfyui_video_i2v_minimax_h3_API.json`; DSH overrides that node's
 * `aspect_ratio` and `megapixels` and leaves this one as the graph has it.
 */
const VIDEO_SIZE_MULTIPLE = 32

/**
 * The pixel size ResolutionSelector produces for one aspect and budget.
 *
 * Reproduces the node: the budget is read as MEBIpixels (1024 x 1024, not a
 * million) and each side is rounded to the nearest multiple, which is why a
 * 0.8 budget at 9:16 comes out 672x1216 rather than the 720x1280 its name
 * suggests.
 * @param aspect - composer aspect.
 * @param megapixels - the budget written on the node.
 * @returns width and height in pixels.
 */
function videoPixelSize(aspect: ImagineAspect, megapixels: number): { width: number; height: number } {
  const [w, h] = aspectSides(aspect)
  const scale = Math.sqrt(megapixels * 1024 * 1024 / (w * h))
  const round = (side: number): number => Math.round(side / VIDEO_SIZE_MULTIPLE) * VIDEO_SIZE_MULTIPLE
  return { width: round(w * scale), height: round(h * scale) }
}

/**
 * The short side below which a clip has not reached the 720p ladder step.
 *
 * Derived from the step's own budget rather than fixed at 720: the step is
 * named 720p and must be badged 720p, and what it actually produces is a
 * function of VIDEO_MEGAPIXELS. The narrowest aspect of the smallest budget
 * the step has used (current or PREVIOUS_720P_MEGAPIXELS) sets the floor, so
 * every aspect on that step earns the badge, including clips made before the
 * budget last changed. Worked out once, when the module loads: the budgets
 * are constants, and it used to be recomputed for every clip on the board.
 */
const VIDEO_BADGE_FLOOR = Math.min(
  ...[VIDEO_MEGAPIXELS['720p'], ...PREVIOUS_720P_MEGAPIXELS].flatMap(budget => IMAGINE_ASPECTS.map((aspect) => {
    const { width, height } = videoPixelSize(aspect, budget)
    return Math.min(width, height)
  })),
)

/**
 * Canvas badge: none below 720, HD from 720, 1080p from 1080, 4K from 2160
 * (what an upscale of a 1080p still produces).
 *
 * Stills are measured on the short side; the 4K rung is the size at which
 * the host stops accepting an upscale (`UPSCALE_IMAGE_SHORT`, shared with
 * it), and the 720 floor is the literal one.
 *
 * A clip is measured on the short side or, when that reads lower, on what its
 * long side would be short in a 16:9 frame: a clip upscale targets the LONG
 * side — 2x capped at UPSCALE_VIDEO_MAX_SIDE — so a 672x1216 clip comes back
 * 1060x1920, a real jump whose short side lands 20px under the 1080 mark.
 *
 * A clip's 720p floor is `VIDEO_BADGE_FLOOR`, not 720: the studio's own 720p
 * step produces 672x1216 at 9:16, so a clip generated at the step named 720p
 * was showing no badge at all. The badge reports the ladder step the file was
 * made at, and the floor is derived from that step's budget so the two cannot
 * drift apart.
 * @param width - pixel width.
 * @param height - pixel height.
 * @param kind - image or video; a clip is read against its long side too.
 * @returns the badge, or undefined for 480p and below.
 */
export function qualityBadgeOf(
  width: number,
  height: number,
  kind: MediaKind = 'image',
): 'HD' | '1080p' | '1440p' | '4K' | undefined {
  const short = Math.min(width, height)
  const video = kind === 'video'
  const measure = video ? Math.max(short, Math.round(Math.max(width, height) * 9 / 16)) : short
  /*
   * A still is read with 5% of slack: the edit graph renders on a 32-pixel
   * grid near its megapixel budget, so a 1080x1920 photo comes back 1056x1888
   * and was badged HD, and its 2x upscale (2112x3776) badged 1080p
   * (2026-10-17). Clips keep their exact floors, calibrated above.
   */
  const at = (step: number): number => (video ? step : Math.round(step * 0.95))
  if (measure >= at(UPSCALE_IMAGE_SHORT)) return '4K'
  if (measure >= at(1440)) return '1440p'
  if (measure >= at(1080)) return '1080p'
  if (measure >= (video ? VIDEO_BADGE_FLOOR : at(720))) return 'HD'
  return undefined
}

/**
 * Whether a gallery item can be upscaled: audio never, unknown-dimension
 * media always (the host re-checks), and measured media only below the
 * workflow ceiling.
 * @param item - a gallery item.
 * @returns true when upscale can still help.
 */
export function upscaleEligible(item: { kind: MediaKind; width?: number; height?: number }): boolean {
  if (item.kind === 'audio') return false
  if (item.width === undefined || item.height === undefined) return true
  return !upscaleBlocked(item.kind, item.width, item.height)
}

/**
 * Height/width read from a "WxH" pixel size or an "W:H (Label)" aspect label.
 * @param text - the size or aspect string a job was submitted with.
 * @returns the aspect as height/width, or undefined when it does not parse.
 */
function ratioOfLabel(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const match = /^\s*(\d+)\s*[x:]\s*(\d+)/.exec(text)
  if (match === null) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  if (width <= 0 || height <= 0) return undefined
  return height / width
}

/**
 * A gallery item's own height/width. Audio has none, and neither does a file
 * whose header the host could not read; those keep the canvas fallback frame.
 * @param item - a gallery item.
 * @returns the aspect as height/width, or undefined when unknown.
 */
export function itemRatio(item: { width?: number; height?: number; kind?: MediaKind }): number | undefined {
  // A track has no picture to take a shape from: it gets a square tile, not
  // the portrait frame a file without dimensions falls back to (asked
  // 2026-09-10).
  if (item.kind === 'audio') return 1
  const { width, height } = item
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return undefined
  return height / width
}

/**
 * The height/width a live job's output will have. Stills carry the pixel size
 * they were submitted with; clips carry only the MiniMax aspect label.
 * @param job - a queued or running job.
 * @returns the aspect as height/width, or undefined when neither is known.
 */
export function jobRatio(job: { size?: string; aspectRatio?: string }): number | undefined {
  return ratioOfLabel(job.size) ?? ratioOfLabel(job.aspectRatio)
}
