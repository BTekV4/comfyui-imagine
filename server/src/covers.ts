/**
 * The personal cover files: what is in `<data>/covers/`.
 *
 * A key has ONE file, of any accepted type: it used to be always
 * `<key>.webp`, now the content decides the extension (`video.mp4` for a
 * video). The functions below keep a key and a file tied together: look up by
 * key regardless of the extension, replace a key's file without leaving two
 * competing for the name, and report the list to the client (which must know
 * whether to draw `<img>` or `<video>`).
 * @module covers
 */

import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { rmWithRetry } from '../vendor/retry-fs/index.ts'
import { join } from 'node:path'
import { coverTypeOfBytes, coverTypeOfName, type CoverType } from '../../shared/cover-kinds.ts'
import { dataPath } from '../vendor/home-paths/index.ts'
import { message } from './messages.ts'

/** A personal cover found on disk. */
export interface CoverFile {
  readonly key: string
  readonly file: string
  readonly type: CoverType
}

/** The poster of a personal video cover: its first frame. */
export interface CoverPoster {
  readonly key: string
  readonly file: string
}

/** A key's poster file, beside the cover. */
const POSTER_NAME = 'poster.webp'

/**
 * A cover key. The same shape the client sends: a letter, then letters,
 * digits and hyphens. No dots or slashes, so the key is also a safe file name
 * inside the covers folder.
 */
const COVER_KEY = /^[a-z][A-Za-z0-9-]*$/

/** The personal covers folder (outside webDir: it survives deploys). */
export function coversDir(): string {
  return dataPath('covers')
}

/**
 * The key, if it is a valid key.
 * @param value - what the request carried.
 * @returns the key, or undefined when it is not one.
 */
export function coverKeyOf(value: string): string | undefined {
  return COVER_KEY.test(value) ? value : undefined
}

/**
 * The last listing of each covers folder, kept until the folder's mtime moves
 * (it does whenever a file is added, removed or renamed): every `/imagine/*`
 * request looks a cover up, and a `readdir` each time was the cost.
 */
const listings = new Map<string, { readonly mtime: number; readonly files: readonly CoverFile[] }>()

/**
 * The cover files present, by key.
 * @param dir - the covers folder.
 * @returns one entry per file; a directory that is not there is empty.
 */
export async function listCoverFiles(dir: string): Promise<CoverFile[]> {
  const mtime = await stat(dir).then(info => info.mtimeMs, () => undefined)
  if (mtime === undefined) {
    listings.delete(dir)
    return []
  }
  const known = listings.get(dir)
  if (known?.mtime === mtime) return [...known.files]
  const names = await readdir(dir).catch(() => [] as string[])
  const found: CoverFile[] = []
  for (const name of names) {
    const dot = name.lastIndexOf('.')
    if (dot <= 0) continue
    const key = name.slice(0, dot)
    const type = coverTypeOfName(name)
    if (type === undefined || !COVER_KEY.test(key)) continue
    found.push({ key, file: join(dir, name), type })
  }
  listings.set(dir, { mtime, files: found })
  return [...found]
}

/**
 * The one file of a key among several: a leftover from before the upload
 * cleaned up. The newest wins, which is the one the user just put there.
 * @param found - the key's files, at least one.
 * @returns the file to use.
 */
async function newestOf(found: readonly CoverFile[]): Promise<CoverFile | undefined> {
  if (found.length <= 1) return found[0]
  const ordered = await Promise.all(found.map(async entry => ({
    entry,
    at: (await stat(entry.file).catch(() => undefined))?.mtimeMs ?? 0,
  })))
  ordered.sort((a, b) => b.at - a.at)
  return ordered[0]?.entry
}

/**
 * A key's file, whatever its extension: this is what lets
 * `/imagine/video.webp` serve a `covers/video.mp4`.
 * @param dir - the covers folder.
 * @param key - the cover key.
 * @returns the file, or undefined when the key has no cover.
 */
export async function coverFileOf(dir: string, key: string): Promise<CoverFile | undefined> {
  return await newestOf((await listCoverFiles(dir)).filter(entry => entry.key === key))
}

/**
 * The poster of a personal video cover: `<key>.poster.webp`.
 *
 * It is a separate file because a key can have only one cover (the video),
 * and the poster must neither compete for that name nor appear among the
 * covers (the key `video.poster` does not pass the key shape, so the lookup by
 * key ignores it).
 * @param dir - the covers folder.
 * @param key - the cover key.
 * @returns the poster file, or undefined when the key has none.
 */
export async function coverPosterOf(dir: string, key: string): Promise<CoverPoster | undefined> {
  const file = join(dir, `${key}.${POSTER_NAME}`)
  const info = await stat(file).catch(() => undefined)
  return info === undefined || !info.isFile() ? undefined : { key, file }
}

/**
 * The list the client asks for to know the type of each cover.
 *
 * A key with several files reports the one `coverFileOf` serves (the newest):
 * until 2026-11-14 this took the first the folder listed, and the client could
 * draw a `<video>` for a key whose address served the image.
 * @param dir - the covers folder.
 * @returns kind and extension by key.
 */
export async function coverIndex(dir: string): Promise<Record<string, { kind: CoverType['kind']; ext: string }>> {
  const byKey = new Map<string, CoverFile[]>()
  for (const entry of await listCoverFiles(dir)) byKey.set(entry.key, [...byKey.get(entry.key) ?? [], entry])
  const index: Record<string, { kind: CoverType['kind']; ext: string }> = {}
  for (const [key, found] of byKey) {
    const entry = await newestOf(found)
    if (entry !== undefined) index[key] = { kind: entry.type.kind, ext: entry.type.ext }
  }
  return index
}

/**
 * Remove every cover of a key, of any type: a key has a single file, and
 * replacing a video with an image must not leave two files competing for the
 * name (with the video winning by date). The poster goes too: it is the first
 * frame of the video being replaced, and left behind it showed the old clip
 * before the new one started.
 * @param dir - the covers folder.
 * @param key - the cover key.
 */
export async function removeCoverFiles(dir: string, key: string): Promise<void> {
  for (const entry of await listCoverFiles(dir)) {
    if (entry.key === key) await rmWithRetry(entry.file, { force: true })
  }
  await rmWithRetry(join(dir, `${key}.${POSTER_NAME}`), { force: true })
}

/** What happened to an upload. */
export type CoverStoreResult =
  | { readonly ok: true; readonly file: string; readonly type: CoverType; readonly bytes: number }
  | { readonly ok: false; readonly status: number; readonly error: string }

/**
 * Save a key's cover, recognising its type from the content.
 *
 * The old file with the same key goes away before the write, so a video
 * replaces an image (and vice versa) without leaving the other on disk.
 * @param dir - the covers folder.
 * @param key - the key, already validated by the caller.
 * @param body - the bytes the request carried.
 * @returns what to answer: the stored file, or the reason it was refused.
 */
export async function storeCover(dir: string, key: string, body: Buffer): Promise<CoverStoreResult> {
  if (body.length === 0) return { ok: false, status: 400, error: message('cover.empty') }
  const type = coverTypeOfBytes(body)
  if (type === undefined) return { ok: false, status: 400, error: message('cover.notMedia') }
  await mkdir(dir, { recursive: true })
  await removeCoverFiles(dir, key)
  const file = join(dir, `${key}${type.ext}`)
  await writeFile(file, body)
  return { ok: true, file, type, bytes: body.length }
}
