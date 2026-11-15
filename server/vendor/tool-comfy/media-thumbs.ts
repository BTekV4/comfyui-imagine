/**
 * Board thumbnails for the Imagine gallery: a small WebP of a still, or of a
 * clip's first frame, cached on disk next to the notes.
 *
 * The stills ComfyUI writes are 1080×1920 PNGs of 2–4 MB, and the board drew
 * every tile from the original: opening a project of twenty stills moved 86 MB
 * to a tile 260 px wide. A 640 px WebP of the same picture is ~75 KB.
 * @module tool-comfy/media-thumbs
 */

import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { dataPath } from '../home-paths/index.ts'
import { kindOf } from './gallery.ts'
import { execFileAsync } from './media-tools.ts'

/** The widths a thumbnail is cut at; a request is rounded up to one of them. */
export const THUMB_WIDTHS = [256, 640] as const

/**
 * ffmpeg runs at most this many at once. A first visit to a big project asks
 * for dozens in the same second, and the container shares 8 GiB with the
 * server: an unbounded fan-out is a CPU and memory spike for no faster board.
 */
const MAX_RUNNING = 3

let running = 0
const waiting: (() => void)[] = []
/**
 * One generation per source version: both widths are cut by the same ffmpeg,
 * so two tiles of the same file, at either width, share it.
 */
const inFlight = new Map<string, Promise<ReadonlyMap<number, string> | undefined>>()

/**
 * The width a thumbnail request is served at.
 * @param asked - the `thumb` query value.
 * @returns the smallest cut width at least as wide, or undefined for a value
 *   that is not a positive number (the caller then serves the original).
 */
export function thumbWidthFor(asked: string | null): number | undefined {
  if (asked === null) return undefined
  const width = Number(asked)
  if (!Number.isFinite(width) || width <= 0) return undefined
  return THUMB_WIDTHS.find(cut => cut >= width) ?? THUMB_WIDTHS[THUMB_WIDTHS.length - 1]
}

/**
 * Whether a gallery file has a picture to cut a thumbnail from.
 * @param name - the gallery basename.
 * @returns true for stills and clips. Audio has no picture.
 */
export function canThumb(name: string): boolean {
  const kind = kindOf(name)
  return kind === 'image' || kind === 'video'
}

/** Directory the thumbnails are cached in. */
function thumbsDir(): string {
  return dataPath('comfy', 'thumbs')
}

/** The version of a source a thumbnail was cut from: its size and mtime. */
function stampOf(size: number, mtimeMs: number): string {
  return `${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}`
}

/**
 * The cache file name of one thumbnail. The source's size and mtime are in
 * the name, so a crop that rewrites a still in place is cut again rather than
 * served stale.
 */
function thumbFile(name: string, width: number, stamp: string): string {
  return `${name}.${String(width)}.${stamp}.webp`
}

/** A cache file name split back into gallery name, width and stamp. */
const THUMB_FILE = /^(.+)\.(\d+)\.([0-9a-f]+-[0-9a-f]+)\.webp$/

/**
 * The cache files on disk, by gallery name.
 *
 * Read from the directory once and kept in step with every write and delete
 * here: forgetting the old cuts of one file used to list the whole directory
 * (thousands of entries) after every single cut.
 */
let index: Promise<Map<string, Set<string>>> | undefined

function thumbIndex(): Promise<Map<string, Set<string>>> {
  index ??= (async () => {
    const byName = new Map<string, Set<string>>()
    let entries: string[] = []
    try {
      entries = await readdir(thumbsDir())
    } catch {
      // No directory yet: nothing cut so far.
    }
    for (const entry of entries) {
      const name = THUMB_FILE.exec(entry)?.[1]
      if (name === undefined) continue
      let files = byName.get(name)
      if (files === undefined) byName.set(name, files = new Set())
      files.add(entry)
    }
    return byName
  })()
  return index
}

/**
 * ffmpeg arguments that cut every width from one decode of the first frame.
 * @param source - absolute path of the gallery file.
 * @param outs - the widths and where each is written.
 * @returns the argument list.
 */
function thumbsArgs(source: string, outs: readonly (readonly [number, string])[]): string[] {
  // Never upscale: a still narrower than the cut keeps its own width.
  const scale = (width: number): string => `scale='min(${String(width)},iw)':-2`
  const encode = ['-frames:v', '1', '-c:v', 'libwebp', '-quality', '78', '-f', 'webp', '-y']
  if (outs.length === 1) {
    const [width, out] = outs[0] as readonly [number, string]
    return ['-v', 'error', '-i', source, '-vf', scale(width), ...encode, out]
  }
  const labels = outs.map((_, i) => `[t${String(i)}]`)
  const graph = `[0:v]split=${String(outs.length)}${labels.map((_, i) => `[s${String(i)}]`).join('')};`
    + outs.map(([width], i) => `[s${String(i)}]${scale(width)}${labels[i] ?? ''}`).join(';')
  return [
    '-v', 'error', '-i', source, '-filter_complex', graph,
    ...outs.flatMap(([, out], i) => ['-map', labels[i] ?? '', ...encode, out]),
  ]
}

async function slot(): Promise<void> {
  if (running < MAX_RUNNING) {
    running++
    return
  }
  await new Promise<void>((resolve) => { waiting.push(resolve) })
  running++
}

function release(): void {
  running--
  waiting.shift()?.()
}

/**
 * The thumbnail of one gallery file, cut on first request.
 *
 * Every width is cut by the same ffmpeg the first time either is asked for,
 * and the cuts of older versions of the file are removed once the new ones
 * are written. Before 2026-10-20 that cleanup removed the other width of the
 * same version too, so the 256 and the 640 deleted each other in turn and
 * ffmpeg ran again at every visit.
 * @param source - absolute path of the gallery file.
 * @param name - its basename, already validated by the caller.
 * @param width - a width from THUMB_WIDTHS.
 * @returns the thumbnail path, or undefined when it cannot be cut (the caller
 *   serves the original instead, so a broken thumbnail never blanks a tile).
 */
export async function thumbnailOf(source: string, name: string, width: number): Promise<string | undefined> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(source)
  } catch {
    return undefined
  }
  const stamp = stampOf(info.size, info.mtimeMs)
  const out = join(thumbsDir(), thumbFile(name, width, stamp))
  const known = (await thumbIndex()).get(name)
  if (known?.has(thumbFile(name, width, stamp)) === true) {
    try {
      await stat(out)
      return out
    } catch {
      // Removed behind our back: cut it again.
      known.delete(thumbFile(name, width, stamp))
    }
  }
  const key = `${name}\0${stamp}`
  if ((failedUntil.get(key) ?? 0) > Date.now()) return undefined
  let job = inFlight.get(key)
  if (job === undefined) {
    job = cut(source, name, stamp).then((paths) => {
      if (paths === undefined) rememberFailedCut(key)
      return paths
    })
    inFlight.set(key, job)
    void job.finally(() => { inFlight.delete(key) })
  }
  return (await job)?.get(width)
}

/**
 * How long a version ffmpeg could not cut is served whole without trying
 * again. Without it every request for the tile ran ffmpeg anew, up to its
 * 30 s timeout each; with no end to it, a cut that only timed out on a busy
 * disk (the warm-up after a restart) would never be retried.
 */
const FAILED_CUT_TTL_MS = 10 * 60_000

/** Versions (`name\0stamp`) whose cut failed, and until when they are left alone. */
const failedUntil = new Map<string, number>()

/** Remember a failed cut, dropping the expired ones so the map stays small. */
function rememberFailedCut(key: string): void {
  const now = Date.now()
  for (const [other, until] of failedUntil) {
    if (until <= now) failedUntil.delete(other)
  }
  failedUntil.set(key, now + FAILED_CUT_TTL_MS)
}

/**
 * Cut every missing width of one source version, then forget older versions.
 * @returns the path of each width, or undefined when ffmpeg failed.
 */
async function cut(source: string, name: string, stamp: string): Promise<ReadonlyMap<number, string> | undefined> {
  await slot()
  try {
    await mkdir(thumbsDir(), { recursive: true })
    const files = (await thumbIndex()).get(name)
    const paths = new Map<number, string>(THUMB_WIDTHS.map(width => [width, join(thumbsDir(), thumbFile(name, width, stamp))]))
    const missing = THUMB_WIDTHS.filter(width => files?.has(thumbFile(name, width, stamp)) !== true)
    if (missing.length > 0) {
      // Written under a temporary name and renamed, so a request that lands
      // mid-write never serves half a file as the finished thumbnail.
      const outs = missing.map(width => [width, `${paths.get(width) ?? ''}.part`] as const)
      try {
        await execFileAsync('ffmpeg', thumbsArgs(source, outs), { timeout: 30_000 })
        for (const [, partial] of outs) await rename(partial, partial.slice(0, -'.part'.length))
      } catch (error) {
        await Promise.all(outs.map(([, partial]) => rm(partial, { force: true })))
        throw error
      }
      const byName = await thumbIndex()
      let entries = byName.get(name)
      if (entries === undefined) byName.set(name, entries = new Set())
      for (const width of missing) entries.add(thumbFile(name, width, stamp))
    }
    // The cuts of older versions of this file (before a crop) are dead weight now.
    await forgetThumbs(name, stamp)
    return paths
  } catch {
    return undefined
  } finally {
    release()
  }
}

/**
 * Remove the cached thumbnails of one gallery file.
 * @param name - the gallery basename.
 * @param keepStamp - the source version whose cuts stay (every width of it);
 *   all cuts go when omitted.
 */
export async function forgetThumbs(name: string, keepStamp?: string): Promise<void> {
  const files = (await thumbIndex()).get(name)
  if (files === undefined) return
  const stale = [...files].filter(file => keepStamp === undefined || THUMB_FILE.exec(file)?.[3] !== keepStamp)
  for (const file of stale) files.delete(file)
  await Promise.all(stale.map(file => rm(join(thumbsDir(), file), { force: true })))
}
