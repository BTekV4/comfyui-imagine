/**
 * Pure size and length math for a run: the pixel size of a still, the video
 * node's aspect label and megapixel budget, the swap's canvas area, and the
 * duration ladders.
 *
 * Shared by the page (`web/vendor-imagine/client/imagine-settings.ts`
 * re-exports all of it) and the MCP server, which until 2026-11-07 imported
 * it from the UI layer. No DOM, no I/O.
 * @module shared/imagine-sizing
 */

import { VIDEO_ASPECT_LABELS, aspectFor, type ImagineAspect, type ImagineResolution } from './imagine-media.ts'

/** Video ladder — MiniMax I2V in this deployment tops out at 720p. */
export const VIDEO_RESOLUTIONS = ['480p', '720p'] as const

/**
 * The swaps (character and object) run Openjutsu's plan, which renders 6 s
 * clips at 480p, 736p or 1080p and chains them: they get the third step.
 */
export const SWAP_RESOLUTIONS = ['480p', '720p', '1080p'] as const

/** One step of the swaps' ladder. */
export type SwapResolution = typeof SWAP_RESOLUTIONS[number]

/**
 * The swaps' step for whatever the composer shows: its own value when the
 * ladder has it, 1080p past it, 720p otherwise. The request carries this
 * label; until 2026-11-15 it carried megapixels the server decoded back with
 * thresholds, which only agreed with this side by convention.
 * @param resolution - the composer's step.
 * @returns the swap step to send.
 */
export function swapResolutionOf(resolution: ImagineResolution): SwapResolution {
  return resolution === '480p' ? '480p' : resolution === '1080p' || resolution === '1440p' ? '1080p' : '720p'
}

/**
 * The label the Openjutsu plan takes for each swap step, or undefined to keep
 * the graph's own 736p (the plan has no 720p).
 */
export const SWAP_PLAN_RESOLUTION: Readonly<Record<SwapResolution, string | undefined>> = {
  '480p': '480p',
  '720p': undefined,
  '1080p': '1080p',
}

/** Video lengths the PrimitiveFloat node accepts (workflow converts to frames). */
const VIDEO_SECONDS = [5, 10] as const

/**
 * The longer rung only 480p offers. Length costs frames and frames cost VRAM,
 * so the 15s clip fits on this 16 GB card at the smaller budget and not at
 * 720p; the ladder is picked from the step rather than offered everywhere and
 * refused by the sampler.
 */
const VIDEO_SECONDS_480P = [5, 10, 15] as const

/**
 * Lengths no single clip can reach, which the composer builds as a chain.
 *
 * The sampler renders a handful of seconds at a time; past that the studio
 * plans a shot per clip and continues each into the next, so these rungs are
 * on the same button as the short ones — a minute of video is a duration to
 * the user, not a different feature.
 */
const STORY_SECONDS = [20, 30, 45, 60] as const

/**
 * Lengths an animated background can ask for.
 *
 * The sampler renders ten seconds at a time, so anything past that is a chain
 * of segments the studio renders and joins into one file. The ladder reaches
 * the whole minute anyway: a background is played in a loop, and what matters
 * is the length the player needs, not the length of one render.
 */
export const LOOP_SECONDS = [5, 10, 15, 20, 30, 45, 60] as const

/** The short side of a still, per ladder step. */
const SHORT: Readonly<Record<ImagineResolution, number>> = {
  '480p': 480,
  '720p': 720,
  '1080p': 1080,
  '1440p': 1440,
}

/**
 * Flat megapixel budget per video ladder step.
 *
 * 720p is 0.9 since 2026-09-21, the user's choice (it was 1.0, 768x1376 at
 * 9:16, which peaked at 15.1 GB for a 10 s clip on this 16 GB card even with
 * the H3 workflows chunking the feedforward and the attention heads).
 */
export const VIDEO_MEGAPIXELS: Readonly<Record<ImagineResolution, number>> = {
  '480p': 0.4,
  '720p': 0.9,
  '1080p': 0.9,
  '1440p': 0.9,
}

/**
 * Keep a resolution that the current mode can send.
 * @param mode - image, video, or a mode that sends no size at all.
 * @param resolution - the last picked ladder step.
 * @returns a valid step for that mode.
 */
export function clampResolution(
  mode: string,
  resolution: ImagineResolution,
): ImagineResolution {
  if ((mode === 'video' || mode === 'loop' || mode === 'music') && (resolution === '1080p' || resolution === '1440p')) return '720p'
  return resolution
}

/**
 * Pixel size for a still at this aspect and ladder step.
 * @param aspect - composer aspect.
 * @param resolution - 480p / 720p / 1080p.
 * @returns WxH for EmptyLatentImage.
 */
export function sizeFor(aspect: ImagineAspect, resolution: ImagineResolution): string {
  const short = SHORT[resolution]
  const [w, h] = aspect.split(':').map(Number)
  if (w === undefined || h === undefined || w <= 0 || h <= 0) return `${short}x${short}`
  if (w === h) return `${short}x${short}`
  /*
   * The 5:2 "Banner" at 1440p would ask for 3600x1440 (5.2 MP): the long side
   * stops at 2560, the canvas Krea 2 holds on this card (2026-11-03; the size
   * of the other ratios does not change).
   */
  const wanted = Math.floor(short * Math.max(w, h) / Math.min(w, h) / 8) * 8
  const long = Math.min(wanted, 2560)
  if (w < h) return `${short}x${long}`
  return `${long}x${short}`
}

/**
 * MiniMax ResolutionSelector label for this aspect.
 * @param aspect - composer aspect.
 * @returns the workflow enum string.
 */
export function videoAspectLabel(aspect: ImagineAspect): string {
  /*
   * A ratio picked for the photos may not exist on the video node (`5:2` has
   * no label): the closest one the graph accepts is sent, not `undefined`,
   * which would fail the graph's validation.
   */
  const supported = aspectFor(aspect, 'video', 'standard')
  return VIDEO_ASPECT_LABELS[supported] ?? VIDEO_ASPECT_LABELS['9:16'] ?? '9:16 (Portrait Widescreen)'
}

/**
 * Megapixels for the video ResolutionSelector.
 *
 * A flat budget per ladder step rather than one derived from the nominal
 * WxH: ResolutionSelector reads megapixels as mebipixels and rounds each
 * side to the workflow's multiple of 32, so a derived value overshot the
 * step it named (0.92 for 720p came out 736x1312) and pushed the sampler
 * into VRAM it does not have on this 16 GB card.
 * @param resolution - 480p or 720p.
 * @returns the megapixel budget for that step.
 */
export function megapixelsFor(resolution: ImagineResolution): number {
  return VIDEO_MEGAPIXELS[clampResolution('video', resolution)]
}

/**
 * The durations a clip can ask for at this ladder step.
 * @param resolution - the selected resolution.
 * @returns the duration ladder for that step.
 */
export function videoSecondsFor(resolution: ImagineResolution): readonly number[] {
  return [...clipSecondsFor(resolution), ...STORY_SECONDS]
}

/**
 * The durations one clip can be sampled in at this ladder step.
 * @param resolution - the selected resolution.
 * @returns the single-clip ladder for that step.
 */
export function clipSecondsFor(resolution: ImagineResolution): readonly number[] {
  return clampResolution('video', resolution) === '480p' ? VIDEO_SECONDS_480P : VIDEO_SECONDS
}

/**
 * The canvas area an object swap (and a recreation) renders on, per ladder step.
 *
 * The swap does not take a `ResolutionSelector` label: its canvas is an area in
 * megapixels that the host writes into the graph (`canvasMegapixels`). 0,98 is
 * the model's own canvas — 768 on the short side — and 0,4 halves the pixels,
 * which is the only way a long clip gets cheaper. Above 0,98 the model does not
 * resolve more detail (measured 2026-10-23), so the ladder stops there.
 * @param resolution - the ladder step the composer is showing.
 * @returns the area, in units of 1024x1024 pixels.
 */
export function canvasMegapixelsFor(resolution: ImagineResolution): number {
  return clampResolution('video', resolution) === '480p' ? 0.4 : 0.98
}

/**
 * Keep a duration this mode and ladder step can send.
 *
 * A 15s clip picked at 480p survives a trip through 720p as the 10s the step
 * does offer, rather than being sent as a length the sampler cannot fit.
 * @param mode - the composer mode the run will use.
 * @param resolution - the selected resolution.
 * @param seconds - the selected duration.
 * @returns a duration on that ladder.
 */
export function clampSeconds(mode: string, resolution: ImagineResolution, seconds: number): number {
  // A song has no ladder: its length is decided from the words by the writer
  // that structures them, unless the sentence said one (2026-09-09).
  if (mode === 'music') return seconds
  const ladder: readonly number[] = mode === 'loop' ? LOOP_SECONDS : videoSecondsFor(resolution)
  if (ladder.includes(seconds)) return seconds
  return 10
}
