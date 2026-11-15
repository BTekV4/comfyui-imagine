/**
 * The names in the media directory, for Mi piace and tags to drop a name
 * whose file is gone.
 *
 * Checking each with `existsSync` blocked the event loop once per liked file
 * on every read; a `readdir` of thousands of names on every GET was the next
 * cost. The listing is kept and read again only when the directory's mtime
 * moves, which it does whenever an entry is added, removed or renamed.
 */
import { readdir, stat } from 'node:fs/promises'
import { safeBasename } from '../vendor/tool-comfy/gallery.ts'

let cached: { readonly dir: string; readonly mtime: number; readonly names: ReadonlySet<string> } | undefined

/**
 * The basenames present in the media directory.
 * @param outputDir - the media directory.
 * @returns the set of names, empty when the directory cannot be read.
 */
export async function mediaNames(outputDir: string): Promise<ReadonlySet<string>> {
  try {
    const mtime = (await stat(outputDir)).mtimeMs
    if (cached?.dir === outputDir && cached.mtime === mtime) return cached.names
    const names = new Set(await readdir(outputDir))
    cached = { dir: outputDir, mtime, names }
    return names
  } catch {
    return new Set()
  }
}

/**
 * The entries of a stored list that still name a present gallery file.
 * @param value - the untrusted stored value.
 * @param present - the names in the media directory.
 * @returns the kept names, in their order.
 */
export function presentNames(value: unknown, present: ReadonlySet<string>): string[] {
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === 'string' && safeBasename(name) === name && present.has(name))
    : []
}
