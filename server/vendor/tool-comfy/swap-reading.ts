/**
 * The pieces the object swap reads its clip with: the strip of three frames
 * the vision pass looks at, the read that retries at a smaller size, and the
 * cleanup of the two audio fields of the shot it writes. The instructions, the
 * parsing and the documents of the object swap are in `object-swap-texts.ts`.
 * @module tool-comfy/swap-reading
 */

import { randomUUID } from 'node:crypto'
import { stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lookWith, type VisionCapable } from './imagine-models.ts'
import type { ModelRoute } from '../../../shared/imagine-types.ts'
import { ffmpegTo } from './media-tools.ts'
import { H3_WINDOW_SECONDS } from './h3-windows.ts'
import { stripAudioDirections } from './video-prompt.ts'

/**
 * How long one vision read of the swap's texts pass may take.
 *
 * The photo and the strip of three frames are read at 1600 px, one call each,
 * and through the local 27B that takes a minute or two; this is long enough for
 * a slow host and short enough that a dead one costs a second try at 1024 px
 * instead of the whole run.
 */
const SWAP_LOOK_TIMEOUT_MS = 180_000

/** Where in the clip the strip's three frames are taken, as shares of its length. */
const STRIP_MOMENTS = [0.1, 0.5, 0.9] as const

/** The height each frame of the strip is scaled to before they are stacked. */
const STRIP_FRAME_HEIGHT = 400

/**
 * One frame of the strip, at the second asked for, scaled to the strip's height.
 *
 * A seek that lands past the last frame the file can decode writes nothing at
 * all — ffmpeg with `-update 1` exits 0 and leaves no file — so the frame is
 * checked, and the clip's final frame stands in for a moment that is not
 * there (the same guard as the contact sheet of `recreate-video.ts`).
 * @param clip - absolute path of the clip.
 * @param out - the frame to write.
 * @param at - the second to read.
 */
async function stripFrame(clip: string, out: string, at: number): Promise<void> {
  const scale = ['-vf', `scale=-2:${String(STRIP_FRAME_HEIGHT)}`]
  await ffmpegTo(out, ['-v', 'error', '-y', '-ss', String(at), '-i', clip, '-frames:v', '1', ...scale, '-update', '1', out], 60_000)
    .catch(() => undefined)
  try {
    await stat(out)
  } catch {
    await ffmpegTo(out, ['-v', 'error', '-y', '-sseof', '-0.5', '-i', clip, ...scale, '-update', '1', out], 60_000)
  }
}

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
 *   one swap window.
 * @param prefix - the scratch file's name prefix, for the journal and `/tmp`.
 * @returns the absolute path of the strip; the caller removes it.
 */
export async function clipStrip(clip: string, duration: number, prefix: string): Promise<string> {
  const span = Number.isFinite(duration) && duration > 0 ? duration : H3_WINDOW_SECONDS
  const stamp = randomUUID()
  const frames = STRIP_MOMENTS.map((fraction, index) => ({
    at: span * fraction,
    path: join(tmpdir(), `${prefix}-${stamp}-${String(index)}.png`),
  }))
  try {
    await Promise.all(frames.map(async ({ path, at }) => stripFrame(clip, path, at)))
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
  return await lookWith(vision, path, instruction, route, SWAP_LOOK_TIMEOUT_MS, { maxSide: 1600 })
    ?? await lookWith(vision, path, instruction, route, SWAP_LOOK_TIMEOUT_MS, { maxSide: 1024 })
}

/**
 * The two audio fields of a written shot, cleaned of prohibitions and never
 * empty.
 *
 * The finished clip normally carries the plate's own track (`layPlateAudio`),
 * so nothing written here is heard — but a plate with no audio keeps the
 * model's soundtrack, and "no voices" in the soundscape is then spoken exactly
 * as it was on the clips of 2026-10-31. An emptied soundscape becomes room tone
 * and an emptied score `N/A`, the values the format reads as "nothing".
 * @param soundscape - the `overall_soundscape` the pass wrote.
 * @param music - the `non_diegetic_music` the pass wrote; any spelling of
 *   "n/a" is read as none.
 * @param label - who is writing, for the journal line.
 * @returns the two fields, ready for the shot document.
 */
export function cleanAudioFields(
  soundscape: string,
  music: string,
  label: string,
): { readonly soundscape: string; readonly music: string } {
  const sound = stripAudioDirections(soundscape.trim())
  const score = stripAudioDirections(/^n\/?a\.?$/i.test(music.trim()) ? 'N/A' : music.trim())
  for (const cleaned of [sound, score]) {
    if (cleaned.stripped.length > 0) {
      console.warn(`[imagine] ${label}: removed ${String(cleaned.stripped.length)} negative audio directions: ${cleaned.stripped.join(' | ').slice(0, 300)}`)
    }
  }
  return {
    soundscape: sound.text.trim().length === 0 ? 'Room tone.' : sound.text.trim(),
    music: score.text.trim().length === 0 ? 'N/A' : score.text.trim(),
  }
}
