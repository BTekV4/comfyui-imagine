/**
 * The filesystem calls Windows refuses for a moment.
 *
 * `MoveFileEx` (Node's `rename`) and `DeleteFile` answer EPERM, EACCES or
 * EBUSY while another process holds the file without delete sharing: a virus
 * scanner that has just seen it, the search indexer, a player still reading a
 * clip. The error is gone a few dozen milliseconds later, so the media steps
 * retry it with a short backoff instead of failing a run (or leaving a
 * half-renamed job) over a lock nobody can see.
 *
 * One implementation for every caller: `writeFileAtomic` uses it too, so the
 * JSON state and the media files retry with the same rule.
 * @module retry-fs
 */

import type { RmOptions } from 'node:fs'
import { rename, rm, unlink } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

/** How many times an operation blocked by a scanner or the indexer is tried. */
export const FILE_RETRY_ATTEMPTS = 10
/** The pause before the first retry; each following one waits a little longer. */
export const FILE_RETRY_BACKOFF_MS = 20

/** The error codes Windows returns while another process holds the file. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** Knobs for {@link retryFileOperation}; the defaults are what production uses. */
export interface FileRetryOptions {
  /** Total tries, the first one included. */
  readonly attempts?: number
  /** The pause before the first retry, multiplied by the attempt number. */
  readonly backoffMs?: number
  /**
   * The platform whose error codes apply. `process.platform` unless a test
   * says otherwise; on anything but Windows the operation runs once.
   */
  readonly platform?: NodeJS.Platform
}

/**
 * Whether an error is the transient lock Windows puts on a file.
 * @param error - what the filesystem call threw.
 * @param platform - the platform whose codes apply.
 * @returns true when waiting and trying again can succeed.
 */
export function isTransientFileError(error: unknown, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code !== undefined && TRANSIENT_CODES.has(code)
}

/**
 * Run a filesystem operation, retrying the transient Windows lock.
 *
 * The first try is immediate. On Windows only, EPERM/EACCES/EBUSY wait
 * `backoffMs * attempt` and run again, up to `attempts` tries; every other
 * error (and every error on POSIX) is thrown at once, with its own code.
 * @param operation - the call to make, e.g. `() => rename(from, to)`.
 * @param options - attempts, backoff and platform; the production defaults
 *   are {@link FILE_RETRY_ATTEMPTS}, {@link FILE_RETRY_BACKOFF_MS} and the
 *   running platform.
 * @returns what the operation returned.
 * @throws the last error when every try failed.
 */
export async function retryFileOperation<T>(operation: () => Promise<T>, options: FileRetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? FILE_RETRY_ATTEMPTS)
  const backoffMs = options.backoffMs ?? FILE_RETRY_BACKOFF_MS
  const platform = options.platform ?? process.platform
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      if (!isTransientFileError(error, platform) || attempt >= attempts) throw error
      await delay(backoffMs * attempt)
    }
  }
}

/**
 * A file moved over another, retrying the Windows lock.
 *
 * The ordinary replacement of a media file: a muxed clip over the generated
 * one, a snapped still over the original, a story's cut over its last shot.
 * @param from - the file to move.
 * @param to - the file it replaces (or becomes).
 */
export function renameWithRetry(from: string, to: string): Promise<void> {
  return retryFileOperation(() => rename(from, to))
}

/**
 * A file removed, retrying the Windows lock.
 * @param path - the file to remove.
 */
export function unlinkWithRetry(path: string): Promise<void> {
  return retryFileOperation(() => unlink(path))
}

/**
 * A file or folder removed through `rm`, retrying the Windows lock.
 *
 * `force` and `recursive` are passed through as the caller wrote them; a
 * missing path with `force` still resolves, as `rm` does.
 * @param path - the file or folder to remove.
 * @param options - the `rm` options.
 */
export function rmWithRetry(path: string, options: RmOptions = {}): Promise<void> {
  return retryFileOperation(() => rm(path, options))
}
