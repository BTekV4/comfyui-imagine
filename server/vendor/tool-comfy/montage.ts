/**
 * The other kind of long video: shots cut together, one per photo.
 *
 * `story` is a single unbroken take — each clip continues the last one, so it
 * uses exactly one source image however many the project has. A music video is
 * the opposite: a handful of stills, one shot each, cut one after the other.
 * The user said it plainly with a lookbook on the board — *"this way it makes the
 * video from 1 single image when it has many more available"*.
 *
 * So the clips here do not continue each other: each is generated from its own
 * photo and they are concatenated at the end, on hard cuts. Everything else —
 * the queue, the plan, the song laid over the whole — is the story chain's.
 * @module tool-comfy/montage
 */

import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AAC_128K, AAC_192K, AUDIO_RATE, FASTSTART, FPS, ffmpegTo, h264Out } from './media-tools.ts'
import { MAX_STORY_SECONDS, MIN_SHOT_SECONDS } from '../../../shared/imagine-media.ts'

/** How long the concatenation may take before it is given up on. */
const JOIN_TIMEOUT_MS = 600_000

/**
 * Longest single clip the video model renders.
 *
 * H3 takes 5, 10 or 15 seconds and only the first two at 720p; ten is what a
 * story's clips already use. A montage that divides its length by its photos
 * has to stop here — the card refuses the rest.
 */
export const MAX_SHOT_SECONDS = 10

/**
 * The dissolve between two shots, in seconds.
 *
 * Short enough that a ten-second shot keeps its beat, long enough to read as a
 * transition rather than a dropped frame. It is also the amount each shot after
 * the first moves earlier in the finished video, which `fadedStart` gives back
 * to the song offsets so the singing stays on the mouths.
 */
const CROSSFADE_SECONDS = 0.5

/**
 * Where a shot's slice of the song starts, once the fades are accounted for.
 *
 * Every dissolve overlaps two shots, so shot n begins n * CROSSFADE_SECONDS earlier
 * in the joined video than the sum of the shots before it.
 * @param before - the seconds of every shot before this one.
 * @param index - the shot's position, from zero.
 * @returns the second of the song this shot sings from, never negative.
 */
export function fadedStart(before: number, index: number, overlap = CROSSFADE_SECONDS): number {
  return Math.max(0, before - index * overlap)
}

/**
 * The seconds of each shot of a montage, in order.
 *
 * At least one shot per photo — the count is not ours to pick, the user chose
 * it when they picked the pictures — but never a shot the video model cannot
 * render: H3 takes ten seconds at 0.8 MP and refuses more. Forty seconds over
 * two photos as two twenty-second clips is a run that dies on the card
 * ("Allocation on device 0 would exceed allowed memory", measured 2026-09-07),
 * so a video longer than its photos allow gets **more shots than photos** and
 * the caller cycles the pictures back round.
 *
 * The other end is the floor: photos that would leave shots under it are
 * dropped rather than rushed, and the caller uses as many as it gets back.
 * Shots that continue each other lose their head: every shot after the first
 * is sampled with the previous shot's last frames pinned in front of it and
 * delivered without them, so a chain of ten-second shots is shorter than ten
 * times its count. `lost` is what each of those shots gives up, and the count
 * grows until what is delivered still covers the song.
 * @param totalSeconds - the whole video's length.
 * @param photos - how many photos the montage has to cut between.
 * @param maxShot - the longest clip this deployment's video workflow renders.
 * @param lost - seconds every shot after the first spends on its pinned head.
 * @returns the seconds of each shot; one entry per shot, photos cycled.
 */
export function montageShots(totalSeconds: number, photos: number, maxShot = MAX_SHOT_SECONDS, lost = 0): number[] {
  const total = Math.min(MAX_STORY_SECONDS, Math.max(MIN_SHOT_SECONDS, Math.round(totalSeconds)))
  const longest = Math.max(MIN_SHOT_SECONDS, Math.round(maxShot))
  let wanted = Math.max(Math.max(1, Math.round(photos)), Math.ceil(total / longest))
  // Counted on what the sampler actually renders (a ten-second shot is 10.125 s),
  // and never a shot above the ceiling once the remainder is spread: the
  // pinned heads add seconds to sample, and "9 + 1 for the remainder" is a
  // ten-second shot the card was told not to render.
  while (wanted * renderedSeconds(longest) < total + (wanted - 1) * lost
    || Math.ceil(Math.round(total + (wanted - 1) * lost) / wanted) > longest) wanted += 1
  const count = Math.max(1, Math.min(wanted, Math.floor(total / MIN_SHOT_SECONDS)))
  // What has to be sampled to deliver `total` once the pinned heads come off.
  const sampled = Math.round(total + (count - 1) * lost)
  const base = Math.floor(sampled / count)
  const extra = sampled - base * count
  const shots = Array.from({ length: count }, (_unused, index) => base + (index < extra ? 1 : 0))
  if (lost > 0 && count > 1) {
    /*
     * The chain ends with the song. Rendering rounds every shot up to the
     * frame grid, so a chain sized on requested seconds runs past the track
     * — 3.4 s on a 40 s song — and the last shot's slice of it is asked for
     * beyond the end. The slice cannot be cut short (the pinned head then
     * does not hold), so the last shot is, down to the floor.
     */
    const delivered = (list: readonly number[]): number =>
      list.reduce((sum, seconds) => sum + renderedSeconds(seconds), 0) - (list.length - 1) * lost
    let last = shots[count - 1] ?? base
    while (last > MIN_SHOT_SECONDS && delivered([...shots.slice(0, -1), last - 1]) >= total) last -= 1
    shots[count - 1] = last
  }
  return shots
}

/**
 * The ffmpeg call that cuts a list of clips together.
 *
 * Every input is normalised before the concat: the filter refuses streams that
 * disagree on size, frame rate, pixel format or sample rate, and clips
 * generated from different stills do disagree — H3 renders each one on the
 * canvas its own photo implies. Re-encoded for the same reason; a stream copy
 * would need identical encodings, which is exactly what is not guaranteed.
 * @param paths - the clips, in the order they play.
 * @param width - the canvas every shot is scaled to.
 * @param height - the canvas every shot is scaled to.
 * @param out - the file to write.
 * @param durations - the length of each clip, in the order they play, which is
 * what the dissolves are placed on; a clip may be longer than the seconds it
 * delivers when it arrives with a head of its own.
 * @param fade - the seconds each join dissolves over.
 * @returns the argv for ffmpeg.
 */
function cutsArgs(
  paths: readonly string[],
  width: number,
  height: number,
  out: string,
  durations?: readonly number[],
  fade = CROSSFADE_SECONDS,
): string[] {
  const parts: string[] = []
  for (let index = 0; index < paths.length; index += 1) {
    parts.push(
      `[${String(index)}:v]fps=${String(FPS)},scale=${String(width)}:${String(height)}:force_original_aspect_ratio=decrease,`
      + `pad=${String(width)}:${String(height)}:-1:-1,setsar=1,format=yuv420p[v${String(index)}]`,
    )
    parts.push(`[${String(index)}:a]aresample=async=1,aformat=sample_fmts=fltp:sample_rates=${String(AUDIO_RATE)}:channel_layouts=stereo[a${String(index)}]`)
  }
  const fading = durations !== undefined && durations.length === paths.length && paths.length > 1
  if (fading) {
    /*
     * Cross-faded rather than butt-joined: eleven hard cuts read as eleven
     * separate clips played back to back. Each fade eats `fade` seconds of the
     * pair, so every shot after the first starts that much earlier — which is
     * why the song offsets the clips were generated against subtract the same
     * amount (`fadedStart`), or the mouths would drift from the track by the
     * whole accumulated overlap.
     *
     * The offset is read off the timeline as it grows instead of accumulated
     * from the lengths, because a clip may arrive with a head of its own: the
     * object swap's windows carry half a second of the window before them
     * (the same instants, so the dissolve blends a moment with itself) and are
     * `duration + fade` long. `played` is how long the joined file is so far,
     * so the dissolve always starts one fade before its end, and a clip that
     * brings its own overlap gives the fade back instead of losing it.
     */
    let played = durations[0] ?? 0
    let last = 'v0'
    for (let index = 1; index < paths.length; index += 1) {
      const offset = Math.max(0, played - fade)
      played = offset + (durations[index] ?? 0)
      const outLabel = index === paths.length - 1 ? 'vout' : `x${String(index)}`
      parts.push(
        `[${last}][v${String(index)}]xfade=transition=fade:duration=${fade.toFixed(2)}`
        + `:offset=${offset.toFixed(3)}[${outLabel}]`,
      )
      last = outLabel
    }
    let lastAudio = 'a0'
    for (let index = 1; index < paths.length; index += 1) {
      const outLabel = index === paths.length - 1 ? 'aout' : `y${String(index)}`
      parts.push(
        `[${lastAudio}][a${String(index)}]acrossfade=d=${fade.toFixed(2)}[${outLabel}]`,
      )
      lastAudio = outLabel
    }
  }
  else {
    const streams = paths.map((_unused, index) => `[v${String(index)}][a${String(index)}]`).join('')
    parts.push(`${streams}concat=n=${String(paths.length)}:v=1:a=1[vout][aout]`)
  }
  return [
    '-y',
    ...paths.flatMap(path => ['-i', path]),
    '-filter_complex', parts.join(';'),
    '-map', '[vout]',
    '-map', '[aout]',
    ...h264Out(),
    ...AAC_192K,
    ...FASTSTART,
    out,
  ]
}

/**
 * Cut the shots of one montage together into a single clip.
 *
 * The canvas is the first shot's: it is the one the user framed the video
 * with, and letterboxing the others into it keeps a portrait video portrait
 * even if one photo was not.
 * @param paths - the clips, in the order they play.
 * @param width - the first shot's width.
 * @param height - the first shot's height.
 * @param outputDir - the validated media output directory.
 * @param durations - each clip's own length, which places the dissolves.
 * @param fade - the seconds each join dissolves over.
 * @returns the path of the joined clip.
 * @throws {Error} when ffmpeg cannot write it; the partial file is removed.
 */
export async function joinCuts(
  paths: readonly string[],
  width: number,
  height: number,
  outputDir: string,
  durations?: readonly number[],
  fade = CROSSFADE_SECONDS,
): Promise<string> {
  // Dot-named, so the gallery skips it until the caller renames it; ffmpegTo
  // removes a failed join so no empty clip lands on the board.
  const out = join(outputDir, `.montage-${randomUUID()}.mp4`)
  return ffmpegTo(out, cutsArgs(paths, width, height, out, durations, fade), JOIN_TIMEOUT_MS)
}

/**
 * The ffmpeg call that closes a clip into a loop.
 *
 * H3 is conditioned on the still as both the first and the last frame, but it
 * does not land on it: measured on a 20-second animated background, the last
 * frame sits 12.5 from the first where a normal frame step is 0.5, and played
 * on repeat that reads as a jump. The tail is dissolved over the head and the
 * body follows, so the file begins inside the dissolve and ends one frame
 * before the dissolve's first frame: the join lands on consecutive frames of
 * the same motion instead of on two unrelated ones. Measured on the same clip:
 * 3.7 after the wrap against 12.5 before it, and the file gives up one
 * dissolve's worth of length.
 *
 * The soundtrack is dropped. A background is played behind something else and
 * the model's audio is invented room tone nobody asked for; the video stream is
 * the whole deliverable.
 *
 * The `fps` normalisation is not decoration: it is declared before the cut, so
 * the cut lands on a frame, and again after it, because `trim` hands the
 * dissolve an input with no frame rate and xfade refuses it ("current rate of
 * 1/0 is invalid").
 * @param path - the clip to close.
 * @param duration - the clip's length in seconds.
 * @param fade - the dissolve's length in seconds.
 * @param out - the file to write.
 * @returns the argv for ffmpeg.
 */
function loopWrapArgs(path: string, duration: number, fade: number, out: string): string[] {
  const tail = Math.max(0, duration - fade)
  const step = `setpts=PTS-STARTPTS,fps=${String(FPS)}`
  return [
    '-y',
    '-i', path,
    '-filter_complex', [
      /*
       * The rate comes before the cut on purpose. `trim` cuts on the input's
       * own timestamps, and the file being closed is the assembler's own
       * output — a concat of dissolved segments whose frames do not sit
       * exactly on the grid. Trimming first put the loop up to four frames out
       * (measured 20.7 between the last frame and the first where a frame step
       * is 2.6); normalising first makes both cuts land on frames, and the
       * same measurement comes out 3.7.
       */
      `[0:v]fps=${String(FPS)},trim=start=${tail.toFixed(3)},${step}[tailv]`,
      `[0:v]fps=${String(FPS)},trim=0:${fade.toFixed(3)},${step}[headv]`,
      `[tailv][headv]xfade=transition=fade:duration=${fade.toFixed(2)}:offset=0[wrapv]`,
      `[0:v]fps=${String(FPS)},trim=start=${fade.toFixed(3)}:end=${tail.toFixed(3)},${step}[bodyv]`,
      '[wrapv][bodyv]concat=n=2:v=1:a=0[vout]',
    ].join(';'),
    '-map', '[vout]',
    '-an',
    ...h264Out(),
    ...FASTSTART,
    out,
  ]
}

/**
 * Close a clip into a loop, leaving it alone when it is too short to wrap.
 *
 * A clip shorter than three dissolves has no body left between the head and
 * the tail, and wrapping it would deliver a fraction of what was asked for;
 * the caller keeps the clip it rendered.
 * @param path - the clip to close.
 * @param duration - the clip's length in seconds.
 * @param outputDir - the validated media output directory.
 * @param fade - the dissolve's length in seconds.
 * @returns the path of the closed clip, or the clip itself when it is too short.
 * @throws {Error} when ffmpeg cannot write it; the partial file is removed.
 */
export async function closeLoop(
  path: string,
  duration: number,
  outputDir: string,
  fade = CROSSFADE_SECONDS,
): Promise<string> {
  if (!(duration > fade * 3)) return path
  const out = join(outputDir, `.loop-${randomUUID()}.mp4`)
  return ffmpegTo(out, loopWrapArgs(path, duration, fade, out), JOIN_TIMEOUT_MS)
}

/**
 * Frames H3 actually renders for a shot of this many seconds.
 *
 * The sampler takes a frame count on a fixed grid — 5 plus a multiple of 17 —
 * so a ten-second shot comes back as 243 frames, which is 10.125 seconds at 24
 * fps. Slicing the song every ten seconds while the shots are 10.125 long puts
 * every shot an eighth of a second later than the slice it was given, and the
 * error accumulates: 1.4 seconds by the eleventh shot of a music video, which
 * is the singing visibly behind the track.
 * @param seconds - the length the shot was asked for.
 * @returns the frame count the sampler will use.
 */
function renderedFrames(seconds: number): number {
  const wanted = Math.max(1, Math.round(seconds * FPS))
  // Up to the grid, never down: the graph's own expression is
  // `n + (5 - n % 17) % 17`, so nine seconds is 226 frames, not 209. Rounding
  // to the nearest step put every nine-second shot's slice 0.7 s early, and
  // the error stacked down the chain.
  const steps = Math.max(0, Math.ceil((wanted - 5) / 17))
  return 5 + steps * 17
}

/**
 * The real length of a shot of this many seconds, in seconds.
 * @param seconds - the length the shot was asked for.
 * @returns what the sampler produces, on the frame grid.
 */
export function renderedSeconds(seconds: number): number {
  return renderedFrames(seconds) / FPS
}

/**
 * A copy of a clip with a silent soundtrack.
 *
 * The long video upscaler loads its input through VideoHelperSuite, whose
 * audio extractor runs ffmpeg for a stream the file may not have: a clip
 * without one kills the graph before its first frame — "VHS failed to extract
 * audio", measured 2026-10-15 on an animated background, which is delivered
 * without a soundtrack on purpose. The copy goes to the system temporary
 * directory rather than the media directory, which the gallery lists: it is an
 * input for one run, not a file to look at. The video stream is copied, so
 * nothing is re-encoded and the whole thing costs about a second.
 * @param path - the clip to copy.
 * @param name - what makes the copy unique.
 * @returns the path of the copy.
 * @throws {Error} when ffmpeg cannot write it; the partial file is removed.
 */
export async function silentCopy(path: string, name: string): Promise<string> {
  const out = join(tmpdir(), `imagine-silent-${name}.mp4`)
  return ffmpegTo(out, [
    '-y',
    '-i', path,
    '-f', 'lavfi',
    '-i', `anullsrc=channel_layout=stereo:sample_rate=${String(AUDIO_RATE)}`,
    '-map', '0:v',
    '-map', '1:a',
    '-c:v', 'copy',
    ...AAC_128K,
    '-shortest',
    ...FASTSTART,
    out,
  ], JOIN_TIMEOUT_MS)
}
