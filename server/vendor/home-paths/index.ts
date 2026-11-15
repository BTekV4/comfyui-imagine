/**
 * The data root of the studio: `$IMAGINE_HOME`, else `~/.imagine`.
 *
 * `$DSH_HOME` (the name under DeepSeek Harness) and the `~/.dsh` fallback were
 * dropped on 2026-11-14: production names `IMAGINE_HOME` in its env file.
 *
 * Read once at startup: the environment does not change under a running
 * process, so the root is a constant.
 * @module home-paths
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The variable's value. An empty or whitespace-only value is treated as
 * unset, so a blank override never resolves the root to the current working
 * directory.
 */
function fromEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

const DATA_ROOT = resolve(fromEnv('IMAGINE_HOME') ?? join(homedir(), '.imagine'))

/**
 * Join path segments onto the data root.
 * @param segments - path segments appended to the root; none returns the root itself.
 * @returns the normalized absolute joined path.
 */
export function dataPath(...segments: string[]): string {
  return join(DATA_ROOT, ...segments)
}
