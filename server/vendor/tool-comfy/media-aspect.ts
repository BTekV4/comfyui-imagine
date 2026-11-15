/**
 * The canvas a video renders on has to follow the photo it animates.
 *
 * An H3 image-to-video graph takes its width and height from a
 * `ResolutionSelector`: an aspect label and a megapixel budget. The label has a
 * default — 9:16 on the graphs this studio ships — and nothing in the graph
 * looks at the picture it was handed. Feed a square photo to a 9:16 latent and
 * the model stretches it to fill: the result is not cropped, it is *deformed*,
 * which is worse, because it looks like a bad render rather than a mismatched
 * setting.
 *
 * So the photo's own ratio is read and the closest label the node accepts is
 * chosen. The labels are read from ComfyUI (`/object_info`) instead of being
 * hard-coded, because a `ResolutionSelector` is a custom node and its list is
 * whatever the deployment installed.
 * @module tool-comfy/media-aspect
 */

import { labelRatio, nearestRatio } from '../../../shared/imagine-media.ts'

/** Width over height, or undefined for a size nothing can be drawn at. */
export function ratioOf(width: number, height: number): number | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  return width / height
}

/** The ratio a label names: one parser, in `shared/imagine-media.ts`. */
export { labelRatio }

/**
 * The label whose ratio is closest to `ratio`, by the shared log distance
 * (`nearestRatio`).
 * @param ratio - the photo's width over height.
 * @param labels - the values the node accepts.
 * @returns the closest label, or undefined when none names a ratio.
 */
export function closestLabel(ratio: number, labels: readonly string[]): string | undefined {
  return nearestRatio(ratio, labels)
}

/**
 * How far a label's ratio is from `ratio`, in the same log space.
 * @param ratio - the photo's width over height.
 * @param label - the label a render would use.
 * @returns the distance, or undefined when the label names no ratio.
 */
export function gapOf(ratio: number, label: string): number | undefined {
  const value = labelRatio(label)
  return value === undefined ? undefined : Math.abs(Math.log(value / ratio))
}

/**
 * The distance past which a render visibly crops or pads the photo.
 *
 * 0.12 in log space is about a 12% change of ratio — 1:1 against 8:9 — which is
 * where a face starts to look squashed rather than merely reframed.
 */
export const VISIBLE_RATIO_GAP = 0.12
