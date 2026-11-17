/**
 * The watermark on what leaves the studio.
 *
 * Every file the publisher sends — a photo, a reel, a carousel's pieces, a
 * story — is copied to a scratch folder with the account's mark written in the
 * bottom-right corner, and the copy is what the Python scripts upload. The
 * file in the gallery is never touched: the studio keeps its own master, and
 * the mark exists only on the account (2026-11-11, at the owner's request).
 *
 * The text and the switch are settings (`watermark`, `watermarkText`), read at
 * every publication like the rest of the account's choices. The text is
 * escaped for `drawtext`, so a `:`, a `'`, a `%` or a backslash in it is drawn
 * as typed instead of breaking the filter.
 *
 * A failed ffmpeg is not allowed to stop the account: it is reported in the
 * journal and the file goes out without the mark.
 * @module instagram/watermark
 */
import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { rmWithRetry } from '../../../server/vendor/retry-fs/index.ts'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'
import { mediaTypeOfExt } from '../../../shared/media-types.ts'
import { log, socialSettings } from './context.ts'

const run = promisify(execFile)

/** The bold face the mark is drawn with; DejaVu ships with the container. */
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'

/**
 * What the mark can be drawn on, by the studio's one extension table: a video
 * or a still. Anything else (an audio file, a container the gallery does not
 * list, such as `.mkv` or `.avi`) is published as it is — the table used to
 * have its own copy with those two, and sent them down the video branch.
 * @param source - the file.
 * @returns the kind, or undefined when the mark is not drawn on it.
 */
function markableKind(source: string): 'video' | 'image' | undefined {
  const kind = mediaTypeOfExt(extname(source))?.kind
  return kind === 'video' || kind === 'image' ? kind : undefined
}

/** A set of watermarked copies, and the way to delete them. */
export interface MarkedMedia {
  /** The copies to publish. */
  readonly paths: readonly string[]
  /** Delete the scratch folder; never throws. */
  readonly cleanup: () => Promise<void>
}

/**
 * Escape a text for ffmpeg's `drawtext`.
 * @param text - what the mark says.
 * @returns the text as the filter's `text` option wants it.
 */
function drawtextText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
}

/**
 * The `drawtext` filter for one file: bottom right, small, legible over both a
 * dark and a light picture (white text on a soft black plate).
 * @param text - what the mark says.
 * @returns the filter description.
 */
function filterOf(text: string): string {
  // Sizes follow the picture: a 1080-wide story and a 4K still carry the same
  // mark, proportionate, instead of a caption that disappears on one of them.
  return [
    'drawtext=fontfile=' + FONT,
    `text='${drawtextText(text)}'`,
    'fontcolor=white@0.72',
    'fontsize=h/38',
    'x=w-tw-28',
    'y=h-th-28',
    'box=1',
    'boxcolor=black@0.28',
    'boxborderw=14',
  ].join(':')
}

/**
 * Make one watermarked copy.
 * @param source - the gallery file.
 * @param target - where the copy goes.
 * @param text - what the mark says.
 * @param video - re-encode a clip, or write one frame of a still.
 * @returns the copy's path.
 */
async function markOne(source: string, target: string, text: string, video: boolean): Promise<string> {
  const draw = filterOf(text)
  const args = video
    ? [
      '-y', '-i', source,
      '-vf', draw,
      // Re-encoded: a filter cannot ride on a copied stream. `veryfast` and
      // crf 22 keep a generation of quality; the reel script encodes once
      // more on its way out, as it already did.
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      target,
    ]
    /*
     * A still is one frame. JPEG at q2 rather than PNG: the mark is the only
     * thing that should change, and q2 is visually lossless on a photo while
     * a 4K PNG weighs ~9 MB — the Drive upload is the slow part of a
     * publication, measured at 178-207 s for the clips.
     */
    : ['-y', '-i', source, '-vf', draw, '-frames:v', '1', '-q:v', '2', target]
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { maxBuffer: 8 * 1024 * 1024 })
  return target
}

/**
 * The copies the publisher should send, with the mark on them.
 *
 * With the setting off — or when ffmpeg fails — the files come back as they
 * were, so a publication is never lost to the watermark.
 * @param paths - the gallery files the post names.
 * @returns the copies to publish, and the way to remove them.
 */
export async function watermarkMedia(paths: readonly string[]): Promise<MarkedMedia> {
  const unchanged = async (): Promise<readonly string[]> => paths
  let setting: { on: boolean; text: string }
  try {
    const settings = socialSettings()
    setting = { on: settings.watermarkOn(), text: settings.watermarkText() }
  } catch {
    // The context is not there (a route answered before setup): no mark.
    return { paths: await unchanged(), cleanup: async () => undefined }
  }
  if (!setting.on || setting.text.length === 0 || paths.length === 0) {
    return { paths: await unchanged(), cleanup: async () => undefined }
  }
  const folder = await mkdtemp(join(tmpdir(), 'imagine-watermark-'))
  const cleanup = async (): Promise<void> => {
    await rmWithRetry(folder, { recursive: true, force: true }).catch(() => undefined)
  }
  const marked: string[] = []
  try {
    for (const source of paths) {
      const kind = markableKind(source)
      if (kind === undefined) {
        marked.push(source)
        continue
      }
      const video = kind === 'video'
      const name = `${basename(source, extname(source))}${video ? '.mp4' : '.jpg'}`
      marked.push(await markOne(source, join(folder, name), setting.text, video))
    }
  } catch (error: unknown) {
    log(`watermark failed, publishing without it: ${error instanceof Error ? error.message : String(error)}`)
    await cleanup()
    return { paths, cleanup: async () => undefined }
  }
  return { paths: marked, cleanup }
}
