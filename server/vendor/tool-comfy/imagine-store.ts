/**
 * Shared Imagine studio state: projects and canvas positions, stored next
 * to the Comfy home so every browser sees the same rail.
 * @module tool-comfy/imagine-store
 */

import { readFile, rename, stat } from 'node:fs/promises'
import { serialized, writeFileAtomic } from '../atomic-write/index.ts'
import { dataPath } from '../home-paths/index.ts'
import { kindOf, safeBasename } from './gallery.ts'
import { finite } from './guards.ts'
import { MEDIA_KINDS, type MediaFileRef, type MediaKind } from '../../../shared/imagine-types.ts'
import {
  HISTORY_PROJECT_ID, MAX_THINKING_CHARS, type CanvasNote, type CanvasRect, type ImagineMessage, type ImagineProject, type ImagineRemovals,
} from '../../../shared/imagine-projects.ts'

/**
 * Every key of `T` named in `K`, or a compile error listing the ones left out.
 *
 * The sanitizers below keep only the fields they copy, so a field added to a
 * shared type and not here was dropped at the next save without a word — how
 * the chat's `thinking` vanished after every reload until 2026-10-25.
 */
type Covers<T, K extends keyof T> = [Exclude<keyof T, K>] extends [never] ? true : { readonly missing: Exclude<keyof T, K> }

const PROJECT_FIELDS: Covers<ImagineProject,
  'id' | 'title' | 'createdAt' | 'itemNames' | 'jobIds' | 'messages' | 'seedPrompt' | 'pinned' | 'cover' | 'autoTitle'
  | 'notes'> = true
const MESSAGE_FIELDS: Covers<ImagineMessage, 'id' | 'role' | 'text' | 'createdAt' | 'jobId' | 'files' | 'thinking' | 'jobIds'> = true
const NOTE_FIELDS: Covers<CanvasNote, 'id' | 'text' | 'x' | 'y' | 'w' | 'size' | 'color' | 'align'> = true
const RECT_FIELDS: Covers<CanvasRect, 'id' | 'x' | 'y' | 'w' | 'h' | 'scale'> = true
void [PROJECT_FIELDS, MESSAGE_FIELDS, NOTE_FIELDS, RECT_FIELDS]

function sanitizeNotes(value: unknown): CanvasNote[] {
  if (!Array.isArray(value)) return []
  // `finite` from ./guards.ts: same test, one copy.
  return value.slice(0, 200).flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const note = entry as Record<string, unknown>
    if (typeof note.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(note.id) || typeof note.text !== 'string') return []
    const x = finite(note.x)
    const y = finite(note.y)
    const w = finite(note.w)
    const size = finite(note.size)
    if (x === undefined || y === undefined || w === undefined || size === undefined) return []
    return [{
      id: note.id,
      text: note.text.slice(0, 4000),
      x,
      y,
      w: Math.min(4000, Math.max(60, w)),
      size: Math.min(160, Math.max(8, size)),
      ...typeof note.color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(note.color) ? { color: note.color } : {},
      ...note.align === 'center' || note.align === 'right' || note.align === 'left' ? { align: note.align } : {},
    }]
  })
}

/** File contents written under `<data home>/comfy/imagine.json`. */
interface ImagineStore {
  readonly projects: readonly ImagineProject[]
  readonly placed: Readonly<Record<string, CanvasRect>>
  /**
   * Projects a client deleted, by id, with the epoch millisecond it happened.
   * Shared like the projects themselves: without it a second browser would
   * merge its stale copy back in and undo the delete.
   */
  readonly deleted: Readonly<Record<string, number>>
  /**
   * Files and jobs taken out of a project, by project id, with when.
   *
   * Shared for the same reason as `deleted`: a project is merged by richness,
   * so a browser holding a stale copy would put a removed file straight back.
   * This is what made a deleted music video's photos, song and shots reappear
   * in six other projects — every project opened while that chain ran had
   * adopted its jobs, and no copy of the rail could be poorer than another's.
   */
  readonly removed: Readonly<Record<string, Readonly<Record<string, number>>>>
  /**
   * Jobs and files the host itself put into a project, by project id, with
   * when. A key with a media extension is a file, any other is a job id.
   *
   * A music video is queued in waves, minutes apart, and the browser that
   * asked for it adopted each wave as it appeared — until the page was
   * reloaded, when the thread it was following was gone and the song and the
   * shots ran on with no project to show them. The host knows the project
   * (the form names it) and the jobs (it queued them), so it records the
   * adoption here and every copy of the rail folds it in. The files follow
   * for the same reason: a browser folds a finished job's files into the
   * project only while that job is still in memory, and a video that takes
   * an hour finishes long after the browser that asked for it has gone.
   */
  readonly adopted: Readonly<Record<string, Readonly<Record<string, number>>>>
  /**
   * Files renamed on disk, old name to new.
   *
   * A rail that still lists the old name is as rich as one with the new, and
   * a tie goes to the browser's own copy: the shots renamed by number stayed
   * `create_video-…` on the user's screen, pointing at files that were gone.
   */
  readonly renamed: Readonly<Record<string, string>>
}

const EMPTY: ImagineStore = { projects: [], placed: {}, deleted: {}, removed: {}, adopted: {}, renamed: {} }

/**
 * The store as last read or written by this process, and the file it came
 * from (inode, size, mtime). Every writer replaces the file atomically, so a
 * write from anywhere — another process, a hand edit — shows as a new stamp
 * and is read again. `json` is the same store serialized, filled on the first
 * request that wants it, so a poll does not stringify ~600 KB each time.
 */
let cached: { readonly stamp: string; readonly store: ImagineStore; json?: string } | undefined

function stampOf(info: { ino: number; size: number; mtimeMs: number }): string {
  return `${String(info.ino)}:${String(info.size)}:${String(info.mtimeMs)}`
}

/**
 * Path of the shared Imagine studio file.
 * @returns an absolute path under the data home.
 */
function imagineStorePath(): string {
  return dataPath('comfy', 'imagine.json')
}

/**
 * Load the shared Imagine studio, or an empty store when the file is missing
 * or unreadable.
 * @returns the sanitized store.
 */
export async function loadImagineStore(): Promise<ImagineStore> {
  let raw: string
  let stamp: string
  try {
    stamp = stampOf(await stat(imagineStorePath()))
    // The file is ~600 KB: re-reading and re-sanitizing it on every GET and
    // every write was most of what the rail cost the host.
    if (cached?.stamp === stamp) return cached.store
    raw = await readFile(imagineStorePath(), 'utf8')
  } catch (error: unknown) {
    // Missing is the ordinary first-run case and stays silent; a permission or
    // I/O error is a real failure that would otherwise present as an empty
    // rail, so it is named rather than swallowed.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[imagine] impossibile leggere ${imagineStorePath()}: ${String(error)}`)
    }
    return EMPTY
  }
  try {
    const store = sanitizeStore(JSON.parse(raw) as unknown)
    cached = { stamp, store }
    return store
  } catch (error: unknown) {
    /*
     * Corrupt JSON: the studio still loads on an empty store, but a silent one
     * reads as "the whole rail vanished", so the file and the fault are named.
     * The file is moved aside first: left in place, the next save wrote the
     * empty store over it and every project was gone for good. Writes are
     * atomic, so a file that does not parse was not caught halfway.
     */
    const aside = `${imagineStorePath()}.corrupt-${String(Date.now())}`
    await rename(imagineStorePath(), aside).catch(() => undefined)
    console.error(`[imagine] ${imagineStorePath()} illeggibile, spostato in ${aside}; uso uno store vuoto: ${String(error)}`)
    return EMPTY
  }
}

/**
 * The shared Imagine studio as JSON text, for a route that sends it as is.
 *
 * Serialized once per version of the file rather than on every GET.
 * @returns the same store {@link loadImagineStore} answers, as JSON.
 */
export async function loadImagineStoreJson(): Promise<string> {
  const store = await loadImagineStore()
  const current = cached
  if (current?.store !== store) return JSON.stringify(store)
  current.json ??= JSON.stringify(store)
  return current.json
}

/**
 * Replace the shared Imagine studio.
 *
 * Neither projects nor tombstones are ever dropped on someone else's behalf. A
 * client sends the rail it knows about, which is a snapshot from whenever it
 * last loaded; a second browser that saves after it must not take the first
 * one's projects down with it. So a project on disk survives a payload that
 * omits it, and only its tombstone removes it. Tombstones accumulate for the
 * same reason: a client that does not send them — an older bundle, or a tab
 * that loaded before the field existed — must not resurrect every deleted
 * project on its next save.
 *
 * Writes are queued one at a time and land atomically, so a crash or an
 * overlapping save cannot leave a half-written `imagine.json`, which
 * `loadImagineStore` would read as an empty store.
 *
 * The payload may therefore be PARTIAL, and a client that saves only what
 * changed relies on this contract (`mergeStore`):
 * - `projects`: only the projects it names are replaced, each by the copy it
 *   sends, which must be the whole project (title, messages, notes…: a field
 *   left out of a named project is gone). Their `itemNames`/`jobIds` still
 *   keep what only the disk copy lists. A project it does not name is kept
 *   as stored; a missing `projects` names none.
 * - `placed`: merged key by key, so only the tiles it sends move; a tile it
 *   leaves out keeps its rect. A position is dropped only through `unplaced`.
 * - `deleted`, `removed`, `adopted`, `renamed`: unions with what the disk
 *   already carries — a payload can add to them and never take one away, so
 *   leaving them out is safe.
 * @param value - the incoming payload, whole or partial.
 * @returns the sanitized store that was written.
 */
export async function saveImagineStore(value: unknown): Promise<ImagineStore> {
  const unplaced = sanitizeUnplaced(value)
  return lockedWrite(previous => mergeIncoming(previous, value, unplaced))
}

/**
 * Fold an untrusted payload onto the store on disk, carrying every tombstone,
 * removal, adoption and rename the disk already has.
 * @param previous - the store on disk.
 * @param value - the payload, whole or one field of it.
 * @param unplaced - tile ids the payload asks to forget the position of.
 * @returns the store to write.
 */
function mergeIncoming(previous: ImagineStore, value: unknown, unplaced?: readonly string[]): ImagineStore {
  return mergeStore(
    previous,
    sanitizeStore(value, previous.deleted, previous.removed, previous.adopted, previous.renamed),
    unplaced,
  )
}

/**
 * Record that files were renamed on disk, so every copy of the rail follows.
 * @param renames - old basename to new basename.
 * @returns the store as written.
 */
export async function renameInProjects(renames: Readonly<Record<string, string>>): Promise<ImagineStore> {
  return lockedWrite(previous => Object.entries(renames).every(([from, to]) => previous.renamed[from] === to)
    ? previous
    : mergeIncoming(previous, { renamed: renames }))
}

/**
 * Put jobs into one or more projects, durably, in one write.
 *
 * Recorded rather than written into the project: the project may not have
 * reached the store yet (a browser creates it and saves later), and a save
 * from a browser that never heard of these jobs must not drop them.
 * @param projectIds - the projects the jobs belong to.
 * @param jobIds - the jobs to put in them.
 * @returns the store as written.
 */
export async function adoptJobsInto(projectIds: readonly string[], jobIds: readonly string[]): Promise<ImagineStore> {
  const at = Date.now()
  const jobs = Object.fromEntries(jobIds.map(jobId => [jobId, at]))
  const adopted = Object.fromEntries(projectIds.map(projectId => [projectId, jobs]))
  return lockedWrite(previous => alreadyAdopted(previous, projectIds, jobIds)
    ? previous
    : mergeIncoming(previous, { adopted }))
}

/**
 * Whether every key is already adopted into every project, so a write would
 * only rewrite the same ~600 KB: an adoption keeps its earliest time.
 */
function alreadyAdopted(store: ImagineStore, projectIds: Iterable<string>, keys: readonly string[]): boolean {
  for (const projectId of projectIds) {
    const mine = store.adopted[projectId]
    if (mine === undefined || keys.some(key => mine[key] === undefined)) return false
  }
  return true
}

/**
 * Put a finished job's files into every project that holds the job, durably.
 *
 * The browser does this fold itself, but only for a job it can still see:
 * jobs live thirty minutes in memory, and a montage's last shot lands hours
 * after the browser that queued it closed. A project that lists the job, or
 * that the host adopted it into, gets the files; a project the job was
 * removed from does not.
 * @param jobId - the finished job.
 * @param names - the basenames it produced.
 * @returns the store as written.
 */
export async function adoptJobFiles(jobId: string, names: readonly string[]): Promise<ImagineStore> {
  const at = Date.now()
  return lockedWrite((previous) => {
    const owners = new Set([
      ...previous.projects.filter(project => project.jobIds.includes(jobId)).map(project => project.id),
      ...Object.keys(previous.adopted).filter(projectId => previous.adopted[projectId]?.[jobId] !== undefined),
    ].filter(projectId => previous.removed[projectId]?.[jobId] === undefined && previous.deleted[projectId] === undefined))
    if (owners.size === 0 || names.length === 0 || alreadyAdopted(previous, owners, names)) return previous
    const files = Object.fromEntries(names.map(name => [name, at]))
    const adopted = Object.fromEntries([...owners].map(projectId => [projectId, files]))
    return mergeIncoming(previous, { adopted })
  })
}

/**
 * Tile ids a payload asks to forget the position of.
 *
 * `placed` merges key by key so that a client saving a stale copy cannot drop
 * another browser's tiles. That also meant no client could ever remove one:
 * "Disponi in griglia" cleared the positions locally, saved a payload that
 * merely omitted them, and read them all back on the next load. Removal has to
 * be said out loud, and this is where it is said.
 * @param value - the untrusted payload.
 * @returns the ids to drop, deduplicated.
 */
function sanitizeUnplaced(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null) return []
  const raw = (value as { unplaced?: unknown }).unplaced
  if (!Array.isArray(raw)) return []
  const out = new Set<string>()
  for (const id of raw) {
    if (typeof id !== 'string' || id.length === 0 || id.includes('/')) continue
    out.add(id)
  }
  return [...out]
}

/**
 * Run one read-modify-write against `imagine.json` under the writer lock.
 *
 * Both writers go through here: a canvas position dropped by a media delete
 * used to race the studio PUT, and each would write back a store read before
 * the other's change. The queue is in memory (`serialized`): no other process
 * writes the store. The atomic
 * replacement means a reader sees the old file or the new one, never a
 * truncated one that parses as an empty store.
 * @param edit - produces the store to write from the one on disk.
 * @returns the store as written.
 */
async function lockedWrite(edit: (previous: ImagineStore) => ImagineStore): Promise<ImagineStore> {
  const path = imagineStorePath()
  return serialized(path, async () => {
    const previous = await loadImagineStore()
    const store = edit(previous)
    // An edit that changed nothing (a forget of a tile that was not placed,
    // files of a job no project holds) does not rewrite 600 KB.
    if (store === previous) return store
    const json = JSON.stringify(store)
    await writeFileAtomic(path, `${json}\n`, { mode: 0o600, dirMode: 0o700 })
    cached = { stamp: stampOf(await stat(path)), store, json }
    return store
  })
}

/**
 * Fold an incoming store onto the one on disk, keeping every project either
 * side knows about unless a tombstone removes it.
 * @param previous - the store currently on disk.
 * @param incoming - the sanitized payload, already carrying both tombstone sets.
 * @param unplaced - tile ids the payload asks to forget the position of.
 * @returns the store to write.
 */
function mergeStore(
  previous: ImagineStore,
  incoming: ImagineStore,
  unplaced: readonly string[] = [],
): ImagineStore {
  const sent = new Set(incoming.projects.map(project => project.id))
  const onDisk = new Map(previous.projects.map(project => [project.id, project]))
  // The payload is the newer copy of everything it names, so it wins there —
  // except for the files and jobs only the disk copy lists; anything only on
  // disk is a project this client had not heard of yet.
  const projects = incoming.projects.map(project =>
    withDiskContent(project, onDisk.get(project.id), incoming.removed, incoming.renamed))
  const kept = previous.projects
    .filter(project => !sent.has(project.id) && incoming.deleted[project.id] === undefined)
    .map(project => withSharedEdits(project, incoming.removed, incoming.adopted, incoming.renamed))
  // A tile named by both sides is being re-placed, not dropped: the incoming
  // rect wins and the removal is ignored, so a regrid racing a drag cannot
  // undo the drag.
  const dropped = new Set(unplaced.filter(id => incoming.placed[id] === undefined))
  const placed: Record<string, CanvasRect> = {}
  for (const [id, rect] of Object.entries({ ...previous.placed, ...incoming.placed })) {
    if (dropped.has(id)) continue
    // A tile follows its file's new name, and keeps its place.
    const name = incoming.renamed[id] ?? id
    placed[name] = { ...rect, id: name }
  }
  return {
    projects: [...projects, ...kept],
    placed,
    deleted: incoming.deleted,
    removed: incoming.removed,
    adopted: incoming.adopted,
    renamed: incoming.renamed,
  }
}

/**
 * A sent project plus the files and jobs its disk copy lists and it does not.
 *
 * Browsers only ever append to a project's lists; taking something out is a
 * shared removal. A list shorter than the disk's therefore comes from a copy
 * read before another writer — the assistant, another browser — added to it,
 * and saving it as it stands dropped that work off the board mid-run.
 * @param sent - the project as the payload carries it.
 * @param disk - the same project as stored, when it is.
 * @param removed - every project's removals, which still win.
 * @param renamed - files renamed on disk, old name to new.
 * @returns the sent project when the disk copy adds nothing, otherwise a copy.
 */
function withDiskContent(
  sent: ImagineProject,
  disk: ImagineProject | undefined,
  removed: ImagineRemovals,
  renamed: Readonly<Record<string, string>>,
): ImagineProject {
  if (disk === undefined || sent.id === HISTORY_PROJECT_ID) return sent
  const gone = removed[sent.id] ?? {}
  // Sets, not `includes`: the history project lists thousands of names.
  const sentJobs = new Set(sent.jobIds)
  const jobIds = disk.jobIds.filter(jobId => !sentJobs.has(jobId) && gone[jobId] === undefined)
  const seen = new Set(sent.itemNames)
  const itemNames: string[] = []
  for (const original of disk.itemNames) {
    const name = renamed[original] ?? original
    if (seen.has(name) || gone[name] !== undefined) continue
    seen.add(name)
    itemNames.push(name)
  }
  if (jobIds.length === 0 && itemNames.length === 0) return sent
  return { ...sent, itemNames: [...sent.itemNames, ...itemNames], jobIds: [...sent.jobIds, ...jobIds] }
}

/**
 * A project with the jobs and files the host adopted into it and without the
 * files and jobs its removals name. A removal outranks an adoption of the
 * same job or file.
 * @param project - the project as sent or as stored.
 * @param removed - every project's removals.
 * @param adopted - every project's host-side adoptions, jobs and files.
 * @param renamed - files renamed on disk, old name to new.
 * @returns the same project when nothing applies, otherwise a copy.
 */
function withSharedEdits(
  project: ImagineProject,
  removed: ImagineRemovals,
  adopted: ImagineRemovals = {},
  renamed: Readonly<Record<string, string>> = {},
): ImagineProject {
  const gone = removed[project.id] ?? {}
  const mine = Object.keys(adopted[project.id] ?? {})
  const adoptedJobs = mine.filter(key => kindOf(key) === undefined)
  const adoptedFiles = mine.filter(key => kindOf(key) !== undefined)
  const listedJobs = new Set(project.jobIds)
  const jobIds = [...project.jobIds, ...adoptedJobs.filter(jobId => !listedJobs.has(jobId))]
    .filter(jobId => gone[jobId] === undefined)
  // A Set beside the list: the history project holds thousands of names, and
  // `includes` here ran on every load and every write.
  const itemNames: string[] = []
  const listed = new Set<string>()
  for (const name of [...project.itemNames, ...adoptedFiles]) {
    const current = renamed[name] ?? name
    if (gone[current] === undefined && gone[name] === undefined && !listed.has(current)) {
      listed.add(current)
      itemNames.push(current)
    }
  }
  const same = itemNames.length === project.itemNames.length
    && itemNames.every((name, index) => name === project.itemNames[index])
    && jobIds.length === project.jobIds.length
    && jobIds.every((jobId, index) => jobId === project.jobIds[index])
  return same ? project : { ...project, itemNames, jobIds }
}

/**
 * Drop anything that is not a project list plus canvas positions.
 * @param value - untrusted JSON.
 * @param carried - tombstones already on disk, which a payload can add to but
 *   never drop.
 * @returns a safe store.
 */
function sanitizeStore(
  value: unknown,
  carried: Readonly<Record<string, number>> = {},
  carriedRemovals: ImagineRemovals = {},
  carriedAdoptions: ImagineRemovals = {},
  carriedRenames: Readonly<Record<string, string>> = {},
): ImagineStore {
  if (typeof value !== 'object' || value === null) {
    return Object.keys(carried).length === 0 && Object.keys(carriedRemovals).length === 0
      && Object.keys(carriedAdoptions).length === 0 && Object.keys(carriedRenames).length === 0
      ? EMPTY
      : {
        ...EMPTY,
        deleted: { ...carried },
        removed: { ...carriedRemovals },
        adopted: { ...carriedAdoptions },
        renamed: { ...carriedRenames },
      }
  }
  const record = value as {
    projects?: unknown
    placed?: unknown
    deleted?: unknown
    removed?: unknown
    adopted?: unknown
    renamed?: unknown
  }
  const deleted = capTombstones({ ...carried, ...sanitizeDeleted(record.deleted) })
  const removed = forProjectsAlive(mergeRemovals(carriedRemovals, sanitizeRemoved(record.removed)), deleted)
  const adopted = forProjectsAlive(mergeRemovals(carriedAdoptions, sanitizeRemoved(record.adopted)), deleted)
  const renamed = capRenames({ ...carriedRenames, ...sanitizeRenamed(record.renamed) })
  return {
    projects: Array.isArray(record.projects)
      ? record.projects.flatMap((project) => {
        const next = sanitizeProject(project)
        // A tombstone outranks the project it names: an old client that still
        // sends the deleted project must not be able to restore it. A removal
        // outranks the file or job it names, for the same reason.
        return next === undefined || deleted[next.id] !== undefined
          ? []
          : [withSharedEdits(next, removed, adopted, renamed)]
      })
      : [],
    placed: sanitizePlaced(record.placed),
    deleted,
    removed,
    adopted,
    renamed,
  }
}

/**
 * How many projects the removals and the adoptions keep an entry for. Each
 * entry is capped on its own ({@link MAX_REMOVALS}); this bounds how many
 * there are, the projects last touched kept first.
 */
const MAX_PROJECT_ENTRIES = 1000

/**
 * The removals or adoptions of the projects still alive, at most
 * {@link MAX_PROJECT_ENTRIES}.
 *
 * A deleted project's entry only grew the file: its tombstone already keeps
 * the project, and with it every file and job it held, off every rail.
 * @param sets - removals or adoptions, by project id.
 * @param deleted - the tombstones.
 * @returns the same object when nothing is dropped, otherwise a copy.
 */
function forProjectsAlive(sets: ImagineRemovals, deleted: Readonly<Record<string, number>>): ImagineRemovals {
  const alive = Object.entries(sets).filter(([projectId]) => deleted[projectId] === undefined)
  if (alive.length > MAX_PROJECT_ENTRIES) {
    const latest = (keys: Readonly<Record<string, number>>): number => Math.max(0, ...Object.values(keys))
    alive.sort(([, a], [, b]) => latest(b) - latest(a))
    alive.length = MAX_PROJECT_ENTRIES
  }
  return alive.length === Object.keys(sets).length ? sets : Object.fromEntries(alive)
}

/** Ceiling on renames kept; the oldest go first past it, by insertion. */
const MAX_RENAMES = 2000

/** Keep the most recent renames, up to the ceiling. */
function capRenames(renamed: Record<string, string>): Record<string, string> {
  const entries = Object.entries(renamed)
  return entries.length <= MAX_RENAMES ? renamed : Object.fromEntries(entries.slice(entries.length - MAX_RENAMES))
}

/**
 * Keep only `old basename -> new basename` from an untrusted map.
 * @param value - untrusted JSON.
 * @returns the safe renames.
 */
function sanitizeRenamed(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, string> = {}
  for (const [from, to] of Object.entries(value as Record<string, unknown>)) {
    if (typeof to !== 'string' || from === to) continue
    if (safeBasename(from) === undefined || safeBasename(to) === undefined) continue
    out[from] = to
  }
  return out
}

/** Ceiling on removals kept per project; the oldest go first past it. */
const MAX_REMOVALS = 1000

/**
 * Union two removal sets, keeping the earliest time for each key.
 * @param carried - what is on disk.
 * @param incoming - what the payload adds.
 * @returns every removal either side knows.
 */
function mergeRemovals(carried: ImagineRemovals, incoming: ImagineRemovals): ImagineRemovals {
  const out: Record<string, Record<string, number>> = {}
  for (const source of [carried, incoming]) {
    for (const [projectId, keys] of Object.entries(source)) {
      const mine = out[projectId] ?? {}
      for (const [key, at] of Object.entries(keys)) {
        const previous = mine[key]
        mine[key] = previous === undefined ? at : Math.min(previous, at)
      }
      out[projectId] = mine
    }
  }
  for (const [projectId, keys] of Object.entries(out)) out[projectId] = capTombstones(keys, MAX_REMOVALS)
  return out
}

/**
 * Keep only `projectId -> { key -> epoch ms }` from an untrusted removal map.
 * @param value - untrusted JSON.
 * @returns the safe removals.
 */
function sanitizeRemoved(value: unknown): ImagineRemovals {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, Record<string, number>> = {}
  for (const [projectId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (projectId.length === 0 || projectId.includes('/')) continue
    const keys = sanitizeDeleted(raw)
    if (Object.keys(keys).length > 0) out[projectId] = keys
  }
  return out
}

/**
 * How many tombstones the store carries.
 *
 * Bounded by count rather than by age on purpose: a tombstone is the only
 * thing stopping a browser that has not opened Imagine in months from merging
 * its stale rail back in, so expiring one on a clock would resurrect deleted
 * projects. A ceiling this far above any real rail bounds the growth without
 * ever reaching a copy a live client could still hold.
 */
const MAX_TOMBSTONES = 1000

/**
 * Keep the most recent tombstones, up to the ceiling.
 * @param deleted - the accumulated tombstones.
 * @returns at most MAX_TOMBSTONES entries, newest first.
 */
function capTombstones(deleted: Record<string, number>, ceiling = MAX_TOMBSTONES): Record<string, number> {
  const entries = Object.entries(deleted)
  if (entries.length <= ceiling) return deleted
  entries.sort(([, a], [, b]) => b - a)
  return Object.fromEntries(entries.slice(0, ceiling))
}

/**
 * Drop one canvas position, for a tile whose file no longer exists.
 * @param name - the deleted gallery basename.
 * @returns the store as written.
 */
export async function forgetPlacedItem(name: string): Promise<ImagineStore> {
  return lockedWrite((store) => {
    if (store.placed[name] === undefined) return store
    const placed = Object.fromEntries(
      Object.entries(store.placed).filter(([key]) => key !== name))
    return { ...store, placed }
  })
}

/**
 * Keep only `id -> epoch ms` pairs from an untrusted tombstone map.
 * @param value - untrusted JSON.
 * @returns the safe tombstones.
 */
function sanitizeDeleted(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, number> = {}
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (id.length === 0 || id.includes('/')) continue
    const at = finite(raw)
    if (at !== undefined && at >= 0) out[id] = at
  }
  return out
}

function sanitizeProject(value: unknown): ImagineProject | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' && record.id.length > 0 && !record.id.includes('/') ? record.id : undefined
  const title = typeof record.title === 'string' ? record.title.trim().slice(0, 80) : ''
  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : 0
  if (id === undefined || title.length === 0) return undefined
  const itemNames = Array.isArray(record.itemNames)
    ? record.itemNames.filter((name): name is string => typeof name === 'string' && safeBasename(name) !== undefined)
    : []
  const jobIds = Array.isArray(record.jobIds)
    ? record.jobIds.filter((jobId): jobId is string => typeof jobId === 'string' && jobId.length > 0)
    : []
  const messages = Array.isArray(record.messages)
    ? record.messages.flatMap((message) => {
      const next = sanitizeMessage(message)
      return next === undefined ? [] : [next]
    })
    : []
  return {
    id,
    title,
    createdAt,
    itemNames,
    jobIds,
    messages,
    ...typeof record.seedPrompt === 'string' ? { seedPrompt: record.seedPrompt.slice(0, 4000) } : {},
    ...record.pinned === true ? { pinned: true } : {},
    ...typeof record.cover === 'string' && /^[A-Za-z0-9._-]{1,160}$/.test(record.cover) ? { cover: record.cover } : {},
    ...record.autoTitle === true ? { autoTitle: true } : {},
    ...Array.isArray(record.notes) && record.notes.length > 0 ? { notes: sanitizeNotes(record.notes) } : {},
  }
}

function sanitizeMessage(value: unknown): ImagineMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id.length === 0) return undefined
  // `assistant` is the studio's own line in the written lane. It was not in
  // this list when the column only echoed jobs, and every answer the studio
  // gave was dropped on the next save with nothing said about it.
  if (record.role !== 'user' && record.role !== 'assistant' && record.role !== 'status') return undefined
  if (typeof record.text !== 'string') return undefined
  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : 0
  const files = sanitizeFiles(record.files)
  return {
    id: record.id,
    role: record.role,
    text: record.text.slice(0, 8000),
    createdAt,
    ...typeof record.jobId === 'string' ? { jobId: record.jobId } : {},
    /*
     * The runs an assistant line queued, so the column can draw their results
     * under the prose (2026-11-04). Bounded like every other list a browser
     * writes: a line cannot claim a thousand jobs.
     */
    ...Array.isArray(record.jobIds)
      ? { jobIds: [...new Set(record.jobIds.filter((id): id is string => typeof id === 'string' && id.length > 0))].slice(0, MAX_MESSAGE_JOB_IDS) }
      : {},
    ...files.length === 0 ? {} : { files },
    // The answer's folded reasoning (the page writes it since 2026-09-10).
    ...typeof record.thinking === 'string' && record.thinking.trim().length > 0
      ? { thinking: record.thinking.slice(0, MAX_THINKING_CHARS) }
      : {},
  }
}

/** The kinds a message may carry a file of. */
const FILE_KINDS: ReadonlySet<string> = new Set(MEDIA_KINDS)

/** How many files one line may be shown with. */
const MAX_MESSAGE_FILES = 60

/** How many runs one assistant line may claim as its own. */
const MAX_MESSAGE_JOB_IDS = 24

/** The files a stored line was sent with, dropping anything else. */
function sanitizeFiles(value: unknown): MediaFileRef[] {
  if (!Array.isArray(value)) return []
  const out: MediaFileRef[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record.name !== 'string' || record.name.length === 0 || record.name.length > 200) continue
    if (typeof record.kind !== 'string' || !FILE_KINDS.has(record.kind)) continue
    out.push({ name: record.name, kind: record.kind as MediaKind })
    if (out.length >= MAX_MESSAGE_FILES) break
  }
  return out
}

function sanitizePlaced(value: unknown): Record<string, CanvasRect> {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, CanvasRect> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : key
    const x = finite(record.x)
    const y = finite(record.y)
    const w = finite(record.w)
    const h = finite(record.h)
    if (id.length === 0 || x === undefined || y === undefined || w === undefined || h === undefined) continue
    const scale = finite(record.scale)
    out[id] = { id, x, y, w, h, ...scale !== undefined && scale !== 1 ? { scale: Math.min(3, Math.max(0.75, scale)) } : {} }
  }
  return out
}
