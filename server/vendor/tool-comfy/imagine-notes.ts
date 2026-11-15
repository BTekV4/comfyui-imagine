/**
 * What the studio knows about one produced file, kept beside the file's life.
 *
 * Two things the chat needs about a picture on the board and could not have:
 * how it was made — the action, the look, the pose, the format — and what is
 * in it. The first lives on the job, and the job map is pruned half an hour
 * after a run; the second was a description the chat cached in memory for the
 * files staged in it, and only those. So "rifai queste foto in 9:16" met a
 * reading that had thirteen file names and nothing else, and asked which
 * poses were meant when every one of them had been chosen by the studio.
 *
 * A note is filed under the produced file's name, next to the written prompts
 * in the data folder: the origin when the run finishes, the sight as soon as
 * something has looked at the file. Both outlive the job and the process.
 * @module tool-comfy/imagine-notes
 */

import { readFile, unlink } from 'node:fs/promises'
import { serialized, writeFileAtomic } from '../atomic-write/index.ts'
import { producedFilePath } from './written-prompts.ts'
import type { HostEdit, ImagineAction } from '../../../shared/imagine-types.ts'

/** How a produced file came to be: the fields a run would need to redo it. */
export interface ImagineFileOrigin {
  /** The studio action that made it, or the host's own edit (trim, crop, …). */
  readonly action: ImagineAction | HostEdit
  /** The prompt, or the look's title for a lookbook run. */
  readonly prompt: string
  readonly pose?: string
  readonly aspect?: string
  readonly resolution?: string
  readonly seconds?: number
  /** The file the run started from, when it started from one. */
  readonly source?: string
  readonly changes?: string
  readonly subject?: string
  /** How well a sung shot's mouth followed the voice, 0-1, when measured. */
  readonly lipsync?: number
  /**
   * How long the run took, in milliseconds.
   *
   * The page reads it in "Dettagli" as "Generazione": how long this file was
   * in the making, which nothing else on disk records — the job map that knew
   * is pruned half an hour after the run.
   */
  readonly tookMs?: number
}

/** Everything filed about one produced file. */
export interface ImagineFileNote {
  readonly origin?: ImagineFileOrigin
  /** What a vision model saw in it, in the user's language. */
  readonly sight?: string
}

/** Longest description kept: past this it is a story, not a caption. */
const MAX_SIGHT_CHARS = 1200

/** Where one produced file's note is kept. */
function notePath(name: string): string | undefined {
  return producedFilePath('notes', name, '.json')
}

/**
 * Read one file's note.
 * @param name - the produced file's basename.
 * @returns the note, or undefined when nothing was ever filed about it.
 */
export async function recallNote(name: string): Promise<ImagineFileNote | undefined> {
  const path = notePath(name)
  if (path === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return noteOf(parsed)
  } catch {
    return undefined
  }
}

/**
 * Read several files' notes at once, keeping only the ones that exist.
 * @param names - produced file basenames.
 * @returns the notes by name.
 */
export async function recallNotes(names: readonly string[]): Promise<ReadonlyMap<string, ImagineFileNote>> {
  const out = new Map<string, ImagineFileNote>()
  const unique = [...new Set(names)]
  const notes = await Promise.all(unique.map(name => recallNote(name)))
  unique.forEach((name, index) => {
    const note = notes[index]
    if (note !== undefined) out.set(name, note)
  })
  return out
}

/**
 * File how a produced file was made.
 *
 * Never throws: a note that cannot be filed costs the chat one file's
 * history, which is not worth failing a finished generation over.
 * @param name - the produced file's basename.
 * @param origin - the run that produced it.
 */
export async function rememberOrigin(name: string, origin: ImagineFileOrigin): Promise<void> {
  await amend(name, note => ({ ...note, origin }))
}

/**
 * File what was seen in a produced file.
 * @param name - the produced file's basename.
 * @param sight - the vision model's description.
 */
export async function rememberSight(name: string, sight: string): Promise<void> {
  const text = sight.trim().slice(0, MAX_SIGHT_CHARS)
  if (text.length === 0) return
  await amend(name, note => ({ ...note, sight: text }))
}

/**
 * Drop the description of a file whose bytes changed, keeping its origin.
 * @param name - the produced file's basename.
 */
export async function forgetSightNote(name: string): Promise<void> {
  await amend(name, (note) => {
    const { sight: _gone, ...rest } = note
    return rest
  })
}

/**
 * Drop everything filed about a deleted file.
 * @param name - the produced file's basename.
 */
export async function forgetNote(name: string): Promise<void> {
  const path = notePath(name)
  if (path === undefined) return
  // In the same queue as the amends: an amend that had already read the note
  // would otherwise write it back after the unlink, an orphan note for a file
  // that is gone.
  await serialized(path, async () => { await unlinkNote(path) }).catch(() => undefined)
}

/** Remove a note file; the caller holds the note's queue. */
async function unlinkNote(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch { /* already gone, or never filed */ }
}

/**
 * Read-modify-write one note, never throwing.
 *
 * One change at a time per note, written by rename: the origin of a finished
 * run and the sight of the same file arrive together, and two unserialised
 * amends each wrote back the note they had read, dropping the other's half;
 * a crash in the middle of a plain write left a truncated JSON.
 */
async function amend(name: string, change: (note: ImagineFileNote) => ImagineFileNote): Promise<void> {
  const path = notePath(name)
  if (path === undefined) return
  try {
    await serialized(path, async () => {
      const next = change(await recallNote(name) ?? {})
      if (next.origin === undefined && next.sight === undefined) {
        await unlinkNote(path)
        return
      }
      await writeFileAtomic(path, JSON.stringify(next), { mode: 0o644 })
    })
  } catch { /* the note is a convenience, the file is the deliverable */ }
}

/** Read a note back off disk, dropping anything that is not its shape. */
function noteOf(value: unknown): ImagineFileNote | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const origin = originOf(record.origin)
  const sight = typeof record.sight === 'string' && record.sight.trim().length > 0 ? record.sight : undefined
  if (origin === undefined && sight === undefined) return undefined
  return {
    ...origin === undefined ? {} : { origin },
    ...sight === undefined ? {} : { sight },
  }
}

function originOf(value: unknown): ImagineFileOrigin | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.action !== 'string' || typeof record.prompt !== 'string') return undefined
  const text = (key: string): string | undefined => {
    const value = record[key]
    return typeof value === 'string' ? value : undefined
  }
  return {
    action: record.action as ImagineAction | HostEdit,
    prompt: record.prompt,
    ...text('pose') === undefined ? {} : { pose: text('pose') as string },
    ...text('aspect') === undefined ? {} : { aspect: text('aspect') as string },
    ...text('resolution') === undefined ? {} : { resolution: text('resolution') as string },
    ...typeof record.seconds === 'number' && Number.isFinite(record.seconds) ? { seconds: record.seconds } : {},
    ...text('source') === undefined ? {} : { source: text('source') as string },
    ...text('changes') === undefined ? {} : { changes: text('changes') as string },
    ...text('subject') === undefined ? {} : { subject: text('subject') as string },
    ...typeof record.lipsync === 'number' && Number.isFinite(record.lipsync) ? { lipsync: record.lipsync } : {},
    ...typeof record.tookMs === 'number' && Number.isFinite(record.tookMs) ? { tookMs: record.tookMs } : {},
  }
}
