/**
 * Atomic file replacement, writer coordination and the tolerant JSON read
 * that goes with them. `writeFileAtomic` writes a
 * random-suffix sibling with exclusive create and the caller's permission
 * bits, then renames it over the target, so readers observe either the old or
 * the new complete content and a replaced file ends up with exactly the
 * stated mode. `serialized` queues the writers of one file inside this
 * process, so a read-modify-write cycle can never resurrect a state another
 * writer just replaced; readers stay lock-free because the rename commit is
 * atomic.
 * @module atomic-write
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/**
 * Filesystem options for {@link writeFileAtomic}; `mode` is required so the
 * permission decision stays visible at every call site.
 */
export interface WriteFileAtomicOptions {
  /**
   * Permission bits stamped on the fresh temp inode and carried through the
   * rename (subject to the process umask, like every fresh inode).
   */
  mode: number
  /**
   * Permission bits for parent directories this call creates (subject to the
   * umask; existing directories keep their mode). Omission uses the mkdir
   * default — pass `0o700` when the tree holds user-private data.
   */
  dirMode?: number
}

/**
 * Replace `filename` with `content` in one atomic step, creating parent
 * directories. The content is first written to a random-suffix sibling opened
 * with exclusive create (`wx`): the open refuses to follow a symlink planted
 * at the temp path, and the fresh inode carries `options.mode` through the
 * rename, so replacing a wider-permission file narrows it without a chmod
 * race. The rename also replaces a symlinked target itself instead of writing
 * through to its referent, and the same-directory sibling keeps the rename on
 * one filesystem. On failure the temp file is removed and the failure
 * rethrown. Crash durability (fsync) is out of scope. On Windows a rename
 * over an existing file can fail with EPERM/EBUSY while a virus scanner or the
 * search indexer has the old one open for a moment: that error is retried a
 * few times, as `write-file-atomic` does upstream.
 * @param filename - final path receiving the content.
 * @param content - complete next file content.
 * @param options - permission bits for the replacement inode.
 */
export async function writeFileAtomic(filename: string, content: string | Uint8Array, options: WriteFileAtomicOptions): Promise<void> {
  await mkdir(dirname(filename), {
    recursive: true,
    ...options.dirMode === undefined ? {} : { mode: options.dirMode },
  })
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, { mode: options.mode, flag: 'wx' })
    await renameOverExisting(temp, filename)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** How many times a Windows rename blocked by a scanner or the indexer is tried. */
const RENAME_ATTEMPTS = 10
/** The pause before the first retry; each following one waits a little longer. */
const RENAME_BACKOFF_MS = 20

/**
 * A rename over an existing file, with the retry Windows needs.
 *
 * `MoveFileEx` (which Node's `rename` uses) answers EPERM or EBUSY when
 * another process holds the destination open without delete sharing: virus
 * scanners and the search indexer do this for a few milliseconds after a file
 * is written. Everywhere else the error is a real one and is thrown at once.
 * @param from - the temporary file just written.
 * @param to - the file it replaces.
 */
async function renameOverExisting(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      const transient = process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')
      if (!transient || attempt >= RENAME_ATTEMPTS) throw error
      await delay(RENAME_BACKOFF_MS * (attempt + 1))
    }
  }
}

/** The tail of each path's queue of writers; dropped when it drains. */
const queues = new Map<string, Promise<unknown>>()

/**
 * Run `operation` after every earlier operation on the same path has settled.
 *
 * This app is one process, and nothing outside it writes the files these
 * guard (the likes, the tags, the project store, the story manifests and the
 * notes: checked 2026-10-25 against the Instagram scripts and the units in
 * one data directory), so an in-memory queue is enough to keep two
 * read-modify-write cycles from each writing back what it read. Until then it
 * was DSH's cross-process lock: a `.lock` sibling, PID records and a backoff.
 * A failed operation does not block the ones behind it.
 * @param path - the file whose writers this serializes.
 * @param operation - the read-render-commit cycle.
 * @returns the operation's result.
 */
export function serialized<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve()
  const run = previous.then(operation, operation)
  const tail = run.catch(() => undefined)
  queues.set(path, tail)
  void tail.then(() => { if (queues.get(path) === tail) queues.delete(path) })
  return run
}

/**
 * A JSON file's parsed content, or undefined when it is missing or unreadable.
 *
 * The record files here (likes, tags, settings, the Instagram queues and
 * caption rings) all start absent and are rebuilt from nothing when broken,
 * so a failed read is a value, not an error. Four copies of this lived in
 * `social` and one in each host route until 2026-10-25.
 * @param path - the file.
 * @param label - when given, a file that exists but cannot be read or parsed
 *   is reported with this prefix (a missing one never is).
 * @returns the parsed value, or undefined.
 */
export async function readJsonFile(path: string, label?: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error: unknown) {
    const missing = (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
    if (label !== undefined && !missing) console.warn(`${label} ${path} ignored: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}
