/**
 * What a clip was written with, kept for the clip that continues it.
 *
 * The job map is in memory and pruned half an hour after a run finishes, so a
 * clip extended the next morning — or after a restart — had no soundtrack to
 * carry forward and the continuation invented another one. The prompt the
 * vision pass wrote is therefore also written beside the data folder's other
 * ComfyUI state, named after the file it produced.
 * @module tool-comfy/written-prompts
 */

import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '../atomic-write/index.ts'
import { dataPath } from '../home-paths/index.ts'

/**
 * A produced file's own name, with its own guard rather than the gallery's:
 * the gallery deletes these files, so importing its check here would close a
 * cycle between the two modules.
 */
const PRODUCED_NAME = /^[A-Za-z0-9._-]{1,120}$/

/**
 * Where something filed about one produced file is kept: a written prompt
 * here, a note in `imagine-notes.ts`.
 * @param folder - the folder under `<data>/comfy`.
 * @param name - the produced file's basename.
 * @param ext - the extension of the filed record, with its dot.
 * @returns the path, or undefined for a name that is not a produced file's.
 */
export function producedFilePath(folder: string, name: string, ext: string): string | undefined {
  return PRODUCED_NAME.test(name) && !name.startsWith('.')
    ? join(dataPath('comfy', folder), `${name}${ext}`)
    : undefined
}

/** Where one produced file's written prompt is kept. */
function promptPath(name: string): string | undefined {
  return producedFilePath('prompts', name, '.txt')
}

/**
 * Keep the prompt a produced clip was generated with.
 *
 * Never throws: a prompt that cannot be filed costs the next continuation its
 * grounding, which is not worth failing a finished generation over.
 * @param name - the produced file's basename.
 * @param prompt - the written H3 prompt.
 */
export async function rememberWrittenPrompt(name: string, prompt: string): Promise<void> {
  const path = promptPath(name)
  if (path === undefined) return
  try {
    // By rename: a continuation reading the prompt while it is written must
    // not get half of it.
    await writeFileAtomic(path, prompt, { mode: 0o600 })
  } catch {
    // Filed on a best-effort basis; see the module note.
  }
}

/**
 * The prompt a produced clip was generated with, when it was filed.
 * @param name - the produced file's basename.
 * @returns the written prompt, or undefined when none was kept.
 */
export async function recallWrittenPrompt(name: string): Promise<string | undefined> {
  const path = promptPath(name)
  if (path === undefined) return undefined
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Drop a produced clip's written prompt, when the clip itself is deleted.
 * @param name - the produced file's basename.
 */
export async function forgetWrittenPrompt(name: string): Promise<void> {
  const path = promptPath(name)
  if (path === undefined) return
  await unlink(path).catch(() => undefined)
}
