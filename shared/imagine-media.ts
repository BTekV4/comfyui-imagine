/**
 * Media rules the server and the studio page both apply: the aspect ratios
 * the composer offers and the chat may ask for, the sizes past which an
 * upscale cannot raise a file, and the length of a chained video. No imports,
 * read by both sides.
 *
 * Until 2026-10-21 each side kept its own copy: the chat's aspects had no
 * `4:3`, and the page's upscale guard repeated the server's ceilings as bare
 * numbers. The story ceiling joined them on 2026-10-22: the page kept 180
 * with a comment claiming it mirrored the director's 300, so a video asked
 * for 200 seconds was written to 180 without a word.
 */

/**
 * Aspect ratios the composer cycles, and the ones the chat may ask for.
 *
 * `4:3` is a height the MiniMax ResolutionSelector itself declares, which is
 * what the video and lookbook workflows write, so a still and a clip can ask
 * for the same ratio.
 *
 * `21:9` («Cinematico») and `5:2` («Banner») came in on 2026-11-03, as in
 * Grok's v2 set (read from its bundle: `{v1: 5 ratios, v2: 8}` chosen by the
 * `imagine-aspect-ratio-versions` flag). `5:2` stays on stills only: the video
 * node has no such label and a clip would be refused in validation, which is
 * why `videoAspectLabel` maps it to the closest ratio the graph accepts. See
 * docs/note/imagine-qualita-e-velocita-nel-composer.md.
 */
export const IMAGINE_ASPECTS = ['2:3', '3:2', '4:3', '1:1', '9:16', '16:9', '21:9', '5:2'] as const

/** One composer aspect. */
export type ImagineAspect = typeof IMAGINE_ASPECTS[number]

/**
 * The selector's own label for each aspect: the video graphs pin
 * `aspect_ratio` on a `ResolutionSelector` combo, and a value outside this
 * list fails the whole graph in validation.
 */
export const VIDEO_ASPECT_LABELS: Readonly<Partial<Record<ImagineAspect, string>>> = {
  '16:9': '16:9 (Widescreen)',
  '9:16': '9:16 (Portrait Widescreen)',
  '1:1': '1:1 (Square)',
  '2:3': '2:3 (Portrait Photo)',
  '3:2': '3:2 (Photo)',
  '4:3': '4:3 (Standard)',
  '21:9': '21:9 (Ultrawide)',
}

/**
 * The ratios the video model accepts, in the order Grok shows them: exactly
 * the ones the H3 graphs' `ResolutionSelector` declares. `4:3` and `21:9`
 * exist in the node but Grok does not offer them for video, and `5:2` has no
 * label so a clip would be refused.
 */
const VIDEO_ASPECTS = ['2:3', '3:2', '1:1', '9:16', '16:9'] as const

/**
 * The names Grok writes next to the ratio (3/11/2026, measured in its
 * composer): the "plain" ones for video and for the fast model, the
 * photographic ones for the quality model's images.
 */
const ASPECT_NAMES_PLAIN: Readonly<Partial<Record<ImagineAspect, string>>> = {
  '2:3': 'imagine.aspectName.tall',
  '3:2': 'imagine.aspectName.wide',
  '1:1': 'imagine.aspectName.square',
  '9:16': 'imagine.aspectName.vertical',
  '16:9': 'imagine.aspectName.panoramic',
}

const ASPECT_NAMES_PHOTO: Readonly<Partial<Record<ImagineAspect, string>>> = {
  '2:3': 'imagine.aspectName.poster',
  '3:2': 'imagine.aspectName.print',
  '4:3': 'imagine.aspectName.presentation',
  '1:1': 'imagine.aspectName.square',
  '9:16': 'imagine.aspectName.story',
  '16:9': 'imagine.aspectName.panoramic',
  '21:9': 'imagine.aspectName.cinematic',
  '5:2': 'imagine.aspectName.banner',
}

/**
 * The ratios a composer surface actually offers.
 *
 * Grok has no single list: video shows five, the quality model's images
 * eight (with `4:3`, `21:9` and `5:2`), the fast model's images the same five
 * as video. Here too the recipe decides: «Velocità» five, «Qualità» every one
 * the graph can draw.
 * @param mode - the composer mode, image or video.
 * @param quality - the recipe the composer is showing.
 * @returns the ratios to offer, in Grok's order.
 */
export function aspectsFor(mode: 'image' | 'video', quality: 'standard' | 'high'): readonly ImagineAspect[] {
  if (mode === 'video') return VIDEO_ASPECTS
  return quality === 'high' ? IMAGINE_ASPECTS : VIDEO_ASPECTS
}

/**
 * The name Grok writes next to a ratio on this surface.
 * @param aspect - the ratio.
 * @param mode - the composer mode.
 * @param quality - the recipe.
 * @returns the locale key of the name (the page translates it), or undefined
 *   when the surface does not offer one.
 */
export function aspectName(
  aspect: ImagineAspect,
  mode: 'image' | 'video',
  quality: 'standard' | 'high',
): string | undefined {
  return (mode === 'image' && quality === 'high' ? ASPECT_NAMES_PHOTO : ASPECT_NAMES_PLAIN)[aspect]
}

/**
 * The ratio a label names: `"9:16 (Portrait Widescreen)"` → 0.5625.
 * @param label - an aspect such as `16:9`, or a node label that starts with one.
 * @returns the ratio, or undefined when the label does not start with `a:b`.
 */
export function labelRatio(label: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/.exec(label)
  if (match === null) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  return width / height
}

/**
 * The label whose ratio is nearest to `ratio`; the first one wins a tie.
 *
 * Distances are compared as `|ln(value / ratio)|`, not as a difference: 1:1
 * against 4:3 and 3:2 against 4:3 are both "a quarter off" in a way a plain
 * subtraction does not see, and portrait against landscape always wins the
 * comparison that matters. The one implementation since 2026-11-07: the
 * composer's aspects and the video node's labels each had their own.
 * @param ratio - width over height.
 * @param labels - the candidates, each read with {@link labelRatio}.
 * @returns the nearest label, or undefined when none names a ratio.
 */
export function nearestRatio<T extends string>(ratio: number, labels: readonly T[]): T | undefined {
  let best: T | undefined
  let closest = Number.POSITIVE_INFINITY
  for (const label of labels) {
    const value = labelRatio(label)
    if (value === undefined) continue
    const distance = Math.abs(Math.log(value / ratio))
    if (distance < closest) {
      closest = distance
      best = label
    }
  }
  return best
}

/**
 * The ratio a surface actually offers, nearest to the one held.
 *
 * A ratio chosen on the photo surface may not exist on the video one (`5:2`
 * has no label on the H3 node), and switching recipe narrows the list: the
 * composer shows, and the run sends, a ratio the graph can take.
 * @param aspect - the ratio the store holds.
 * @param mode - the composer mode.
 * @param quality - the recipe.
 * @returns a ratio from {@link aspectsFor}.
 */
export function aspectFor(
  aspect: ImagineAspect,
  mode: 'image' | 'video',
  quality: 'standard' | 'high',
): ImagineAspect {
  const offered = aspectsFor(mode, quality)
  if ((offered as readonly string[]).includes(aspect)) return aspect
  const wanted = labelRatio(aspect)
  const first = offered[0]
  if (wanted === undefined || first === undefined) return '9:16'
  return nearestRatio(wanted, offered) ?? first
}

/**
 * The composer aspect closest to a photo this shape, or undefined when the
 * photo's size is not known.
 *
 * A clip animated from a still is rendered at the still's shape unless the
 * user asks for another: a 1920x1080 photo sent through the 9:16 default
 * comes back letterboxed on a portrait canvas. The nearest of the offered
 * ratios keeps the picture whole; the tolerance decides when a photo is
 * close enough not to be worth re-framing.
 * @param width - the photo's width in pixels.
 * @param height - the photo's height in pixels.
 * @returns the nearest offered aspect, or undefined without a size.
 */
export function aspectNearest(width: number | undefined, height: number | undefined): ImagineAspect | undefined {
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return undefined
  return nearestRatio(width / height, IMAGINE_ASPECTS)
}

/**
 * The still-image ladder, in the order the composer cycles it.
 *
 * The chat reads it too: a resolution a line may name is the set the composer
 * offers, and the two were separate copies until 2026-10-22.
 */
export const IMAGE_RESOLUTIONS = ['480p', '720p', '1080p', '1440p'] as const

/** One still/video resolution label. */
export type ImagineResolution = typeof IMAGE_RESOLUTIONS[number]

/**
 * Shortest shot a chained video will ask for.
 *
 * A remainder below this is spread over the other shots instead: a two-second
 * continuation spends the same guide and the same seam as a ten-second one,
 * for a fifth of the new material.
 */
export const MIN_SHOT_SECONDS = 3

/**
 * Longest a chained video may run.
 *
 * MiniMax Music 3 renders tracks up to 300 seconds (the workflow's own node
 * takes 360), and a story is as long as the song laid over it, so a ceiling
 * below the music one would cut the last shots of a long track. Raised from
 * 180 to 300 on 2026-10-07 together with the request ceiling.
 */
export const MAX_STORY_SECONDS = 300

/** Short side from which a clip is not upscaled: it is already 1080p. */
const UPSCALE_VIDEO_SHORT = 1080

/** Short side from which a still is not upscaled: it is already 4K. */
export const UPSCALE_IMAGE_SHORT = 2160

/**
 * Longest side a SeedVR2 still graph is wired for. The 2x upscale target is
 * clamped to it: the guard looks at the SHORT side, so a panoramic still can
 * clear it and still ask for a run the GPU cannot fit.
 */
export const UPSCALE_MAX_SIDE = 4096

/**
 * Longest side the SeedVR2 video graph is wired for. Clips cost far more per
 * pixel than stills, and the graph ships with a fixed 1080 target: 1920 is one
 * 1080p frame on its long side, whichever way the clip is turned.
 */
export const UPSCALE_VIDEO_MAX_SIDE = 1920

/**
 * True when SeedVR2 cannot raise this file: a 1080p-or-taller clip, a
 * 4K-or-taller still (short side), or anything whose LONG side already
 * reaches its graph ceiling — for those the 2x target would clamp below the
 * source and silently shrink it instead of raising it.
 * @param kind - image, video or audio (never upscaled).
 * @param width - pixel width.
 * @param height - pixel height.
 * @returns whether upscale is already at the workflow ceiling.
 */
export function upscaleBlocked(
  kind: 'image' | 'video' | 'audio',
  width: number,
  height: number,
): boolean {
  if (kind === 'audio') return true
  const short = Math.min(width, height)
  const long = Math.max(width, height)
  if (kind === 'video') return short >= UPSCALE_VIDEO_SHORT || long >= UPSCALE_VIDEO_MAX_SIDE
  return short >= UPSCALE_IMAGE_SHORT || long >= UPSCALE_MAX_SIDE
}
