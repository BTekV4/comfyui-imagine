/**
 * The ffmpeg/ffprobe calls every Imagine module shares.
 *
 * Before 2026-10-20 each module promisified `execFile` on its own and wrote
 * its own ffprobe; four variants read the same two fields and disagreed on
 * what a failed probe returns. One spelling here.
 * @module tool-comfy/media-tools
 */

import { execFile } from 'node:child_process'
import { rm, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { lastJsonLine } from './model-json.ts'

/** `execFile` as a promise, resolving to stdout and stderr. */
export const execFileAsync = promisify(execFile)

/** The frame rate every H3 graph in this deployment renders at. */
export const FPS = 24

/** The sample rate every soundtrack the studio writes is mixed at. */
export const AUDIO_RATE = 48000

/**
 * The H.264 video encoding the joins and cuts write: 8-bit 4:2:0 so every
 * player opens it. CRF 17 is the default the montage and the seam use.
 * @param crf - the quality, lower is better.
 * @param preset - the x264 preset, when the caller trades speed for size.
 * @returns the ffmpeg arguments.
 */
export function h264Out(crf = 17, preset?: string): readonly string[] {
  return ['-c:v', 'libx264', '-crf', String(crf), ...preset === undefined ? [] : ['-preset', preset], '-pix_fmt', 'yuv420p']
}

/** AAC at 192 kb/s, the soundtrack of every join. */
export const AAC_192K: readonly string[] = ['-c:a', 'aac', '-b:a', '192k']

/** AAC at 128 kb/s, the soundtrack of the scratch plates and the swap's mux. */
export const AAC_128K: readonly string[] = ['-c:a', 'aac', '-b:a', '128k']

/** The `moov` box up front, so a player and the gallery's header probe read the file at once. */
export const FASTSTART: readonly string[] = ['-movflags', '+faststart']

/** What a probe of a media file reports. */
export interface MediaProbe {
  /** Duration in seconds; 0 when ffprobe cannot say. */
  readonly duration: number
  /** Whether the file carries an audio track. */
  readonly hasAudio: boolean
  /** Width of the first video stream, when there is one. */
  readonly width?: number
  /** Height of the first video stream, when there is one. */
  readonly height?: number
  /** Frames per second of the first video stream, when ffprobe knows it. */
  readonly fps?: number
  /** Frame count of the first video stream, when the container records it. */
  readonly frames?: number
}

function positive(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function rate(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const [num, den] = value.split('/').map(Number)
  if (num === undefined || !Number.isFinite(num)) return undefined
  if (den === undefined) return positive(num)
  return den > 0 ? positive(num / den) : undefined
}

/**
 * Probes already made, by path, with the version of the file they read.
 *
 * The same song is probed by every step of a music video (the plan, each
 * resume, the cut, the scoring); its size and mtime say whether the answer
 * still holds. Bounded: the oldest entries go first.
 */
const probed = new Map<string, { readonly size: number; readonly mtimeMs: number; readonly probe: MediaProbe }>()

/** How many probes are remembered. */
const PROBE_CACHE_ENTRIES = 256

/**
 * Read duration, sound, size and frame rate of one file in a single ffprobe.
 *
 * Remembered while the file's size and mtime stay the same; a failed probe is
 * not remembered.
 * @param path - absolute path of the file.
 * @returns the probe; a zero duration and no audio when ffprobe fails.
 */
export async function probeMedia(path: string): Promise<MediaProbe> {
  const info = await stat(path).catch(() => undefined)
  const known = probed.get(path)
  if (info !== undefined && known !== undefined && known.size === info.size && known.mtimeMs === info.mtimeMs) {
    return known.probe
  }
  const probe = await ffprobeOnce(path)
  if (info !== undefined && probe.duration > 0) {
    probed.delete(path)
    probed.set(path, { size: info.size, mtimeMs: info.mtimeMs, probe })
    if (probed.size > PROBE_CACHE_ENTRIES) probed.delete(probed.keys().next().value as string)
  }
  return probe
}

/** One ffprobe of one file. */
async function ffprobeOnce(path: string): Promise<MediaProbe> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type,width,height,avg_frame_rate,r_frame_rate,nb_frames',
      '-of', 'json',
      path,
    ], { timeout: 30_000 })
    const probed = JSON.parse(stdout) as {
      format?: { duration?: string }
      streams?: { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; nb_frames?: string }[]
    }
    const streams = probed.streams ?? []
    const video = streams.find(stream => stream.codec_type === 'video')
    const duration = Number(probed.format?.duration ?? 0)
    return {
      duration: Number.isFinite(duration) ? duration : 0,
      hasAudio: streams.some(stream => stream.codec_type === 'audio'),
      width: positive(video?.width),
      height: positive(video?.height),
      fps: rate(video?.avg_frame_rate) ?? rate(video?.r_frame_rate),
      frames: positive(video?.nb_frames),
    }
  } catch {
    return { duration: 0, hasAudio: false }
  }
}

/**
 * Run ffmpeg into `out`, removing a half-written `out` when it fails.
 * @param out - the file ffmpeg writes (also the last argument the caller passes).
 * @param args - the full ffmpeg argument list.
 * @param timeoutMs - how long ffmpeg may run.
 * @returns the path written.
 */
export async function ffmpegTo(out: string, args: readonly string[], timeoutMs: number): Promise<string> {
  try {
    await execFileAsync('ffmpeg', [...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
    return out
  } catch (error) {
    await rm(out, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Run a read-only ffmpeg pass (a measurement written to `-f null`) and hand
 * back what it printed.
 * @param args - the full ffmpeg argument list.
 * @param timeoutMs - how long ffmpeg may run.
 * @param maxBuffer - how much output may be kept.
 * @returns stdout and stderr.
 */
export async function ffmpegRead(
  args: readonly string[],
  timeoutMs: number,
  maxBuffer = 16 * 1024 * 1024,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('ffmpeg', [...args], { timeout: timeoutMs, maxBuffer })
}

/**
 * Lay a soundtrack over a picture without re-encoding the picture.
 * @param video - the clip whose first video stream is kept.
 * @param audio - the file whose first audio stream replaces the clip's.
 * @param out - the file to write.
 * @param options - `optional` lets a source without audio leave the picture
 *   silent instead of failing; `pad` pads the track with silence to the
 *   picture; `aac` is the encoding (192 kb/s unless said); `faststart` moves
 *   the index up front; `timeoutMs` bounds ffmpeg (ten minutes by default).
 * @returns the path written.
 */
export async function muxAudio(
  video: string,
  audio: string,
  out: string,
  options: {
    readonly optional?: boolean
    readonly pad?: boolean
    readonly aac?: readonly string[]
    readonly faststart?: boolean
    readonly timeoutMs?: number
  } = {},
): Promise<string> {
  return ffmpegTo(out, [
    '-v', 'error', '-y',
    '-i', video,
    '-i', audio,
    '-map', '0:v:0',
    '-map', options.optional === true ? '1:a:0?' : '1:a:0',
    '-c:v', 'copy', ...options.aac ?? AAC_192K,
    ...options.pad === true ? ['-af', 'apad'] : [],
    '-shortest',
    ...options.faststart === true ? FASTSTART : [],
    out,
  ], options.timeoutMs ?? 600_000)
}

/**
 * Pull one frame of a clip into a still.
 *
 * The last frame is not asked for as one frame after `-sseof`: that gave the
 * first frame after the seek point, a couple of frames before the end, and a
 * continuation read a moment it does not actually start from. Every frame of
 * the last half second is written to the same file instead (`-update 1`), so
 * what stays on disk is the final one.
 * @param video - the source clip.
 * @param out - the still to write; its extension picks the format.
 * @param options - `at` seconds from the start, or `last` for the final frame; `maxSide` to shrink it;
 *   `quality` as ffmpeg's `-q:v` (2 best … 31 worst) for a JPEG.
 * @returns the path written.
 */
export async function frameAt(
  video: string,
  out: string,
  options: {
    readonly at?: number
    readonly last?: boolean
    readonly maxSide?: number
    readonly quality?: number
    readonly timeoutMs?: number
  } = {},
): Promise<string> {
  const last = options.last === true
  const seek = last ? ['-sseof', '-0.5'] : ['-ss', String(options.at ?? 0)]
  const frames = last ? [] : ['-frames:v', '1']
  const scale = options.maxSide === undefined
    ? []
    : ['-vf', `scale=w='min(${String(options.maxSide)},iw)':h='min(${String(options.maxSide)},ih)':force_original_aspect_ratio=decrease`]
  const quality = options.quality === undefined ? [] : ['-q:v', String(options.quality)]
  const tail = [...frames, ...scale, ...quality, '-update', '1', out]
  const timeout = options.timeoutMs ?? 30_000
  await ffmpegTo(out, ['-v', 'error', '-y', ...seek, '-i', video, ...tail], timeout)
  if (last || await hasFrame(out)) return out
  /*
   * Some clips carry an index the fast seek lands past: VP9 inside MP4, which
   * is what a browser recording uploads, made ffmpeg exit 0 and write nothing
   * (measured 2026-11-08: «Estrai frame» saved no image at any time). The same
   * frame is taken again with the seek on the output side, which decodes from
   * the start and is right even when the index is not.
   */
  await rm(out, { force: true }).catch(() => undefined)
  await ffmpegTo(out, ['-v', 'error', '-y', '-i', video, ...seek, ...tail], timeout)
  return out
}

/** Whether a frame file was written and is not empty. */
async function hasFrame(path: string): Promise<boolean> {
  return stat(path).then(info => info.size > 0).catch(() => false)
}

/**
 * Run tasks a few at a time, keeping their order, never rejecting.
 * @param items - the work items.
 * @param limit - how many tasks may be in flight at once.
 * @param task - the work for one item.
 * @returns one entry per item, `undefined` where the task failed.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<(R | undefined)[]> {
  const results = new Array<R | undefined>(items.length).fill(undefined)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next
      next += 1
      try {
        results[index] = await task(items[index] as T, index)
      } catch {
        results[index] = undefined
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(0, Math.min(limit, items.length)) }, () => worker()))
  return results
}

/**
 * Run one of the deployment's measuring probes (the lipsync one)
 * and read the JSON line it prints last, after whatever its libraries print.
 *
 * Every probe is a guard: no answer leaves the shot as it is. That is right for the video and wrong for whoever reads the log —
 * on 2026-10-23 a probe had been crashing for a week (mediapipe wanted
 * libEGL) and every take passed without a word — so a probe that
 * fails or prints no JSON is always logged here.
 * @param label - which probe, for the log line.
 * @param probe - the configured executable.
 * @param args - its arguments; the first is the file it measures.
 * @param timeoutMs - how long it may run.
 * @returns the JSON object, or undefined when there is none.
 */
export async function runProbe(
  label: string,
  probe: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<Record<string, unknown> | undefined> {
  const what = basename(args[0] ?? '')
  try {
    const { stdout } = await execFileAsync(probe, [...args], { timeout: timeoutMs, maxBuffer: 1 << 20 })
    const answer = lastJsonLine(stdout)
    if (answer === undefined) console.warn(`[imagine] probe ${label} got no answer on ${what}`)
    return answer
  } catch (error: unknown) {
    console.warn(`[imagine] probe ${label} not run on ${what}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}
