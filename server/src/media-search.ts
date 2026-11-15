/**
 * «Cerca nei media» (search the media): the words of the History's files.
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
 * Build the index of the notes that still have their file.
 * @param folder - the notes folder.
 * @param names - the notes seen in the folder.
 * @param present - the names of the files the gallery really has.
 * @returns the entries with a text, in folder order.
 */
async function build(folder: string, names: readonly string[], present: ReadonlySet<string>): Promise<Entry[]> {
  const entries: Entry[] = []
  for (let at = 0; at < names.length; at += BATCH) {
    const slice = names.slice(at, at + BATCH)
    const read = await Promise.all(slice.map(async (file) => {
      const name = file.slice(0, -'.json'.length)
      if (!present.has(name)) return undefined
      const text = await noteText(join(folder, file))
      return text.length === 0 ? undefined : { name, text }
    }))
    for (const entry of read) if (entry !== undefined) entries.push(entry)
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

  const rebuild = async (stamp: string): Promise<Index> => {
    const names = await readdir(folder).catch(() => [] as string[])
    const present = await mediaNames(outputDir)
    const notes = names.filter(name => name.endsWith('.json') && !name.startsWith('.'))
    return { stamp, entries: await build(folder, notes, present) }
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
    const building = rebuild(stamp)
    index = building
    building.catch(() => { if (index === building) index = undefined })
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
