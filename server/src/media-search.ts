/**
 * Search the media: the words of the History's files.
 *
 * Grok Imagine has search in `/imagine/saved` (`media_search_enabled`, and
 * `enable_imagine_search_index_on_demand` for the index). We only had the
 * pills — All, Liked, the tags — and file names are UUIDs: nothing could be
 * found by its words. The prompt a file was made with and the description the
 * vision pass wrote for it live in `data/comfy/notes/<name>.json`, one per
 * produced file, and no route read them all.
 *
 * The index is built on the first search and kept until the notes folder or
 * the media folder changes date. Every note is written by rename
 * (`writeFileAtomic` in `imagine-notes.ts`) or removed, so a rewritten note —
 * the «sight» arrives after the «origin» — moves the notes folder's date too;
 * until 2026-11-14 the index was also rebuilt every 60 seconds on the belief
 * that it did not. Notes of vanished files are left out (a deleted file must
 * not come back from a search): that is what the media folder's date is for.
 * Two searches that find the index old share one rebuild.
 *
 * A rebuild is incremental: each note's text is kept with the note's mtime and
 * size, and only a note that is new or changed is read and parsed again. Every
 * finished job moves the media folder (and adds a note), and until 2026-11-15
 * the next search re-read all the notes for it, some 1600 small files. When
 * only the media folder moved, the notes are not even listed again.
 * @module server/media-search
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { dataPath } from '../vendor/home-paths/index.ts'
import type { Handler } from './host.ts'
import { mediaNames } from './media-names.ts'
import { methods, sendJson } from './route-kit.ts'

/** Files an answer can name: the page draws them, `total` tells the rest. */
const MAX_HITS = 400
/** A query longer than this is a paragraph, not a search. */
const MAX_QUERY = 120
/** Notes read at a time: thousands of small files, without opening them all at once. */
const BATCH = 96

/** A note made searchable. */
interface Entry {
  readonly name: string
  readonly text: string
}

/** The index, and what it was built from. */
interface Index {
  readonly stamp: string
  readonly entries: readonly Entry[]
}

/** A note's text as last read, and the version of the note it came from. */
interface Known {
  /** `mtimeMs/size` of the note when it was read. */
  readonly version: string
  readonly text: string
}

/**
 * Lower case, no accents, single spaces: «Città» and «citta» both match.
 * @param value - the text to normalise.
 * @returns the normalised text.
 */
function plain(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The stem of a word, so singular and plural match.
 * «gatti» and «gatto» are searched as «gatt»: under five letters the word
 * stays whole, because cutting it would confuse too much.
 * @param word - an already normalised word.
 * @returns the stem to search for.
 */
function stem(word: string): string {
  return word.length >= 5 ? word.slice(0, -1) : word
}

/**
 * The searchable text of a note: the prompt, the requested changes, the
 * subject, the pose and what is seen. An unreadable note does not stop the
 * index: that file stays out of the search, like one without a note.
 * @param file - the note, with its path.
 * @returns the normalised text, empty when there is nothing to search.
 */
async function noteText(file: string): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as { origin?: Record<string, unknown>; sight?: unknown }
    const origin = raw.origin ?? {}
    const parts = [origin.prompt, origin.changes, origin.subject, origin.pose, raw.sight]
    const kept = parts.filter((part): part is string => typeof part === 'string' && part.length > 0)
    return plain(kept.join(' \n '))
  } catch {
    return ''
  }
}

/**
 * The notes folder as last listed: the note files in folder order, with the
 * version (`mtimeMs/size`) of each, and the folder's own mtime at that time.
 */
interface Listing {
  readonly mtime: number
  readonly notes: readonly { readonly file: string; readonly version: string }[]
}

/**
 * List the notes folder with each note's version, a `stat` per note in batches.
 * @param folder - the notes folder.
 * @param mtime - the folder's mtime, read before the listing.
 * @returns the listing; empty when the folder cannot be read.
 */
async function listNotes(folder: string, mtime: number): Promise<Listing> {
  const names = (await readdir(folder).catch(() => [] as string[]))
    .filter(name => name.endsWith('.json') && !name.startsWith('.'))
  const notes: { file: string; version: string }[] = []
  for (let at = 0; at < names.length; at += BATCH) {
    const slice = names.slice(at, at + BATCH)
    const infos = await Promise.all(slice.map(async file => await stat(join(folder, file)).catch(() => undefined)))
    slice.forEach((file, i) => {
      const info = infos[i]
      // A note removed between the listing and its stat is simply gone.
      if (info !== undefined) notes.push({ file, version: `${String(info.mtimeMs)}/${String(info.size)}` })
    })
  }
  return { mtime, notes }
}

/**
 * Build the index of the notes that still have their file, reading only the
 * notes `known` does not hold at their current version.
 * @param folder - the notes folder.
 * @param listing - the notes seen in the folder.
 * @param present - the names of the files the gallery really has.
 * @param known - the texts read before, by note file; updated in place, and
 *   pruned of the notes no longer listed.
 * @returns the entries with a text, in folder order.
 */
async function build(
  folder: string,
  listing: Listing,
  present: ReadonlySet<string>,
  known: Map<string, Known>,
): Promise<Entry[]> {
  const listed = new Set(listing.notes.map(note => note.file))
  for (const file of known.keys()) if (!listed.has(file)) known.delete(file)
  // Notes of vanished files are not read: a deleted file must not come back.
  const stale = listing.notes.filter(note => present.has(note.file.slice(0, -'.json'.length)) && known.get(note.file)?.version !== note.version)
  for (let at = 0; at < stale.length; at += BATCH) {
    const slice = stale.slice(at, at + BATCH)
    const texts = await Promise.all(slice.map(async note => await noteText(join(folder, note.file))))
    slice.forEach((note, i) => { known.set(note.file, { version: note.version, text: texts[i] ?? '' }) })
  }
  const entries: Entry[] = []
  for (const note of listing.notes) {
    const name = note.file.slice(0, -'.json'.length)
    const text = known.get(note.file)?.text ?? ''
    if (present.has(name) && text.length > 0) entries.push({ name, text })
  }
  return entries
}

/**
 * The search route (GET /api/media-search?q=…).
 * @param outputDir - the media folder, to know which files still exist.
 * @returns the route handler.
 */
export function createMediaSearchRoute(outputDir: string): Handler {
  const folder = dataPath('comfy', 'notes')
  let index: Promise<Index> | undefined
  // Kept across rebuilds; only touched by the one rebuild running at a time.
  const known = new Map<string, Known>()
  let listing: Listing | undefined

  const rebuild = async (stamp: string, notesMtime: number): Promise<Index> => {
    // The folder's mtime moves whenever a note is added, rewritten (by rename)
    // or removed: when it has not, the last listing and its versions still hold.
    if (listing?.mtime !== notesMtime) listing = await listNotes(folder, notesMtime)
    const present = await mediaNames(outputDir)
    return { stamp, entries: await build(folder, listing, present, known) }
  }

  const current = async (): Promise<Index> => {
    /*
     * The two folders' mtimes are the stamp, read before the rebuild: a note
     * written while it runs moves the date again, and the next search builds
     * once more. The folder is listed only for a rebuild, and the media names
     * come from the shared cached listing instead of a `readdir` of their own.
     */
    const [notesInfo, mediaInfo] = await Promise.all([stat(folder), stat(outputDir)].map(info => info.catch(() => undefined)))
    const stamp = `${String(notesInfo?.mtimeMs ?? 0)}/${String(mediaInfo?.mtimeMs ?? 0)}`
    const known = index
    if (known !== undefined && (await known.catch(() => undefined))?.stamp === stamp) return await known
    // The promise, not its value, is what is kept: a second search arriving
    // during the rebuild waits for this one instead of starting its own.
    if (index !== known) return await (index as Promise<Index>)
    const building = rebuild(stamp, notesInfo?.mtimeMs ?? 0)
    index = building
    building.catch(() => {
      if (index === building) index = undefined
      // A failed rebuild may have left the listing half-trusted: list again next time.
      listing = undefined
    })
    return await building
  }

  return methods({
    GET: async (req, res) => {
      const started = Date.now()
      const asked = plain((new URL(req.url ?? '/', 'http://x').searchParams.get('q') ?? '').slice(0, MAX_QUERY))
      const built = await current()
      const words = asked.split(' ').filter(word => word.length > 0).map(stem)
      const hits = words.length === 0
        ? []
        : built.entries.filter(entry => words.every(word => entry.text.includes(word)))
      sendJson(res, 200, {
        query: asked,
        names: hits.slice(0, MAX_HITS).map(entry => entry.name),
        total: hits.length,
        indexed: built.entries.length,
        tookMs: Date.now() - started,
      })
    },
  })
}
