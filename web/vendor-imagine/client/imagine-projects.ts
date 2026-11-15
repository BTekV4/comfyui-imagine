/**
 * Pure helpers for Imagine projects: ids, titles, and attaching finished
 * job files to the project that started them.
 * @module imagine-projects
 */

import type { ImagineJobView as ImagineJob } from '../../../shared/imagine-types.ts'
import {
  HISTORY_PROJECT_ID, SEED_MESSAGE_PREFIX, type CanvasRect, type ImagineMessage, type ImagineProject, type ImagineRemovals,
} from '../../../shared/imagine-projects.ts'

export { SEED_MESSAGE_PREFIX }

/**
 * Whether a stored tile position is the same place and size as another: the
 * store skips a rect it already holds, and a save sends only the rects that
 * moved. One comparison for both, which used to be written out twice.
 * @param a - the stored rect, if any.
 * @param b - the rect to compare with.
 * @returns true when both exist and nothing differs.
 */
export function sameRect(a: CanvasRect | undefined, b: CanvasRect): boolean {
  return a !== undefined && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.scale === b.scale
}

/**
 * Whether two lists hold the same entries, by identity, in the same order: a
 * project's file names, a rail, a selection.
 * @param a - one list.
 * @param b - the other.
 * @returns true when nothing differs.
 */
export function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index])
}

/**
 * Whether a message is the seed line: the project's own title, there so the
 * rail lists the project before anything is said in it.
 * @param message - a project message.
 * @returns true for the seed line.
 */
export function isSeedMessage(message: { readonly id: string }): boolean {
  return message.id.startsWith(SEED_MESSAGE_PREFIX)
}

/**
 * Ids of projects the user deleted, and when. A delete has to be recorded, not
 * merely inferred from a project's absence: the rail is merged with a shared
 * copy on the server, and an absence loses that merge every time.
 */
export type ImagineTombstones = Readonly<Record<string, number>>

/**
 * How many tombstones are kept: the same ceiling as the host's
 * (`MAX_TOMBSTONES` in server/vendor/tool-comfy/imagine-store.ts).
 *
 * Bounded by count, not by age, as the host is. Until 2026-11-15 this side
 * forgot a tombstone after 30 days, which is the very thing the host's rule
 * avoids: a browser whose saved rail still held a project deleted longer ago
 * merged it back in and saved it again. A thousand ids are a few KB.
 */
const MAX_TOMBSTONES = 1000

const TITLE_MAX = 36

/**
 * Mint a project id. Browser and Node both provide `Math.random`.
 * @returns a short unique id.
 */
function newProjectId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Turn a prompt or template title into a rail label.
 * @param text - the source string.
 * @returns a trimmed, length-capped title, or undefined when empty.
 */
export function titleFromPrompt(text: string): string | undefined {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length === 0) return undefined
  if (compact.length <= TITLE_MAX) return compact
  return `${compact.slice(0, TITLE_MAX - 1).trimEnd()}…`
}

/**
 * Build a new empty project.
 * @param title - rail label.
 * @param autoTitle - whether the title is still the studio's own placeholder
 * and the first content may replace it with a name from the reading model.
 * @returns the project record.
 */
export function createProject(title: string, autoTitle?: boolean): ImagineProject {
  return {
    id: newProjectId(),
    title,
    createdAt: Date.now(),
    itemNames: [],
    jobIds: [],
    messages: [],
    ...autoTitle === undefined ? {} : { autoTitle },
  }
}

/**
 * The display title for the next blank project: the plain label while it is
 * free, otherwise one past the largest numbered suffix already in use, so
 * every "+" click mints a unique new list entry no matter how many blanks
 * already exist.
 * @param projects - the known projects.
 * @param untitledLabel - the untitled display label.
 * @returns a blank-project title unique among the given projects.
 */
export function nextUntitledTitle(projects: readonly ImagineProject[], untitledLabel: string): string {
  const prefix = `${untitledLabel} (`
  let largest = 0
  for (const project of projects) {
    if (project.id === HISTORY_PROJECT_ID) continue
    if (project.title === untitledLabel) {
      largest = Math.max(largest, 1)
      continue
    }
    if (!project.title.startsWith(prefix)) continue
    const suffix = project.title.slice(prefix.length, -1)
    const number = Number(suffix)
    if (Number.isInteger(number) && number > 0) largest = Math.max(largest, number)
  }
  return largest === 0 ? untitledLabel : `${untitledLabel} (${largest + 1})`
}

/**
 * Whether a title is still the studio's blank-project placeholder: the plain
 * label or one of its numbered forms, exactly as `nextUntitledTitle` writes
 * it. A title the user typed, however close, is not a placeholder.
 * @param title - the project title as displayed.
 * @param untitledLabel - the untitled display label.
 * @returns whether the title is a minted placeholder.
 */
export function isUntitledTitle(title: string, untitledLabel: string): boolean {
  const prefix = `${untitledLabel} (`
  if (title === untitledLabel) return true
  if (!title.startsWith(prefix) || !title.endsWith(')')) return false
  const suffix = title.slice(prefix.length, -1)
  return /^\d+$/.test(suffix) && Number(suffix) > 0
}

/**
 * Append a chat line to a project.
 * @param project - the current project.
 * @param message - the line to add.
 * @returns a new project record.
 */
export function appendMessage(
  project: ImagineProject,
  message: ImagineMessage,
): ImagineProject {
  return { ...project, messages: [...project.messages, message] }
}

/**
 * Append a live job id to a project.
 * @param project - the current project.
 * @param jobId - the queued job.
 * @returns a new project record.
 */
export function rememberJob(project: ImagineProject, jobId: string): ImagineProject {
  if (project.jobIds.includes(jobId)) return project
  return { ...project, jobIds: [...project.jobIds, jobId] }
}

/**
 * What each finished upscale replaces: source basename -> upscaled basename.
 *
 * An upscale is not a new picture, it is the same one at twice the size, so it
 * takes the place of its source instead of landing beside it.
 * @param jobs - the latest job list.
 * @returns the replacements, keyed by the file being replaced.
 */
export function upscaleReplacements(jobs: readonly ImagineJob[]): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const job of jobs) {
    if (job.action !== 'upscale' || job.status !== 'done') continue
    const source = job.source
    const produced = job.files?.[0]?.name
    if (source === undefined || produced === undefined || source === produced) continue
    out[source] ??= produced
  }
  return out
}

/**
 * Swap each replaced name for its upscaled one, keeping the source's position.
 *
 * A name is listed at most once: a canvas cannot show the same file twice, and
 * before this feature an upscale was APPENDED to the list, so a project written
 * by the older code holds both names — renaming the source onto a name already
 * further down would list it twice. The first position wins, which is the
 * source's, so the bigger file lands exactly where the smaller one was.
 * @param names - the project's current item names.
 * @param replaces - source basename -> upscaled basename.
 * @returns the swapped names, without repeats.
 */
function replaceInPlace(
  names: readonly string[],
  replaces: Readonly<Record<string, string>>,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const next = replaces[name] ?? name
    if (seen.has(next)) continue
    seen.add(next)
    out.push(next)
  }
  return out
}

/**
 * Fold finished job files into the project that owns those jobs.
 * @param project - the current project.
 * @param jobs - the latest job list.
 * @param confirm - renders the status line for a settled job.
 * @param notice - renders the line for a mid-run notice, said once per job.
 * @returns a new project when something changed, otherwise the same reference.
 */
export function absorbJobFiles(
  project: ImagineProject,
  jobs: readonly ImagineJob[],
  confirm?: (job: ImagineJob) => string,
  notice?: (notice: string) => string,
  replaces: Readonly<Record<string, string>> = upscaleReplacements(jobs),
): ImagineProject {
  const owned = new Set(project.jobIds)
  // Most projects own none of the listed jobs: they only follow the upscales.
  if (!jobs.some(job => owned.has(job.id))) {
    if (project.id === HISTORY_PROJECT_ID) return project
    const swapped = replaceInPlace(project.itemNames, replaces)
    return sameList(swapped, project.itemNames) ? project : { ...project, itemNames: swapped }
  }
  const have = new Set(project.itemNames)
  const extra: string[] = []
  const extraMessages: ImagineMessage[] = []
  /*
   * What a job has ALREADY been confirmed with, so a settled one is spoken
   * once. A mid-run notice is a status line on the same job and would land
   * here too — which silenced the result that came after it — so it is
   * excluded by its own id prefix.
   */
  const spoken = new Set(
    project.messages
      .filter(message => message.role === 'status'
        && message.jobId !== undefined
        && !message.id.startsWith('note-'))
      .map(message => message.jobId),
  )
  /*
   * `replaces` applies to every project, not just the ones owning a job: an
   * upscale replaces its source ON DISK, so a project that merely lists that
   * file has to follow it too. The caller may pass it in so a batch of
   * projects computes it once; the default keeps single callers correct.
   */
  const told = new Set(project.messages.map(message => message.id))
  for (const job of jobs) {
    if (!owned.has(job.id)) continue
    /*
     * A notice is spoken while the job is still running, so it cannot go
     * through `spoken` — that set is what stops a job from being confirmed
     * twice, and claiming the job here would silence its result. Its own
     * message id is the guard instead.
     */
    if (job.notice !== undefined && notice !== undefined && !told.has(`note-${job.id}`)) {
      extraMessages.push({
        id: `note-${job.id}`,
        role: 'status',
        text: notice(job.notice),
        createdAt: Date.now(),
        jobId: job.id,
      })
      told.add(`note-${job.id}`)
    }
    // A failed job never carries files, so the files check belongs to the
    // done branch only: outside it, the error branch below was unreachable
    // and a failed job just vanished from the chat column.
    if (job.status === 'done' && job.files !== undefined) {
      for (const file of job.files) {
        // An upscale result is not an addition: it goes in below, in place of
        // the source it was made from.
        if (job.action === 'upscale' && job.source !== undefined) continue
        // The job that MADE the source keeps listing it for ever. Once an
        // upscale has taken its place, putting it back here would fight the
        // swap below on every render: itemNames oscillating between ['Y'] and
        // ['Y','X'], which is React #185 by another door.
        if (replaces[file.name] !== undefined) continue
        if (!have.has(file.name)) {
          have.add(file.name)
          extra.push(file.name)
        }
      }
      if (confirm !== undefined && !spoken.has(job.id)) {
        extraMessages.push({
          id: `ok-${job.id}`,
          role: 'status',
          text: confirm(job),
          createdAt: Date.now(),
          jobId: job.id,
          // The result goes into the chat as well, like Grok Imagine: a click
          // on it takes the canvas to the tile (asked 2026-10-17).
          ...job.files.length === 0 ? {} : { files: job.files.map(file => ({ name: file.name, kind: file.kind })) },
        })
        spoken.add(job.id)
      }
    }
    if ((job.status === 'error' || job.status === 'cancelled') && confirm !== undefined && !spoken.has(job.id)) {
      extraMessages.push({
        id: `${job.status === 'cancelled' ? 'stop' : 'err'}-${job.id}`,
        role: 'status',
        // Always through `confirm`, never `job.error` raw. The caller's
        // confirm is what runs the error through friendlyError; reading
        // job.error here short-circuited it, so every ComfyUI rejection
        // reached the chat as the JSON the server had answered with.
        text: confirm(job),
        createdAt: Date.now(),
        jobId: job.id,
      })
      spoken.add(job.id)
    }
  }
  // The history project's itemNames are DERIVED from the gallery by
  // ensureHistoryProject: folding job files back into them makes the two
  // effects overwrite each other on every render (React #185).
  const isHistory = project.id === HISTORY_PROJECT_ID
  const names = isHistory ? [] : extra
  const swapped = isHistory ? project.itemNames : replaceInPlace(project.itemNames, replaces)
  /*
   * Compare the RESULT, not the fact that a replacement exists. A finished
   * upscale stays in the job list for good, so `replaces` is never empty after
   * the first one: returning a fresh array every time is what made the effect
   * that calls this re-run for ever — the React #185 the earlier attempt hit.
   */
  const moved = !sameList(swapped, project.itemNames)
  if (names.length === 0 && extraMessages.length === 0 && !moved) return project
  const base = moved ? swapped : project.itemNames
  return {
    ...project,
    itemNames: names.length === 0 ? base : [...base, ...names],
    messages: extraMessages.length === 0 ? project.messages : [...project.messages, ...extraMessages],
  }
}

/**
 * Ensure the history project exists.
 *
 * Its board is the whole inventory through the History's filters, never its
 * own list: until 2026-10-25 every new file rewrote `itemNames` here with the
 * names no other project owned, and that list went to the server with a PUT
 * of the whole studio, while nothing on the page read it. It is now kept
 * empty; an old list on disk is dropped once.
 * @param projects - the current list.
 * @param historyTitle - translated label for the history project.
 * @returns the same list when the project is there and empty, otherwise a new one.
 */
export function ensureHistoryProject(
  projects: readonly ImagineProject[],
  historyTitle: string,
): readonly ImagineProject[] {
  const existing = projects.find(project => project.id === HISTORY_PROJECT_ID)
  if (existing !== undefined && existing.itemNames.length === 0) return projects
  const next: ImagineProject = {
    id: HISTORY_PROJECT_ID,
    title: historyTitle,
    createdAt: existing?.createdAt ?? 0,
    itemNames: [],
    jobIds: existing?.jobIds ?? [],
    messages: existing?.messages ?? [],
  }
  if (existing === undefined) return [...projects, next]
  return projects.map(project => project.id === HISTORY_PROJECT_ID ? next : project)
}

/**
 * How many gallery files the history board draws before the user asks for
 * more. A page, not a ceiling: the gallery holds hundreds and every one of
 * them used to be unreachable past the fiftieth.
 */
export const HISTORY_PAGE = 50

/**
 * When the project was last worked in: its newest chat line or its newest
 * file, whichever is later, and its creation for a project with neither.
 * Derived rather than stamped on open, so the rail does not reshuffle under
 * the pointer when the user merely clicks through projects, and so it needs
 * no field the shared store would have to carry.
 * @param project - the project to date.
 * @param mtimeOf - modification time of a gallery file by name, when known.
 * @returns epoch milliseconds.
 */
export function lastUsedOf(
  project: ImagineProject,
  mtimeOf: (name: string) => number | undefined,
): number {
  let latest = project.createdAt
  for (const message of project.messages) {
    if (message.createdAt > latest) latest = message.createdAt
  }
  for (const name of project.itemNames) {
    const mtime = mtimeOf(name)
    if (mtime !== undefined && mtime > latest) latest = mtime
  }
  return latest
}

function richness(project: ImagineProject): number {
  return project.itemNames.length + project.messages.length + project.jobIds.length
}

/**
 * The chosen copy of a project plus the files and jobs only the other copy lists.
 *
 * Lists only grow — taking something out is a shared removal, applied after
 * the merge — so a file or job either copy holds belongs to the project. The
 * copy with more lines used to win whole, and the jobs the assistant had just
 * put into the stored copy were dropped from the board and then from disk.
 * The history project is exempt: its list is derived from the gallery.
 * @param winner - the copy whose title and lines are kept.
 * @param other - the copy that lost.
 * @returns the winner when the other adds nothing, otherwise a copy.
 */
function withListsOf(winner: ImagineProject, other: ImagineProject): ImagineProject {
  if (winner.id === HISTORY_PROJECT_ID) return winner
  const itemNames = other.itemNames.filter(name => !winner.itemNames.includes(name))
  const jobIds = other.jobIds.filter(jobId => !winner.jobIds.includes(jobId))
  /*
   * The lines too, by id. Until 2026-11-04 only files and jobs were unioned,
   * and a project whose stored copy held one more job id outranked the copy
   * this browser had just written (`richness` counts jobIds): the assistant's
   * prose was dropped by the next poll and the column lost the answer while
   * the run it had queued kept going. An id either copy holds is one line;
   * the winner's text for it stays, and the times put them back in order.
   */
  const seen = new Set(winner.messages.map(message => message.id))
  const messages = other.messages.filter(message => !seen.has(message.id))
  /*
   * The same line on both sides can still carry different fields: the runs it
   * queued are attached by the browser after it has already saved the prose,
   * so a poll that names the other copy as winner would hand back a line with
   * no `jobIds` and the results would leave the prose. The winner keeps its
   * text; the fields are unioned.
   */
  const twins = new Map(other.messages.map(message => [message.id, message]))
  let widened = false
  const kept = winner.messages.map((message) => {
    const twin = twins.get(message.id)
    if (twin === undefined) return message
    const next = widenMessage(message, twin)
    if (next !== message) widened = true
    return next
  })
  if (itemNames.length === 0 && jobIds.length === 0 && messages.length === 0 && !widened) return winner
  const lines = messages.length === 0
    ? kept
    : [...kept, ...messages].sort((a, b) => a.createdAt - b.createdAt)
  return {
    ...winner,
    itemNames: [...winner.itemNames, ...itemNames],
    jobIds: [...winner.jobIds, ...jobIds],
    messages: lines,
  }
}

/**
 * One line present in both copies: the winner's text, every field either side
 * knows about.
 * @param keep - the line of the copy that won.
 * @param other - the same line from the copy that lost.
 * @returns the winning line, or the same object when it already knew the fields.
 */
function widenMessage(keep: ImagineMessage, other: ImagineMessage): ImagineMessage {
  const jobIds = [...new Set([...keep.jobIds ?? [], ...other.jobIds ?? []])]
  const files = [...keep.files ?? []]
  for (const file of other.files ?? []) {
    if (!files.some(known => known.name === file.name)) files.push(file)
  }
  const thinking = keep.thinking ?? other.thinking
  const sameJobs = jobIds.length === (keep.jobIds?.length ?? 0)
  const sameFiles = files.length === (keep.files?.length ?? 0)
  if (sameJobs && sameFiles && thinking === keep.thinking) return keep
  return {
    ...keep,
    ...jobIds.length === 0 ? {} : { jobIds },
    ...files.length === 0 ? {} : { files },
    ...thinking === undefined ? {} : { thinking },
  }
}

/**
 * Union local and shared projects so a new browser does not wipe the rail
 * with an empty History-only store.
 *
 * A copy whose title the reading model (or the user) has already settled
 * beats a copy that is still on the placeholder name, whatever the richness:
 * the rename and the placeholder hold exactly the same files and lines, and
 * the tie rule would keep the placeholder the local copy still carries.
 * @param local - projects already on this device.
 * @param remote - projects from GET /comfy-imagine/projects.
 * @returns one list, real projects first, History last.
 */
export function mergeProjects(
  local: readonly ImagineProject[],
  remote: readonly ImagineProject[],
  deleted: ImagineTombstones = {},
): readonly ImagineProject[] {
  const byId = new Map<string, ImagineProject>()
  for (const project of [...remote, ...local]) {
    // A deleted project stays deleted, however rich the copy that comes back.
    if (deleted[project.id] !== undefined) continue
    const previous = byId.get(project.id)
    if (previous === undefined) {
      byId.set(project.id, project)
      continue
    }
    const settled = (entry: ImagineProject): boolean => entry.autoTitle !== true
    const winner = settled(project) !== settled(previous)
      ? (settled(project) ? project : previous)
      : (richness(project) >= richness(previous) ? project : previous)
    byId.set(project.id, withListsOf(winner, winner === project ? previous : project))
  }
  const rest = [...byId.values()]
    .filter(project => project.id !== HISTORY_PROJECT_ID)
    .sort((a, b) => b.createdAt - a.createdAt)
  const history = byId.get(HISTORY_PROJECT_ID)
  return history === undefined ? rest : [...rest, history]
}


/**
 * Take out of every project the files and jobs the shared removals name.
 *
 * Applied after the merge, because the merge keeps the richer copy of a
 * project and a copy that still lists a removed file is always the richer
 * one: without this a browser that had the polluted rail open kept showing
 * it, and saved it back.
 * @param projects - the merged rail.
 * @param removed - the shared removals.
 * @returns the same list when nothing applies, otherwise a new one.
 */
export function stripRemoved(
  projects: readonly ImagineProject[],
  removed: ImagineRemovals | undefined,
): readonly ImagineProject[] {
  if (removed === undefined || Object.keys(removed).length === 0) return projects
  const out = projects.map((project) => {
    const gone = removed[project.id]
    if (gone === undefined) return project
    const itemNames = project.itemNames.filter(name => gone[name] === undefined)
    const jobIds = project.jobIds.filter(jobId => gone[jobId] === undefined)
    if (itemNames.length === project.itemNames.length && jobIds.length === project.jobIds.length) return project
    return { ...project, itemNames, jobIds }
  })
  return sameList(out, projects) ? projects : out
}

/**
 * Follow the files the host renamed, in every project.
 *
 * Applied after the merge for the same reason as removals: a rail that still
 * lists the old name is exactly as rich as one with the new, and a tie goes
 * to this browser's own copy — which then points at files that are gone.
 * @param projects - the merged rail.
 * @param renamed - old basename to new.
 * @returns the same list when nothing applies, otherwise a new one.
 */
export function followRenames(
  projects: readonly ImagineProject[],
  renamed: Readonly<Record<string, string>> | undefined,
): readonly ImagineProject[] {
  if (renamed === undefined || Object.keys(renamed).length === 0) return projects
  const out = projects.map((project) => {
    const itemNames = replaceInPlace(project.itemNames, renamed)
    return sameList(itemNames, project.itemNames) ? project : { ...project, itemNames }
  })
  return sameList(out, projects) ? projects : out
}

/**
 * Merge two tombstone sets, keeping the earliest delete for each id.
 * @param local - what this browser recorded.
 * @param remote - what the shared store holds.
 * @returns every id either side deleted.
 */
export function mergeTombstones(
  local: ImagineTombstones,
  remote: ImagineTombstones,
): ImagineTombstones {
  const out: Record<string, number> = { ...remote }
  for (const [id, at] of Object.entries(local)) {
    const previous = out[id]
    out[id] = previous === undefined ? at : Math.min(previous, at)
  }
  return out
}

/**
 * Keep the most recent tombstones, up to the ceiling, so the set cannot grow
 * without bound; the host caps its own copy the same way (`capTombstones`).
 * @param deleted - the current tombstones.
 * @param ceiling - how many to keep.
 * @returns the set itself when within the ceiling, else its newest entries.
 */
export function capTombstones(
  deleted: ImagineTombstones,
  ceiling: number = MAX_TOMBSTONES,
): ImagineTombstones {
  const entries = Object.entries(deleted)
  if (entries.length <= ceiling) return deleted
  entries.sort(([, a], [, b]) => b - a)
  return Object.fromEntries(entries.slice(0, ceiling))
}

/**
 * Whether a message is real content: the seed line the studio writes into a
 * fresh project is bookkeeping, not something the project holds, and a
 * project with nothing but it is empty whatever its rail label says.
 * @param messages - the project's lines.
 * @returns whether at least one of them is not the seed line.
 */
function hasRealContent(messages: readonly ImagineMessage[]): boolean {
  return messages.some(message => !isSeedMessage(message))
}

/**
 * True when a project holds nothing at all: no files, no jobs, and no line
 * but the seed the studio wrote itself. Those are the ones a click on a home
 * card, or on the "+", left behind before anything was ever generated in
 * them — they show on the rail with an empty canvas and an empty column, and
 * without this they are what "empty projects" that stay means. The history
 * project is never one of them — it is derived, not owned.
 * @param project - the project to judge.
 * @returns whether the rail can forget it.
 */
function isEmptyProject(project: ImagineProject): boolean {
  return project.id !== HISTORY_PROJECT_ID
    && project.itemNames.length === 0
    && project.jobIds.length === 0
    && !hasRealContent(project.messages)
}

/**
 * Split a rail into what is worth keeping and what can be forgotten, with a
 * tombstone for each removal so it cannot come back from a stale copy.
 * @param projects - the current rail.
 * @param at - epoch milliseconds to stamp the tombstones with.
 * @returns the surviving projects and the tombstones to record.
 */
export function purgeEmptyProjects(
  projects: readonly ImagineProject[],
  at: number,
): { kept: readonly ImagineProject[]; deleted: ImagineTombstones } {
  const kept: ImagineProject[] = []
  const deleted: Record<string, number> = {}
  for (const project of projects) {
    if (isEmptyProject(project)) deleted[project.id] = at
    else kept.push(project)
  }
  return { kept, deleted }
}
