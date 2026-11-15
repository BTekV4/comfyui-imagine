/**
 * Bring a still that came back a few pixels off its intended size onto it.
 *
 * The graphs render on a 32- or 64-pixel grid near a megapixel budget, so a
 * photo asked at 1080x1920 can come back 1056x1888 (edit) or 1088x1928
 * (lookbook), and every size-based label and limit downstream then reads it
 * one step low (asked 2026-10-17: "fix the wrong resolutions where
 * possible"). Within 5% on both sides and the same shape, the file is
 * rescaled with Lanczos and centre-cropped to the exact target, in its own
 * container; anything further off is left alone — that is a different
 * picture, not a rounding.
 */
import { open, rename, unlink } from 'node:fs/promises'
import { imageTypeOf, probePixels } from './gallery.ts'
import { FASTSTART, ffmpegTo, h264Out } from './media-tools.ts'
import { SHAPE_SLACK, frameOnShape, nearestShape } from '../../../shared/imagine-sizing.ts'

/** Largest per-side difference treated as rounding. */
const SIZE_SLACK = 0.05

/**
 * The H3 model's native canvas area, in units of 1024x1024 pixels: what one
 * character-swap window is drawn at unless its workflow asks for another.
 */
export const H3_NATIVE_MEGAPIXELS = 0.98

/**
 * The largest canvas H3 renders a continuation on, in pixels: 768x1344,
 * whatever the aspect. Not the same number as {@link H3_NATIVE_MEGAPIXELS}
 * (0.98 MP is 1,027,604 px): a 768x1344 clip H3 itself made has to fit here
 * unscaled, or its continuation would be drawn a step smaller.
 */
export const H3_MAX_CANVAS_PIXELS = 768 * 1344

/**
 * A side length moved onto a pixel grid, never below one step.
 *
 * Two roundings on purpose: a canvas that is a target area rounds to the
 * nearest step (the swap, the scan, the 480p replacement), one that must stay
 * under a ceiling rounds down (the continuation).
 * @param value - the side in pixels.
 * @param step - the grid, in pixels.
 * @param mode - `nearest` (default) or `floor`.
 * @returns the side on the grid.
 */
export function snapToGrid(value: number, step: number, mode: 'nearest' | 'floor' = 'nearest'): number {
  return Math.max(step, (mode === 'floor' ? Math.floor(value / step) : Math.round(value / step)) * step)
}

/** Pixels → `1080x1920`, the spelling `size` travels in. */
export function formatSize(size: { readonly width: number; readonly height: number }): string {
  return `${String(size.width)}x${String(size.height)}`
}

/** `1080x1920` → pixels, or undefined. */
export function parseSize(size: string | undefined): { width: number; height: number } | undefined {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(size ?? '')
  if (match === null) return undefined
  return { width: Number(match[1]), height: Number(match[2]) }
}

/** Whether `actual` is a rounding of `target`, not a different size. */
function nearSize(actual: { width: number; height: number }, target: { width: number; height: number }): boolean {
  if (actual.width === target.width && actual.height === target.height) return false
  const dw = Math.abs(actual.width / target.width - 1)
  const dh = Math.abs(actual.height / target.height - 1)
  const shape = Math.abs((actual.width / actual.height) / (target.width / target.height) - 1)
  return dw <= SIZE_SLACK && dh <= SIZE_SLACK && shape <= SHAPE_SLACK
}

/** The encoder for the bytes actually in the file (generated .webp are often PNG). */
async function encoderOf(path: string): Promise<readonly string[]> {
  const handle = await open(path, 'r')
  try {
    const head = Buffer.alloc(12)
    await handle.read(head, 0, 12, 0)
    const type = imageTypeOf(head)
    if (type === 'image/png') return ['-c:v', 'png', '-f', 'image2']
    if (type === 'image/jpeg') return ['-c:v', 'mjpeg', '-q:v', '2', '-f', 'image2']
    return ['-c:v', 'libwebp', '-quality', '95', '-f', 'webp']
  } finally {
    await handle.close()
  }
}

/**
 * Snap one still to `target` when it is only a rounding away.
 * @returns true when the file was rewritten.
 */
export async function snapStill(path: string, target: { width: number; height: number }): Promise<boolean> {
  const probed = await probePixels(path, 'image')
  if (!('width' in probed)) return false
  if (!nearSize({ width: probed.width, height: probed.height }, target)) return false
  return snapTo(path, `${path}.snap`, target, async () => ['-frames:v', '1', ...await encoderOf(path)], 60_000, 'misura')
}

/**
 * Rescale `path` with Lanczos, centre-crop it onto `frame` through a
 * temporary file, and put the result in its place.
 * @param path - the file to rewrite.
 * @param temp - the temporary file, beside it.
 * @param frame - the exact size to land on.
 * @param encode - the output arguments, read when the pass starts.
 * @param timeoutMs - how long ffmpeg may run.
 * @param what - what the warning calls the size that could not be fixed.
 * @returns true when the file was rewritten.
 */
async function snapTo(
  path: string,
  temp: string,
  frame: { width: number; height: number },
  encode: () => Promise<readonly string[]>,
  timeoutMs: number,
  what: string,
): Promise<boolean> {
  const w = String(frame.width)
  const h = String(frame.height)
  try {
    await ffmpegTo(temp, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', path,
      '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}`,
      ...await encode(), temp,
    ], timeoutMs)
    await rename(temp, path)
    return true
  } catch (error: unknown) {
    // ffmpegTo already removed a half-written file; this covers a failed rename.
    await unlink(temp).catch(() => undefined)
    console.warn(`[imagine] ${what} not corrected for ${path}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * The exact 4K frame for a still that is about 4K: short side 2160 and the
 * long side of the nearest studio shape — 2160x3840 for a 9:16 photo, 3840x2160
 * for a 16:9 one (asked 2026-10-17: "fai preciso 3840x2160"). Undefined when
 * the still is not within 5% of a 2160 short side or matches no shape.
 * `step` is the short side to frame on (2160 for 4K, 1440, 1080).
 */
export function fourKFrame(width: number, height: number, step = 2160): { width: number; height: number } | undefined {
  const short = Math.min(width, height)
  if (Math.abs(short / step - 1) > SIZE_SLACK) return undefined
  // The shapes and the shape slack are the ones the upscale menu promises (shared/imagine-sizing.ts).
  const shape = nearestShape(width, height)
  return shape === undefined ? undefined : frameOnShape(shape[0], shape[1], step)
}

/**
 * The exact 720p or 1080p frame for a 9:16 or 16:9 clip that came out a few
 * pixels off it: the video graphs render on a 32-pixel grid, so 720p at 9:16
 * is 736x1280, and the video upscale stops its short side at 1060 (asked
 * 2026-10-17: "make it 720x1280 if possible"). Other shapes have no standard
 * frame to land on and are left as rendered.
 */
export function exactVideoFrame(width: number, height: number): { width: number; height: number } | undefined {
  const ratio = width / height
  const tall = Math.abs(ratio / (9 / 16) - 1) <= 0.05
  const wide = Math.abs(ratio / (16 / 9) - 1) <= 0.05
  if (!tall && !wide) return undefined
  const short = Math.min(width, height)
  const step = [720, 1080].find(entry => Math.abs(short / entry - 1) <= 0.03)
  if (step === undefined) return undefined
  const long = Math.round(step * 16 / 9)
  const frame = tall ? { width: step, height: long } : { width: long, height: step }
  return frame.width === width && frame.height === height ? undefined : frame
}

/**
 * Rescale and centre-crop a clip onto `frame`, keeping its audio as it is.
 * H.264 at CRF 15 so the pass costs no visible quality; faststart so the
 * player and the gallery's header probe read it at once.
 * @returns true when the file was rewritten.
 */
export async function snapClip(path: string, frame: { width: number; height: number }): Promise<boolean> {
  return snapTo(path, `${path}.snap.mp4`, frame, async () => [
    ...h264Out(15, 'medium'), '-c:a', 'copy', ...FASTSTART,
  ], 600_000, 'video size')
}
