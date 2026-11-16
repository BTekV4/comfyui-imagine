/**
 * The geometry of a continuation: what the sampler is given of the clip it
 * follows, and how the two clips are joined afterwards.
 *
 * Extending used to be an image-to-video run from the source's last frame,
 * concatenated to it. A still says nothing about how the camera was moving,
 * and nothing at all about how the clip sounded, so the continuation restaged
 * the shot and wrote itself a new soundtrack — the drift the studio showed at
 * every seam. H3 can be conditioned on a short clip instead of a frame
 * (`MiniMaxH3AddGuide`, a 17k+5 batch with its soundtrack anchored at frame
 * 0), which is what this module prepares and what the extend graph wires.
 * @module tool-comfy/extend-video
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AAC_192K, FASTSTART, FPS, SILENT_STEREO_INPUT, ffmpegTo, h264Out, type MediaProbe } from './media-tools.ts'
import { H3_MAX_CANVAS_PIXELS, H3_NATIVE_MEGAPIXELS, snapToGrid } from './snap-size.ts'

/**
 * Frames of the source clip the continuation is conditioned on.
 *
 * H3 accepts guide clips of 17k+5 frames only, and crops anything else down
 * to the next valid length: 22 is the shortest that carries motion (a single
 * frame is the old behaviour), just under a second at 24 fps.
 */
export const GUIDE_FRAMES = 22

/** How much of the source the guide covers, in seconds. */
export const GUIDE_SECONDS = GUIDE_FRAMES / FPS

/**
 * The join between the two clips, in seconds: four frames at 24 fps.
 *
 * The crossfade costs no time, because it is spent inside the overlap rather
 * than at the end of it: the continuation's opening seconds are the source's
 * own tail generated a second time, so the two clips are blended over content
 * they both show. What is being dissolved there is not one moment into
 * another but the model's reconstruction into the original — the small shift
 * in grain and colour that a latent round trip leaves behind, which at a hard
 * cut measured twice a normal frame's worth of change and here measures none.
 */
const SEAM_SECONDS = 0.167

/** How much of the tail is handed to the graph, in seconds. */
const TAIL_SECONDS = 1.5

/** Canvas sides are multiples of this. */
const CANVAS_MULTIPLE = 32

/**
 * The canvas a continuation renders on: the source's own, when H3 can take it.
 *
 * The guide frames are cover-cropped to the canvas, and the two clips are
 * joined without a rescale, so a canvas that differs from the source is a
 * visible cut — a crop, a zoom, or both. A source that fits the model's
 * ceiling is therefore matched exactly; one that does not (an upscaled clip)
 * is scaled down keeping its aspect, each side rounded DOWN to the 32px grid
 * so the area stays under the ceiling.
 * @param width - the source clip's pixel width.
 * @param height - the source clip's pixel height.
 * @returns the canvas the extend graph is given.
 */
export function h3Canvas(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, Math.sqrt(H3_MAX_CANVAS_PIXELS / (width * height)))
  const side = (value: number): number => snapToGrid(value * scale, CANVAS_MULTIPLE, 'floor')
  return { width: side(width), height: side(height) }
}

/**
 * The canvas of a given area on a clip's own ratio: `ResolutionSelector`'s
 * arithmetic, the area spread over the clip's sides and each rounded to a
 * multiple of 32.
 *
 * Computed here rather than left to the graph because the plugin writes it
 * straight into the graph's scale node («Recreate video»). The default is the
 * model's native canvas of 0.98 megapixels: the ComfyUI H3 guide says "frames
 * well above the native canvas do not hold detail", so a soft frame is a
 * resolution problem first.
 * @param width - the clip's width in pixels.
 * @param height - the clip's height in pixels.
 * @param megapixels - the canvas area, in units of 1024x1024 pixels.
 * @returns the canvas size, or undefined when the clip cannot be read.
 */
export function h3AreaCanvas(
  width: number,
  height: number,
  megapixels = H3_NATIVE_MEGAPIXELS,
): { width: number; height: number } | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return undefined
  const wanted = megapixels * 1024 * 1024
  const scale = Math.sqrt(wanted / (width * height))
  return { width: snapToGrid(width * scale, CANVAS_MULTIPLE), height: snapToGrid(height * scale, CANVAS_MULTIPLE) }
}

/**
 * The ffmpeg call that cuts the tail the guide is read from.
 *
 * A second and a half rather than the guide's own length: the graph takes the
 * LAST {@link GUIDE_FRAMES} frames of what it is given, so a tail that is a
 * few frames short of the ask would silently anchor the continuation before
 * the source's real end. Re-encoded, because a stream copy can only cut at a
 * keyframe. Silence is mixed in when the source has no audio track, so the
 * graph's audio guide always has something to read.
 * @param source - the clip being continued.
 * @param duration - its duration in seconds.
 * @param out - where to write the tail.
 * @param hasAudio - whether the source carries an audio track.
 * @returns the ffmpeg arguments.
 */
function tailArgs(source: string, duration: number, out: string, hasAudio: boolean): string[] {
  const start = Math.max(0, duration - TAIL_SECONDS)
  return [
    '-y',
    '-ss', start.toFixed(3),
    '-i', source,
    ...hasAudio ? [] : SILENT_STEREO_INPUT,
    '-map', '0:v:0',
    '-map', hasAudio ? '0:a:0' : '1:a:0',
    '-r', String(FPS),
    ...h264Out(14),
    ...AAC_192K,
    '-shortest',
    out,
  ]
}

/**
 * The ffmpeg call that joins a clip and its continuation.
 *
 * The continuation opens by reproducing the guide, so its first
 * {@link GUIDE_SECONDS} are the source's own tail generated a second time:
 * they are dropped rather than played twice, all but the last
 * {@link SEAM_SECONDS} the two clips are crossfaded over. The soundtracks are
 * crossfaded across the same window, on constant-power curves — the guide's
 * sound comes back as the same moment but not as the same waveform, so the
 * pair is treated as uncorrelated rather than blended down the middle.
 * @param first - the clip being continued.
 * @param second - the generated continuation.
 * @param firstDuration - the first clip's duration in seconds.
 * @param out - where to write the joined clip.
 * @param size - the source's pixels; the continuation is fitted to them.
 * @returns the ffmpeg arguments.
 */
function seamArgs(
  first: string,
  second: string,
  firstDuration: number,
  out: string,
  size?: { readonly width: number; readonly height: number },
): string[] {
  const offset = Math.max(0, firstDuration - SEAM_SECONDS)
  /*
   * The second input is seeked to just before the end of the guide it
   * reproduced, so the crossfade lands on the overlap and the whole of the
   * source is still played. Seeked rather than `trim`med in the graph: a
   * trimmed stream reaches `xfade` with its frame rate reported as 1/0, and
   * `xfade` refuses anything that is not constant. `setpts` costs the same
   * rate for the same reason, so neither is used on the video path — seeking
   * the input already starts it at zero.
   */
  const filter = [
    `[0:v]fps=${FPS},format=yuv420p[v0]`,
    /*
     * The continuation renders on the graph's own canvas, which snaps to the
     * model's grid: a 720x1280 clip comes back at 704x1280, and `xfade`
     * refuses two different sizes (measured 2026-10-28). Two percent of
     * resample are invisible; a dead job is not.
     */
    `[1:v]fps=${FPS}${size === undefined ? '' : `,scale=${String(size.width)}:${String(size.height)}:flags=lanczos`},format=yuv420p[v1]`,
    `[v0][v1]xfade=transition=fade:duration=${SEAM_SECONDS}:offset=${offset.toFixed(3)}[vout]`,
    '[0:a]aresample=async=1[a0]',
    '[1:a]aresample=async=1[a1]',
    `[a0][a1]acrossfade=d=${SEAM_SECONDS}:c1=qsin:c2=qsin[aout]`,
  ].join(';')
  return [
    '-y',
    '-i', first,
    '-ss', Math.max(0, GUIDE_SECONDS - SEAM_SECONDS).toFixed(3),
    '-i', second,
    '-filter_complex', filter,
    '-map', '[vout]',
    '-map', '[aout]',
    ...h264Out(),
    ...AAC_192K,
    ...FASTSTART,
    out,
  ]
}

/** What ffprobe is asked about a clip before it is cut or joined. */
type ClipProbe = Pick<MediaProbe, 'duration' | 'hasAudio'>

/**
 * Cut the tail the extend graph reads its guide from.
 *
 * Written outside the output directory: it is scratch the gallery must never
 * list, not a generation.
 * @param source - absolute path of the clip being continued.
 * @param probe - the source's duration and audio track.
 * @returns the absolute path of the tail clip.
 */
export async function videoTail(source: string, probe: ClipProbe): Promise<string> {
  const out = join(tmpdir(), `h3-tail-${randomUUID()}.mp4`)
  return ffmpegTo(out, tailArgs(source, probe.duration, out, probe.hasAudio), 120_000)
}

/**
 * Join a clip and its continuation over the one-frame seam.
 * @param first - absolute path of the clip being continued.
 * @param second - absolute path of the generated continuation.
 * @param firstDuration - the first clip's duration in seconds.
 * @param outputDir - directory to write the joined clip in.
 * @param size - the first clip's pixels, as the run measured them; the
 *   continuation is fitted to them. Absent, it is left at its own size.
 * @returns the absolute path of the joined clip.
 */
export async function joinAtSeam(
  first: string,
  second: string,
  firstDuration: number,
  outputDir: string,
  size?: { readonly width: number; readonly height: number },
): Promise<string> {
  // Dot-named, so the gallery skips it until the caller renames it; ffmpegTo
  // removes a failed join so no empty clip lands on the board.
  const out = join(outputDir, `.seam-${randomUUID()}.mp4`)
  return ffmpegTo(out, seamArgs(first, second, firstDuration, out, size), 300_000)
}
