/**
 * Where an upscale can take a file: the standard steps above its own size,
 * each with the exact frame the job will deliver (asked 2026-10-17: it should
 * ask which resolution, not upscale on its own).
 */
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import { frameOnShape, nearestShape } from '../../../shared/imagine-sizing.ts'

export interface UpscaleChoice {
  /** Short side to arrive at, sent to the host as `upscaleTo`. */
  readonly short: number
  readonly label: string
  /** The exact `WxH` the file will have. */
  readonly size: string
  /** How many times the short side grows (shown when past 2x). */
  readonly factor: number
}

const STILL_STEPS = [[1080, '1080p'], [1440, '1440p'], [2160, '4K']] as const
const CLIP_STEPS = [[720, '720p'], [1080, '1080p']] as const
/**
 * The exact frame for a short side, on the nearest studio shape, or on the
 * file's own shape when it matches none. The shapes and the rule are the
 * ones the host delivers with (shared/imagine-sizing.ts, read by snap-size.ts).
 */
function frameOf(width: number, height: number, short: number): string {
  const [w, h] = nearestShape(width, height) ?? [width, height]
  const frame = frameOnShape(w, h, short)
  return `${String(frame.width)}×${String(frame.height)}`
}

/**
 * The steps an upscale of this file can offer, smallest first. A step must
 * grow the short side by at least 5%: 1056 → 1080 is a rounding, not an upscale.
 */
export function upscaleChoicesOf(item: Pick<GalleryItem, 'kind' | 'width' | 'height'>): readonly UpscaleChoice[] {
  if (item.width === undefined || item.height === undefined || item.kind === 'audio') return []
  const short = Math.min(item.width, item.height)
  const steps = item.kind === 'video' ? CLIP_STEPS : STILL_STEPS
  // A clip's ceiling is 1920 on the long side, whatever its shape.
  return steps
    .filter(([step]) => step >= short * 1.05)
    .map(([step, label]) => ({ short: step, label, size: frameOf(item.width ?? 0, item.height ?? 0, step), factor: step / short }))
}

/**
 * The step an upscale of this file runs at: the one asked for, when the file
 * offers it, otherwise the highest it offers (`orHighest`) or none, which
 * leaves the host its own default target.
 * @param item - the file to upscale.
 * @param wanted - the short side picked in a menu or a panel, if any.
 * @param orHighest - fall back to the highest step instead of to none.
 * @returns the step, or undefined.
 */
export function pickUpscaleStep(
  item: Pick<GalleryItem, 'kind' | 'width' | 'height'>,
  wanted: number | undefined,
  orHighest: boolean,
): UpscaleChoice | undefined {
  const choices = upscaleChoicesOf(item)
  return choices.find(choice => choice.short === wanted) ?? (orHighest ? choices[choices.length - 1] : undefined)
}
