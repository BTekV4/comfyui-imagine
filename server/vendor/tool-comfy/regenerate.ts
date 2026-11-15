/**
 * «Rigenera dettaglio»: the clip redone at 1.5× by the Open-H3 refiner.
 *
 * It is not an upscale: the graph takes the clip, raises its latent with a 3D
 * convolution and redraws it in three Euler steps, so the detail is invented
 * by the model, not interpolated. The prompt guides that redraw — with a
 * generic line the neckline and lips change (measured 2026-10-31) — and that
 * is why its search lives here too: the file's note, the chain of origins, the
 * vision reading of the clip, and only at the end a neutral sentence.
 *
 * The rest of the module is window geometry: the refiner on the 5070 Ti holds
 * 124 frames at ~2.1 MP and goes OOM at 2K, so a longer clip is a chain of
 * 124-frame windows with a step of 100 (24 of overlap), each cut with ffmpeg
 * and padded by cloning the last frame when the clip ends earlier. `joinCuts`
 * (montage.ts) joins the windows with a one-second crossfade, and the audio is
 * the source clip's.
 * @module tool-comfy/regenerate
 */

import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ImagineHost } from '../../src/host.ts'
import { AAC_128K, FPS, SILENT_STEREO_INPUT, ffmpegTo, frameAt, h264Out, probeMedia, type MediaProbe } from './media-tools.ts'
import { recallNote, type ImagineFileOrigin } from './imagine-notes.ts'
import { eyesOf } from './eyes.ts'
import { lookWith } from './imagine-models.ts'
import { SIGHT_TIMEOUT_MS } from './imagine-sight.ts'
import { snapToGrid } from './snap-size.ts'
import type { ModelRoute } from '../../../shared/imagine-types.ts'

/**
 * Frames one refiner pass redraws.
 *
 * The model's grid is `17k + 5` and 124 is the step measured on the 5070 Ti:
 * 5.17 s at 1088x1920 in 135 s with a 13.9 GB peak. At 1440x2560 the same pass
 * goes OOM in the sampler, so the window does not get longer: a long clip is
 * split.
 */
export const REGENERATE_WINDOW_FRAMES = 124

/**
 * Frames of step between one window and the next.
 *
 * 100 and not 124: the 24 frames of difference are the overlap, i.e. exactly
 * the one second of crossfade `joinCuts` joins the windows with. The joint
 * blends an instant with itself instead of showing half a second of action
 * twice, and the timeline stays the clip's.
 */
const REGENERATE_STEP_FRAMES = 100

/**
 * Seconds of crossfade on every joint: the 24 frames of overlap between two
 * windows, i.e. exactly one second at 24 fps.
 */
export const REGENERATE_FADE_SECONDS = (REGENERATE_WINDOW_FRAMES - REGENERATE_STEP_FRAMES) / FPS

/**
 * How much the clip grows: 1.5×, the factor the refiner can hold.
 *
 * Not a matter of taste: 720x1280 becomes 1088x1920 and fits in the measured
 * 13.9 GB, while 2× (1440x2560) goes OOM. The long side stops at 1920 because
 * the graph has never been tried beyond that size on this card.
 */
const REGENERATE_FACTOR = 1.5

/** Maximum long side of the regenerated clip. */
const REGENERATE_LONG_SIDE = 1920

/** The names a note's prompt carries when it is not a prompt. */
const PLACEHOLDER_PROMPTS: ReadonlySet<string> = new Set([
  'upscale', 'bg', 'voice', 'regenerate', 'regenerate_detail', 'regenerateDetail',
])

/** How many notes to walk back, at most, before giving up. */
const ORIGIN_CHAIN_MAX = 8

/** The sentence a run starts from when nobody can describe the clip. */
const NEUTRAL_REGENERATE_PROMPT = 'a person, medium shot, natural light, realistic detail'

/**
 * The canvas the refiner redraws a clip on: 1.5× its sides, aligned to 32
 * (the graph's grid) and with the long side never above 1920.
 *
 * The examples this function must give, measured: 720x1280 → 1088x1920,
 * 1280x720 → 1920x1088, 960x960 → 1440x1440. The 1080 of a 9:16 clip is not a
 * multiple of 32 and the graph works on that grid: 1080 becomes 1088.
 * @param width - width of the source clip.
 * @param height - height of the source clip.
 * @returns the canvas, or undefined when the clip cannot be measured.
 */
export function regenerateCanvas(width: number, height: number): { width: number; height: number } | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return undefined
  const long = Math.max(width, height)
  const short = Math.min(width, height)
  const goal = Math.min(Math.round(long * REGENERATE_FACTOR), REGENERATE_LONG_SIDE)
  const other = Math.round(goal * short / long)
  // The short side cannot vanish: below 32 px the graph has no canvas.
  const aligned = Math.max(32, snapToGrid(other, 32))
  return width >= height
    ? { width: snapToGrid(goal, 32), height: aligned }
    : { width: aligned, height: snapToGrid(goal, 32) }
}

/**
 * The frame each window starts from.
 *
 * The step is fixed (100), so the last window may run past the end of the
 * clip: its draft is padded by cloning the last frame, and the extra tail is
 * dropped when the original audio is put back on the file with `-shortest`
 * (`layPlateAudio` in run-job's `renderRegenerate`). This way every joint has the same overlap and the same
 * crossfade, and no window shows a jump backwards.
 * @param frames - frames of the source clip.
 * @returns the first frame of every window, in order.
 */
export function regenerateStarts(frames: number): readonly number[] {
  const total = Math.max(1, Math.round(frames))
  if (total <= REGENERATE_WINDOW_FRAMES) return [0]
  const starts: number[] = []
  for (let start = 0; start + REGENERATE_WINDOW_FRAMES < total; start += REGENERATE_STEP_FRAMES) {
    starts.push(start)
  }
  // The window that covers the tail: it starts at the last useful step, even
  // if its content ends before the clip does.
  starts.push((starts[starts.length - 1] ?? 0) + REGENERATE_STEP_FRAMES)
  return starts
}

/**
 * The draft a window gives the graph: exactly
 * {@link REGENERATE_WINDOW_FRAMES} frames at 24 fps.
 *
 * The graph reads the clip with `LoadVideo` and encodes it in the VAE: the
 * latent's length depends on the frames it receives, and its `length` is 124.
 * A shorter draft (the tail of a clip that ends) misaligns the graph's
 * audio/video concatenation, so the missing frames are cloned with `tpad`
 * instead of leaving the draft short. The draft's audio track does not matter
 * — the finished file takes the original clip's — but `GetVideoComponents`
 * reads it, so a silent clip gets a silent track instead of making the node
 * fail.
 * @param plate - the source clip.
 * @param startFrame - the first frame of the window.
 * @param measured - the clip's probe, when the run already read it; probed here otherwise.
 * @returns the draft's path, outside the gallery; the caller deletes it.
 * @throws {Error} when ffmpeg cannot write it; the partial file is removed.
 */
export async function regenerateDraft(
  plate: string,
  startFrame: number,
  measured?: Pick<MediaProbe, 'hasAudio'>,
): Promise<string> {
  const probe = measured ?? await probeMedia(plate)
  const out = join(tmpdir(), `regenerate-${randomUUID()}.mp4`)
  const span = REGENERATE_WINDOW_FRAMES / FPS
  const from = Math.max(0, startFrame) / FPS
  return ffmpegTo(out, [
    '-v', 'error', '-y',
    // One second more than needed: the cut must be able to deliver 124
    // frames, and when the clip ends earlier `tpad` fills them in.
    '-ss', from.toFixed(4), '-t', (span + 1).toFixed(4), '-i', plate,
    ...probe.hasAudio ? [] : SILENT_STEREO_INPUT,
    '-map', '0:v:0',
    '-map', probe.hasAudio ? '0:a:0' : '1:a',
    // `fps` before `tpad`: the cut lands on a frame and the cloned tail sits
    // on the graph's same 24 fps grid.
    '-vf', `fps=${String(FPS)},tpad=stop_mode=clone:stop_duration=1`,
    '-frames:v', String(REGENERATE_WINDOW_FRAMES),
    // The audio is padded at least to the draft's length (a shorter track
    // would shorten the video with `-shortest`) and then cut there.
    ...probe.hasAudio ? ['-af', `apad=whole_dur=${span.toFixed(4)}`] : [],
    '-shortest',
    ...h264Out(14, 'veryfast'),
    ...AAC_128K,
    out,
  ], 600_000)
}

/**
 * The prompt to regenerate a clip with: the user's, the one the clip was born
 * from, the one the vision model writes for it, or the neutral sentence.
 *
 * The order is not arbitrary. A line the user wrote says what they want to see
 * and wins (a placeholder such as «regenerate» is not one). Without it, the
 * best prompt for the redraw is the one that already produced this clip: it
 * is in the file's note (`origin.prompt`). When that is a placeholder — an upscale, a voice change,
 * an earlier regeneration — the note also says which file it was born from
 * (`origin.source`), and the chain is walked back. Only if the chain leads
 * nowhere is the clip looked at, and the last resort is a neutral sentence: an
 * empty prompt must never reach the graph.
 * @param ctx - the host context, for vision.
 * @param sourceName - the clip's name in the gallery.
 * @param sourcePath - the clip's path.
 * @param chosen - the model the composer chip was showing, when there is one.
 * @param userLine - the line the request carried; empty or a placeholder when the user wrote none.
 * @returns the prompt to give the sampler, never empty.
 */
export async function regeneratePrompt(
  ctx: ImagineHost,
  sourceName: string,
  sourcePath: string,
  chosen?: ModelRoute,
  userLine = '',
): Promise<string> {
  const line = userLine.trim()
  if (line.length > 0 && !PLACEHOLDER_PROMPTS.has(line)) return line
  const filed = await filedPrompt(sourceName)
  if (filed !== undefined) return filed
  const seen = await seenPrompt(ctx, sourcePath, chosen)
  if (seen !== undefined) return seen
  return NEUTRAL_REGENERATE_PROMPT
}

/**
 * The first real prompt the chain of notes carries, if there is one.
 *
 * A placeholder prompt describes nothing: «upscale» or «voice» would redraw
 * the clip like any photo. In that case `origin.source` — the file this clip
 * was born from — is followed and tried again, up to {@link ORIGIN_CHAIN_MAX}
 * steps; the loop is closed by a set of names already seen, because a chain
 * can come back on itself.
 */
async function filedPrompt(name: string): Promise<string | undefined> {
  const visited = new Set<string>()
  let current: string | undefined = name
  for (let hop = 0; hop < ORIGIN_CHAIN_MAX && current !== undefined; hop += 1) {
    if (visited.has(current)) return undefined
    visited.add(current)
    // The type is written out: without it, the assignment of `current` below
    // and the read that feeds it refer to each other and TypeScript cannot
    // resolve it.
    const origin: ImagineFileOrigin | undefined = (await recallNote(current))?.origin
    if (origin === undefined) return undefined
    const prompt = origin.prompt.trim()
    if (prompt.length > 0 && !PLACEHOLDER_PROMPTS.has(prompt)) return prompt
    current = origin.source
  }
  return undefined
}

/**
 * What the clip shows, in a sentence the refiner can use.
 *
 * A single frame, taken shortly after the start: a clip's first frame can be
 * black or mid-fade. The request is in English because that is the language
 * of the video model's prompts, and it asks for a description, not a judgement.
 * @returns the description, or undefined when nobody can look.
 */
async function seenPrompt(
  ctx: ImagineHost,
  sourcePath: string,
  chosen?: ModelRoute,
): Promise<string | undefined> {
  const eyes = eyesOf(ctx, chosen)
  if (eyes === undefined) return undefined
  const frame = join(tmpdir(), `regenerate-frame-${randomUUID()}.png`)
  try {
    await frameAt(sourcePath, frame, { at: 0.3 })
    const result = await lookWith(
      eyes.vision,
      frame,
      'Describe in one English sentence, concretely and without opinions, what this frame shows:'
      + ' the subject, the framing, the clothes, the place and the light, as if the same shot had to be'
      + ' regenerated from your words.',
      eyes.route,
      SIGHT_TIMEOUT_MS,
    )
    const text = result?.text.replace(/\s+/g, ' ').trim()
    // A very long description is a story: the graph reads a sentence, and the
    // cut keeps the prompt within what the model can use.
    if (text === undefined || text.length === 0) {
      console.warn(`[imagine] regenerate detail: ${eyes.route.provider}/${eyes.route.model} did not describe the frame, the refiner starts from the neutral sentence`)
      return undefined
    }
    return text.slice(0, 600)
  } catch (error: unknown) {
    console.warn(`[imagine] regenerate detail: the frame could not be prepared or read, the refiner starts from the neutral sentence: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  } finally {
    await unlink(frame).catch(() => undefined)
  }
}
