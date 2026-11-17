/**
 * Where a configured workflow file is read from, and where an edit to it goes.
 *
 * In a service, a container or a portable package the program and the data
 * share one writable tree: the graph named by `config.yaml` is the file the
 * settings page writes, and there is nothing to decide. Inside a desktop app
 * the program is **read-only** — the AppImage is mounted that way and replaced
 * whole on every update — so a graph that ships with the program cannot be
 * written at all, and copying the whole tree into the user's folder on the
 * first start (which is what the AppImage did until 2026-11-17) loses every
 * update of those same files.
 *
 * The rule here is copy-on-write, per file:
 *
 * - a bundled graph is read from the program until the user changes it, so a
 *   new version brings new graphs;
 * - the first change copies that one file into the data folder, at
 *   `<data>/workflows/<the same relative path>`, and the edit lands there;
 * - from then on the copy wins, update or not — and «Restore default» deletes
 *   it, which is the only way back to the program's copy.
 *
 * A path that is not inside the program (a graph the user keeps somewhere
 * else, a `custom:<id>` resolved to the data folder) is not the program's: it
 * is read and written where it is, exactly as every installation has done.
 * @module tool-comfy/workflow-overlay
 */

import { constants, existsSync, mkdirSync } from 'node:fs'
import { copyFile, readdir, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { dataPath } from '../home-paths/index.ts'

/** What {@link createWorkflowOverlay} needs to know about this installation. */
export interface WorkflowOverlayOptions {
  /**
   * The read-only program folder of a packaged app (`IMAGINE_PROGRAM_DIR`).
   * Absent in every other installation: nothing is copied, nothing moves.
   */
  readonly programDir?: string | undefined
  /** Where the copies live; `<data>/workflows` unless a test says otherwise. */
  readonly dir?: string | undefined
}

/** Reading and writing the configured graphs, wherever this installation keeps them. */
export interface WorkflowOverlay {
  /** The file to read: the user's copy when there is one, else the file itself. */
  active(file: string): string
  /** Whether an edit to this file was made (its copy exists). */
  overridden(file: string): boolean
  /**
   * The file to write for an edit, copying the program's file into the data
   * folder the first time. Nothing is copied for a file the program does not
   * own: that one is written where it is.
   */
  ensureWritable(file: string): Promise<string>
  /**
   * Throw away the user's copy of one graph, so the program's file is used
   * again (and its updates with it).
   * @returns true when a copy was removed.
   */
  restore(file: string): Promise<boolean>
}

/** Copies of the graphs, under the data folder: `<data>/workflows/<rel>`. */
const copyRoot = (dir: string | undefined): string => dir ?? dataPath('workflows')

/**
 * The path of a bundled graph relative to the program, or undefined when the
 * program does not own it.
 *
 * `..` and an absolute path both answer undefined: a config that points at
 * `/home/ada/graphs/mine.json` is naming the user's file, and copying it into
 * the data folder would be taking it away from the user.
 * @param programDir - the program folder, when there is one.
 * @param file - the configured file, as `config.yaml` resolved it.
 * @returns the relative path, or undefined.
 */
export function programRelative(programDir: string | undefined, file: string): string | undefined {
  if (programDir === undefined) return undefined
  const root = resolve(programDir)
  const target = resolve(file)
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return rel.split(sep).join('/')
}

/**
 * The copy a bundled graph gets when it is first edited.
 * @param options - the folder the copies live in.
 * @param file - the configured file.
 * @returns the copy's path, or undefined when the program does not own the file.
 */
export function copyOf(options: WorkflowOverlayOptions, file: string): string | undefined {
  const rel = programRelative(options.programDir, file)
  return rel === undefined ? undefined : join(copyRoot(options.dir), rel)
}

/**
 * The reader and writer this installation uses for its configured graphs.
 * @param options - the program folder and where copies go.
 * @returns the overlay: where to read, where to write, and how to go back.
 */
export function createWorkflowOverlay(options: WorkflowOverlayOptions): WorkflowOverlay {
  const active = (file: string): string => {
    const copy = copyOf(options, file)
    return copy !== undefined && existsSync(copy) ? copy : file
  }
  const overridden = (file: string): boolean => {
    const copy = copyOf(options, file)
    return copy !== undefined && existsSync(copy)
  }
  const ensureWritable = async (file: string): Promise<string> => {
    const copy = copyOf(options, file)
    if (copy === undefined || existsSync(copy)) return copy ?? file
    mkdirSync(dirname(copy), { recursive: true })
    try {
      // `COPYFILE_EXCL`: two edits landing together must not copy twice, and
      // the second must not overwrite the copy the first is writing.
      await copyFile(file, copy, constants.COPYFILE_EXCL)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    return copy
  }
  const restore = async (file: string): Promise<boolean> => {
    const copy = copyOf(options, file)
    if (copy === undefined) return false
    const info = await stat(copy).catch(() => undefined)
    if (info?.isFile() !== true) return false
    await rm(copy, { force: true })
    /*
     * The copies `editWorkflowFile` keeps beside a graph (`<file>.bak-<date>`)
     * belong to the copy that is going away: left there they would be restored
     * as if they were graphs, and nothing would explain where they came from.
     */
    const folder = dirname(copy)
    const prefix = `${copy.slice(folder.length + 1)}.bak-`
    for (const name of await readdir(folder).catch(() => [] as string[])) {
      if (name.startsWith(prefix)) await rm(join(folder, name), { force: true })
    }
    return true
  }
  return { active, overridden, ensureWritable, restore }
}

/** An overlay for an installation whose program is writable: every file is its own. */
export const writableOverlay: WorkflowOverlay = {
  active: file => file,
  overridden: () => false,
  ensureWritable: async file => file,
  restore: async () => false,
}
