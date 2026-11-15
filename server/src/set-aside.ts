/**
 * Moving a file or folder out of the way instead of deleting it: the removed
 * plugins go to `<data>/plugins-rimossi/`, the removed language packs to
 * `<data>/locales-rimossi/`, each with the moment it left in its name.
 * @module set-aside
 */
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'

/** A moment as a file name can carry it: `2026-11-14T10-20-30-123Z`. */
export const fileStamp = (): string => new Date().toISOString().replace(/[:.]/g, '-')

/**
 * Move `source` into `folder` as `<name>-<stamp><suffix>`.
 * @param source - the file or folder to move.
 * @param folder - where it goes; created when missing.
 * @param name - the head of the new name (the plugin id, the language code).
 * @param suffix - what follows the stamp (`.json` for a pack).
 * @returns the new path.
 */
export async function setAside(source: string, folder: string, name: string, suffix = ''): Promise<string> {
  const movedTo = join(folder, `${name}-${fileStamp()}${suffix}`)
  await mkdir(folder, { recursive: true })
  await rename(source, movedTo)
  return movedTo
}
