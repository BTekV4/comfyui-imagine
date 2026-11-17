/**
 * The picture that goes with a notice: a small JPEG made from the file that
 * was (or was to be) published.
 *
 * A photo is scaled down; a video gives one frame, a second in (the first
 * frame of a reel is often black or a fade). The JPEG lives in a temporary
 * folder that is removed once the notice has gone, sent or not.
 *
 * Nothing here is allowed to stop a notice: a missing ffmpeg, a file that is
 * gone, a frame that cannot be read — all end in `undefined`, and the notice
 * goes out as text.
 * @module social/preview
 */
import { execFile } from 'node:child_process'
import { mkdtemp, stat } from 'node:fs/promises'
import { rmWithRetry } from '../../../server/vendor/retry-fs/index.ts'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { errorText, log, resolveMediaPath } from './context.ts'

const run = promisify(execFile)

/** The extensions read as video. */
const VIDEO = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'])

/** How long ffmpeg has for one picture. */
const FFMPEG_TIMEOUT_MS = 20_000

/** The longest side of the picture: plenty for a phone, small to send. */
const MAX_SIDE = 1280

/** A picture ready to be sent, and how to remove it. */
export interface Preview {
  readonly path: string
  cleanup(): Promise<void>
}

/** True when a file name reads as a video. */
export function isVideo(file: string): boolean {
  return VIDEO.has(extname(file).toLowerCase())
}

/**
 * The ffmpeg arguments for one picture.
 * @param input - the source.
 * @param output - the JPEG to write.
 * @param seek - for a video, where to take the frame (seconds).
 * @returns the arguments.
 */
export function ffmpegArgs(input: string, output: string, seek?: number): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...seek === undefined ? [] : ['-ss', String(seek)],
    '-i', input,
    '-frames:v', '1',
    '-vf', `scale='min(${String(MAX_SIDE)},iw)':-2`,
    '-q:v', '4',
    output,
  ]
}

/**
 * Make the picture for a published (or failed) file.
 * @param file - a gallery name or an absolute path.
 * @returns the picture, or undefined when none could be made.
 */
export async function previewOf(file: string | undefined): Promise<Preview | undefined> {
  if (file === undefined || file === '') return undefined
  let dir: string | undefined
  try {
    const source = isAbsolute(file) ? file : await resolveMediaPath(file)
    if (source === undefined) return undefined
    dir = await mkdtemp(join(tmpdir(), 'imagine-preview-'))
    const output = join(dir, 'preview.jpg')
    const video = isVideo(source)
    try {
      await run('ffmpeg', ffmpegArgs(source, output, video ? 1 : undefined), { timeout: FFMPEG_TIMEOUT_MS })
    } catch (error: unknown) {
      // A clip shorter than a second has no frame there: take the first one.
      if (!video) throw error
      await run('ffmpeg', ffmpegArgs(source, output), { timeout: FFMPEG_TIMEOUT_MS })
    }
    if ((await stat(output)).size === 0) throw new Error('empty picture')
    const folder = dir
    return { path: output, cleanup: () => rmWithRetry(folder, { recursive: true, force: true }) }
  } catch (error: unknown) {
    log(`no picture for the notice (${file}): ${errorText(error)}`)
    if (dir !== undefined) await rmWithRetry(dir, { recursive: true, force: true }).catch(() => undefined)
    return undefined
  }
}
