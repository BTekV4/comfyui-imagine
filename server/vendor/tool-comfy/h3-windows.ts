/**
 * The windows of an H3 clip edit (the object swap): the canvas one window
 * renders on, how a plate is split into windows (on its own cuts when it has
 * them), the 24 fps scratch plates each window reads, and the plate's audio
 * laid back over the joined picture.
 *
 * The texts the graph is given are `object-swap-texts.ts`; the render loop
 * is `swap-windows.ts`. Some measurements below date from before the object
 * swap had the windows to itself; the numbers are the ones it runs on.
 * @module tool-comfy/h3-windows
 */

import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { AAC_128K, FPS, ffmpegRead, ffmpegTo, h264Out, muxAudio, probeMedia } from './media-tools.ts'
import { renderedSeconds } from './montage.ts'
import { H3_NATIVE_MEGAPIXELS, snapToGrid } from './snap-size.ts'
import { message } from '../../src/messages.ts'

/**
 * Frames cloned onto the end of the resampled plate.
 *
 * H3 renders only `17k+5` frames and the graphs round a window up to that
 * grid, so a window can ask for up to sixteen frames more than the plate
 * holds; a reference video shorter than the length is cut down to the grid
 * below instead, and the finished clip runs out of step with the plate. The
 * clone covers the largest rounding; the extra frames fall away when the
 * windows are joined at their own lengths and when the plate's audio is laid
 * over the file with `-shortest`.
 */
const H3_PLATE_PAD_FRAMES = 16

/**
 * The canvas one H3 window renders on, from the plate's own ratio.
 *
 * The arithmetic is `ResolutionSelector`'s — the model's native canvas of 0.98
 * megapixels on the plate's ratio, rounded to a multiple of 32 — but the number
 * is computed here because the plugin writes it straight into the graph's
 * scale node. The aspect pin could not be used: asking for it made the host
 * stamp the graph's FIRST `ImageScale` with the lookbook's fixed 1080x1920, and
 * the first real chain rendered 2 MP windows instead of the megapixel it asked
 * for (measured 2026-10-15, 15m38s per window).
 *
 * The ComfyUI H3 guide is explicit about this size: the open weights generate
 * at a 768-pixel short edge, "frames well above the native canvas do not hold
 * detail", and "steps do not add sharpness the native canvas cannot resolve, so
 * a soft frame is a resolution problem first". The half-megapixel windows this
 * replaced were soft and wider than the plate (768x1344 for a 9:16 plate).
 * A graph that wants another area says so with `canvasMegapixels` in its
 * workflow entry: half a megapixel as ai-toolkit counts it, 500 000 pixels
 * (0.4768 here), gives 544x928 for a 9:16 plate, and on 2026-10-16 it kept the
 * source timing (mean offset 1.0 frames over 141) where 544x960 repeated a
 * 17-frame block (7.2).
 * @param width - the plate's width in pixels.
 * @param height - the plate's height in pixels.
 * @param megapixels - the canvas area, in units of 1024x1024 pixels.
 * @returns the canvas size, or undefined when the plate cannot be read.
 */
export function h3WindowCanvas(
  width: number,
  height: number,
  megapixels = H3_NATIVE_MEGAPIXELS,
): { width: number; height: number } | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return undefined
  const wanted = megapixels * 1024 * 1024
  const scale = Math.sqrt(wanted / (width * height))
  return { width: snapToGrid(width * scale, 32), height: snapToGrid(height * scale, 32) }
}

/**
 * Frames one H3 pass renders at most: the ceiling of its own `17k+5` grid.
 *
 * The open weights generate about fifteen seconds in one pass and the grid's
 * largest length below that is 362, which is what the guide's numbers and this
 * deployment's measurements agree on (2026-10-23). A window is never planned
 * past it: the graph rounds whatever it is asked for up to the grid, and a
 * request over the ceiling comes back as a window that repeats a block of
 * frames and drifts out of step with its own audio.
 */
const H3_MAX_FRAMES = 362
/** The same ceiling in seconds, which is what a window is measured in. */
const H3_MAX_WINDOW_SECONDS = H3_MAX_FRAMES / FPS
/**
 * Frames one window renders at the native canvas.
 *
 * 124 frames — 5,167 s at 24 fps — is this graph's pairing at 0,98 MP: it is what
 * the swap has shipped and measured at. Eight seconds do **not** fit here, and
 * that is measured: on 2026-10-24 a 226-frame, 768x1344 window died on the card
 * (`execution_error` on the first prompt of the run) and the window ladder had to
 * re-plan it — the story chain's 243 frames at 736x1344 belong to a graph without
 * the SAM3 track, the noise mask and the reference encode on top.
 */
const H3_WINDOW_FRAMES = 124
/** The same window in seconds, which is what a window is measured in. */
export const H3_WINDOW_SECONDS = H3_WINDOW_FRAMES / FPS
/**
 * Frames one window renders on a canvas small enough to carry a longer pass.
 *
 * 192 frames — eight seconds — at 480p (0,41 MP) and below: a quarter of the
 * native canvas, and the pairing measured at 544x928 on 2026-10-23 (identity held
 * exactly as well as at five seconds: sonda 0,755/0,799 against 0,737/0,741/0,704).
 * On the 480p route the 226 frames of an 8,8-second clip then scored 0,678 to the
 * photo against 0,079 to the plate.
 *
 * Eight and not the model's own ceiling: a fifteen-second pass **loses the swap**
 * (measured the same day: 0,271 to the photo against 0,477 to the plate), so a
 * longer clip is chained, never stretched. And eight not five because it costs
 * nothing and halves the joins, each of which is a dissolve a viewer can see.
 */
export const H3_LOW_CANVAS_WINDOW_FRAMES = 192
/** The canvas area under which a window may be planned long. */
const H3_LOW_CANVAS_MEGAPIXELS = 0.5
/**
 * The window a plan falls back to when the one it asked for does not fit the card.
 *
 * 90 frames, 3,75 s: the last rung of the memory ladder, under the native 124 and
 * under the eight-second 192. Below it the motion floor takes over and splitting
 * further stops being useful.
 */
export const H3_RETRY_WINDOW_FRAMES = 90
/**
 * Seconds of head a chained window repeats from the window before it.
 *
 * Half a second, twelve frames at 24 fps: the same length the join dissolves
 * over, so the overlap is the dissolve and costs the file nothing. The head is
 * not filler — it is the previous window's own last frames, handed back to the
 * graph as the frame its window starts from. That is what carries the face, the
 * light and the grain of one render into the next instead of restarting from
 * the plate: two windows rendered from the plate alone differ, and a dissolve
 * between them is a face morphing (measured 2026-10-24: 13,5 between two
 * frames at the join against a local 2,7 on a calm clip).
 */
export const H3_JOIN_SECONDS = 12 / FPS
/** A window shorter than this renders too few frames to carry the motion. */
const H3_MIN_WINDOW_SECONDS = 2.5

/**
 * One window of a plate: where it starts, how long it renders and what it adds.
 *
 * `start` is the plate second the render begins at, which is not the second the
 * window *delivers* from: every window after the first begins one overlap early,
 * so that the head it renders is the same instant the window before it ended on.
 */
export interface H3Window {
  /** The plate second this window's render starts at, its head included. */
  readonly start: number
  /** Seconds the graph renders: what the window delivers plus its head. */
  readonly seconds: number
  /** Seconds this window adds to the joined file. */
  readonly deliver: number
  /** Seconds of head repeated from the window before it; zero for the first. */
  readonly overlap: number
}

/**
 * Split a clip into the windows the graph renders.
 *
 * H3 is asked for a frame count at 24 fps and the graph's own slice reads the
 * same span, so the windows are contiguous and each one delivers its own
 * seconds. A clip that fits in one pass is never split.
 *
 * Every window after the first also renders an overlap of head, and that head
 * is the plate time the window before it ended on: the two sides of the join
 * are then the same instant rendered twice, so the dissolve blends one moment
 * with itself instead of showing half a second of the action twice. The head
 * costs twelve frames and gives the timeline back — the joined file is exactly
 * as long as the plate, which is what keeps the plate's audio in sync
 * (measured 2026-10-24: the old plan cut half a second per join out of the
 * picture and laid the untouched soundtrack over it, so a three-window clip
 * ran a full second ahead of its own audio by the end).
 * @param duration - the clip's length in seconds.
 * @param window - the seconds one window delivers, when the caller asked.
 * @param overlap - the seconds of head a window after the first renders again.
 * @param cuts - the plate's own cut points, in seconds; a boundary within reach
 * of one is moved onto it, because a join that lands on a cut in the source is
 * not a join at all.
 * @returns the windows in order, never empty.
 */
export function planWindows(
  duration: number,
  window = H3_WINDOW_SECONDS,
  overlap = H3_JOIN_SECONDS,
  cuts: readonly number[] = [],
): readonly H3Window[] {
  const total = Number.isFinite(duration) && duration > 0 ? duration : window
  /*
   * The fewest windows that stay inside one pass, each the same length.
   *
   * Full windows and a tail used to be the plan, with a tail under the floor
   * folded into the window before it: a thirty-second clip became `14 + 16`,
   * and the graph rounds sixteen seconds up to 396 frames, past the 362 the
   * weights render. Splitting evenly costs the same GPU time — the cost is the
   * seconds rendered, not the number of windows — and it buys two things: no
   * window is past the ceiling, and no window is short enough to drop the
   * motion. A thirty-second clip is `15 + 15`: one dissolve, both native.
   */
  const ceiling = Math.min(H3_MAX_WINDOW_SECONDS, Math.max(H3_MIN_WINDOW_SECONDS, window))
  // The number of windows nearest the planned one, then nudged so no window
  // drifts past 1,3x it (a six-second window is the adapter's own sweet spot,
  // eight is where the drift starts) and none falls under the motion floor.
  let count = Math.max(1, Math.round(total / ceiling))
  while (total / count > ceiling * 1.3) count += 1
  while (count > 1 && total / count < H3_MIN_WINDOW_SECONDS) count -= 1
  /*
   * And never past the model's own ceiling, whatever the caller asked: a window
   * over 362 frames is rounded up to a length the weights do not render (396 for
   * sixteen seconds) and comes back repeating a block, out of step with its own
   * audio, with nothing said about it. The 1,3x rule above is a planning margin,
   * not a licence to cross that line.
   */
  while (total / count > H3_MAX_WINDOW_SECONDS) count += 1
  const bounds = windowBounds(total, count, cuts)
  const windows: H3Window[] = []
  for (let index = 0; index < count; index += 1) {
    const from = bounds[index] ?? 0
    const to = bounds[index + 1] ?? total
    const deliver = Math.max(0, to - from)
    // Never more than half a window of head, and never before the plate's
    // first frame: the first window is the plate itself.
    const head = index === 0 ? 0 : Math.min(overlap, deliver / 2, from)
    windows.push({ start: from - head, seconds: deliver + head, deliver, overlap: head })
  }
  return windows
}

/**
 * Where the windows meet: the even split, moved onto the plate's own cuts.
 *
 * A swap that has to be split at all is best split where the source already
 * cuts: the two windows then carry two different shots, which is exactly what a
 * cut is, and nothing has to be hidden. The move is bounded — a window keeps its
 * motion floor, its ceiling and at most 40% of the even length of reach — so a
 * clip with no cut near a boundary is planned exactly as before.
 * @param total - the plate's length in seconds.
 * @param count - how many windows the plan has.
 * @param cuts - the plate's cut points, in seconds.
 * @returns `count + 1` boundaries, from 0 to the plate's end.
 */
function windowBounds(total: number, count: number, cuts: readonly number[]): readonly number[] {
  const size = total / count
  const bounds: number[] = [0]
  for (let index = 1; index < count; index += 1) bounds.push(index * size)
  bounds.push(total)
  if (cuts.length === 0) return bounds
  const reach = Math.min(size * 0.4, 2.5)
  for (let index = 1; index < bounds.length - 1; index += 1) {
    const nominal = bounds[index] ?? 0
    let best: number | undefined
    for (const cut of cuts) {
      if (!Number.isFinite(cut) || cut <= 0 || cut >= total) continue
      if (Math.abs(cut - nominal) > reach) continue
      if (best === undefined || Math.abs(cut - nominal) < Math.abs(best - nominal)) best = cut
    }
    if (best === undefined) continue
    const before = best - (bounds[index - 1] ?? 0)
    const after = (bounds[index + 1] ?? total) - best
    if (before < H3_MIN_WINDOW_SECONDS || before > H3_MAX_WINDOW_SECONDS) continue
    if (after < H3_MIN_WINDOW_SECONDS || after > H3_MAX_WINDOW_SECONDS) continue
    bounds[index] = best
  }
  return bounds
}

/**
 * The seconds the clip cuts on, read off its own frame differences.
 *
 * The swap's windows are planned on these when the plan has more than one: the
 * user's own clips are edited pieces with cuts in them (the one measured on
 * 2026-10-24 cuts at 3,6 s), and a join placed on one is invisible because the
 * picture is supposed to change there.
 *
 * ffmpeg's `scene` score found nothing on that clip, so this measures what a cut
 * actually does to the picture: `tblend=difference` gives the mean change
 * between consecutive frames, and a cut is a spike the rest of the clip does not
 * explain. The spike has to beat `max(12, p95 x 2)` and be 1,5x its own
 * neighbours, which keeps a fast gesture from being read as an edit.
 *
 * Never throws: a clip without cuts, or a detector that cannot run, leaves the
 * even split.
 * @param plate - the 24 fps plate.
 * @returns the cut times in seconds, ascending; empty when there are none.
 */
export async function sceneCuts(plate: string): Promise<readonly number[]> {
  try {
    /*
     * Full resolution on purpose: a `scale=320` before `tblend` would be
     * cheaper, but the thresholds above were measured on full-size frames and
     * a smaller picture changes every difference they are compared with.
     */
    const { stderr } = await ffmpegRead([
      '-v', 'info', '-i', plate,
      '-an',
      '-vf', 'tblend=all_mode=difference,signalstats,metadata=print',
      '-f', 'null', '-',
    ], 300_000, 16 << 20)
    const rows: { at: number; value: number }[] = []
    let at: number | undefined
    for (const line of stderr.split('\n')) {
      const time = /pts_time:([0-9]+(?:\.[0-9]+)?)/.exec(line)
      if (time?.[1] !== undefined) {
        at = Number(time[1])
        continue
      }
      const value = /signalstats\.YAVG=([0-9]+(?:\.[0-9]+)?)/.exec(line)
      if (value?.[1] === undefined || at === undefined) continue
      rows.push({ at, value: Number(value[1]) })
      at = undefined
    }
    if (rows.length < 3) return []
    const sorted = rows.map(row => row.value).sort((left, right) => left - right)
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0
    const limit = Math.max(12, p95 * 2)
    const cuts: number[] = []
    for (let index = 1; index < rows.length - 1; index += 1) {
      const row = rows[index]
      const before = rows[index - 1]
      const after = rows[index + 1]
      if (row === undefined || before === undefined || after === undefined) continue
      if (row.value < limit) continue
      if (row.value < Math.max(before.value, after.value) * 1.5) continue
      if (row.at < 0.25) continue
      const last = cuts[cuts.length - 1]
      // A detector that fires twice in a row is reading a transition, not two
      // cuts; one boundary per second is enough to plan on.
      if (last !== undefined && row.at - last < 1) continue
      cuts.push(Math.round(row.at * 1000) / 1000)
    }
    return cuts
  } catch (error: unknown) {
    console.warn(`[imagine] windowed swap: cannot read the cuts of the plate: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

/**
 * The seconds one window delivers, for the canvas the run asked for.
 *
 * Eight seconds under 0,5 MP, the native 124-frame window above it, for the
 * memory reasons on {@link H3_WINDOW_FRAMES}: a clip that fits in one window has
 * no join to hide, and the canvas decides how long a window the card holds. A
 * request that names its own seconds keeps them (the memory ladder then shortens
 * them on its own): the one place the default is decided, for the job that is
 * queued and for the run that reads it.
 * @param asked - the seconds and the canvas area the job asked for, if it asked.
 * @returns the seconds one window delivers.
 */
export function windowSecondsOf(asked: { readonly seconds?: number | undefined; readonly megapixels?: number | undefined }): number {
  if (asked.seconds !== undefined) return asked.seconds
  const area = asked.megapixels ?? H3_NATIVE_MEGAPIXELS
  const frames = area <= H3_LOW_CANVAS_MEGAPIXELS ? H3_LOW_CANVAS_WINDOW_FRAMES : H3_WINDOW_FRAMES
  return frames / FPS
}

/** One window's plate: the previous render's tail in front of the plate's own frames. */
export interface ChainedPlate {
  /** The 24 fps plate the run resampled, absolute path. */
  readonly plate: string
  /** The clip the window before this one produced, absolute path. */
  readonly previous: string
  /** Seconds that clip delivers into the joined file. */
  readonly previousDeliver: number
  /** Plate second this window starts at, its head included. */
  readonly start: number
  /** Seconds the graph renders for this window. */
  readonly seconds: number
  /** Seconds of head taken from the previous clip. */
  readonly overlap: number
}

/**
 * The plate one chained window renders from.
 *
 * The graph takes a video and starts its window at `start_time` from that
 * video's own first frame, and it pins that first frame as the guide the whole
 * window is generated from. Handing it the plate at the window's start would
 * pin the *unedited* plate again, which is the render every window would then
 * restart from — the reason two windows of one clip do not look alike. This
 * writes a plate whose head is the previous window's own last frames, at the
 * plate times those frames stand for, and whose body is the plate from there
 * on; the graph pins the edit it made itself, so the window continues the
 * edited object instead of inventing it a second time.
 *
 * The soundtrack is the plate's for the same span, head included: the audio
 * guide is what keeps the words and the action on the plate's clock, and it has
 * to start where the file does or the window runs late by the overlap.
 * @param window - the plate, the clip before it and the span to build.
 * @returns the absolute path of the scratch plate; the caller removes it.
 * @throws {Error} when ffmpeg cannot write it; the partial file is removed.
 */
export async function chainWindowPlate(window: ChainedPlate): Promise<string> {
  const probe = await probeMedia(window.plate)
  const width = probe.width
  const height = probe.height
  if (width === undefined || height === undefined) throw new Error(message('plate.sizeUnreadable'))
  const out = join(tmpdir(), `h3-chain-${randomUUID()}-${String(Math.round(window.start * 1000))}.mp4`)
  const headFrom = Math.max(0, window.previousDeliver - window.overlap)
  const canvas = `scale=${String(width)}:${String(height)},setsar=1,format=yuv420p`
  /*
   * The plate is built at the length the graph will actually ask for, on its
   * `17k+5` grid, not at the window's own seconds. A plate one grid step short
   * makes the render come back shorter than the plan: measured 2026-10-24, a
   * five-second window asked for 5,45 s rendered 124 frames instead of 141, the
   * joined file came out 0,294 s short of the plate and the join skipped that
   * much of the action. The surplus is dropped by the next join, exactly like a
   * window's extra tail.
   */
  const span = renderedSeconds(window.seconds)
  return ffmpegTo(out, [
    '-v', 'error', '-y',
    // The plate for the whole span, soundtrack included: the audio has to start
    // at the head, so it cannot be cut with the picture below.
    '-ss', window.start.toFixed(4), '-t', span.toFixed(4), '-i', window.plate,
    '-ss', headFrom.toFixed(4), '-t', window.overlap.toFixed(4), '-i', window.previous,
    '-filter_complex', [
      `[1:v]fps=${String(FPS)},${canvas}[head]`,
      // The body is the plate from the end of the head on: `fps` first, so the
      // cut lands on a frame and not between two.
      `[0:v]fps=${String(FPS)},trim=start=${window.overlap.toFixed(4)},setpts=PTS-STARTPTS,${canvas}[body]`,
      '[head][body]concat=n=2:v=1:a=0[v]',
    ].join(';'),
    '-map', '[v]',
    '-map', '0:a:0?',
    // The soundtrack is padded to the picture instead of the picture being cut
    // to the soundtrack: `-shortest` here threw away the frame the graph needed
    // to see at the end of the span. The padded tail is silent and falls inside
    // the surplus the join drops.
    ...probe.hasAudio ? ['-af', `apad=whole_dur=${span.toFixed(4)}`] : [],
    ...h264Out(14, 'veryfast'),
    ...AAC_128K,
    out,
  ], 300_000)
}

/**
 * A 24 fps copy of a clip, written outside the output directory.
 *
 * The graph renders 24 frames a second and reads the plate's frames as its
 * reference: a 30 fps plate handed over untouched would put 30 frames where
 * the model expects 24, and the action in the finished clip would run at the
 * wrong speed. The copy ends on {@link H3_PLATE_PAD_FRAMES} cloned frames,
 * and its audio is the plate's own, unpadded. The copy is scratch — the gallery
 * must never list it — and the caller removes it.
 * @param path - absolute path of the plate.
 * @returns the absolute path of the copy.
 */
export async function resampleTo24(path: string): Promise<string> {
  const out = join(tmpdir(), `h3-plate24-${randomUUID()}.mp4`)
  return ffmpegTo(out, [
    '-v', 'error', '-y',
    '-i', path,
    '-vf', `fps=${String(FPS)},tpad=stop_mode=clone:stop=${String(H3_PLATE_PAD_FRAMES)}`,
    ...h264Out(14, 'veryfast'),
    ...AAC_128K,
    out,
  ], 600_000)
}

/**
 * Remove scratch files, ignoring the ones already gone.
 * @param paths - absolute paths of the files.
 */
export async function dropScratch(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map(path => unlink(path).catch(() => undefined)))
}

/**
 * The finished picture with the plate's own audio laid over it.
 *
 * Each window was guided by a slice of the plate's soundtrack and H3 wrote
 * audio of its own on top of that — a guess about a room it only saw through
 * a reference. What the user filmed is the track they expect back, so it
 * replaces the generated one over the whole file; a silent plate leaves the
 * picture alone.
 * @param video - absolute path of the assembled picture.
 * @param plate - absolute path of the resampled plate.
 * @param dir - the output directory the copy is written into.
 * @returns the absolute path of the file with the plate's audio, or the input
 *   when there is no track to lay over it.
 */
export async function layPlateAudio(
  video: string,
  plate: string,
  dir: string,
  /**
   * What the scratch file is called before the caller renames it. Dot-named so
   * the gallery skips it meanwhile; one name per caller keeps a failed mux
   * legible in the directory.
   */
  scratch = 'plate-audio',
): Promise<string> {
  const out = join(dir, `.${scratch}-${randomUUID()}.mp4`)
  try {
    // Optional: a plate without a soundtrack leaves the picture as it is.
    return await muxAudio(video, plate, out, { optional: true, aac: AAC_128K })
  } catch (error: unknown) {
    // The picture still goes out, but without the user's sound: say so.
    console.warn(`[imagine] original audio not put back on ${basename(video)}: ${error instanceof Error ? error.message : String(error)}`)
    return video
  }
}
