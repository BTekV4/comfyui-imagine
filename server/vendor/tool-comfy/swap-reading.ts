/**
 * The pieces the object swap reads its clip with: the strip of three frames
 * the vision pass looks at, the read that retries at a smaller size, and the
 * cleanup of the two audio fields of the shot it writes. The instructions, the
 * parsing and the documents of the object swap are in `object-swap-texts.ts`.
 * @module tool-comfy/swap-reading
 */

import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lookWith, type VisionCapable } from './imagine-models.ts'
import type { ModelRoute } from '../../../shared/imagine-types.ts'
import { FPS, ffmpegTo, frameAt } from './media-tools.ts'

/** Where in the clip the strip's three frames are taken, as shares of its length. */
const STRIP_MOMENTS = [0.1, 0.5, 0.9] as const

/** The height each frame of the strip is scaled to before they are stacked. */
const STRIP_FRAME_HEIGHT = 400

/**
 * The length a clip is read as when its own cannot be: 124 frames at 24 fps,
 * the span one H3 pass renders at the native canvas. Only where the three
 * frames are taken depends on it, and a frame past the end falls back to the
 * clip's last one.
 */
const UNKNOWN_CLIP_SECONDS = 124 / FPS

/**
 * Three frames spread over the clip, stacked top to bottom in time order, as
 * one picture for the vision pass.
 *
 * Each frame is cut on its own and the three are stacked, rather than picked
 * with `select` and laid out by ffmpeg's `tile`: `tile` waits for a full grid
 * before it writes anything, so a clip whose third pick fell past its last
 * decodable frame (a length read off the header, a rate other than the 24 the
 * frame index assumed) produced no strip at all, and the pass kept the graph's
 * placeholders. `recreate-video.ts` builds its contact sheet this way for the
 * same reason.
 * @param clip - absolute path of the clip.
 * @param duration - its length in seconds; not finite or not positive reads as
 *   {@link UNKNOWN_CLIP_SECONDS}.
 * @param prefix - the scratch file's name prefix, for the journal and `/tmp`.
 * @returns the absolute path of the strip; the caller removes it.
 */
export async function clipStrip(clip: string, duration: number, prefix: string): Promise<string> {
  const span = Number.isFinite(duration) && duration > 0 ? duration : UNKNOWN_CLIP_SECONDS
  const stamp = randomUUID()
  const frames = STRIP_MOMENTS.map((fraction, index) => ({
    at: span * fraction,
    path: join(tmpdir(), `${prefix}-${stamp}-${String(index)}.png`),
  }))
  try {
    /*
     * Each frame at the strip's height; a moment past the last decodable frame
     * takes the clip's final one (`orLast`), so the stack always has three
     * inputs.
     */
    await Promise.all(frames.map(async ({ path, at }) => frameAt(clip, path, {
      at, orLast: true, height: STRIP_FRAME_HEIGHT, timeoutMs: 60_000,
    })))
    const out = join(tmpdir(), `${prefix}-${stamp}.png`)
    // ffmpegTo removes a half-written strip when the stacking fails.
    return await ffmpegTo(out, [
      '-v', 'error', '-y',
      ...frames.flatMap(({ path }) => ['-i', path]),
      '-filter_complex', `${frames.map((_, index) => `[${String(index)}:v]`).join('')}vstack=inputs=${String(frames.length)}[strip]`,
      '-map', '[strip]', '-frames:v', '1', out,
    ], 120_000)
  } finally {
    await Promise.all(frames.map(async ({ path }) => unlink(path).catch(() => undefined)))
  }
}

/**
 * One vision read, with a second try at a smaller size.
 *
 * The deployment's vision route has timed out on two large frames before
 * (2026-10-24, both files unanswered while the model was being swapped on its
 * host), and the cost of that failure is not a slow job: it is a whole render
 * with the graph's placeholders as the prompt.
 * @param vision - the vision service.
 * @param route - the model to read with.
 * @param path - the picture to read.
 * @param instruction - what the model is asked.
 * @returns the reply, or undefined when neither size was answered.
 */
export async function readTwice(
  vision: VisionCapable,
  route: ModelRoute,
  path: string,
  instruction: string,
): Promise<{ text: string } | undefined> {
  return await lookWith(vision, path, instruction, route, { maxSide: 1600 })
    ?? await lookWith(vision, path, instruction, route, { maxSide: 1024 })
}

