/**
 * A JSON list on disk (the Mi piace, the tags), kept in memory after the
 * first read and written through on every change.
 *
 * Both routes read the file again on every GET until 2026-10-25. Nothing
 * outside this process writes these files (see `serialized`), so the copy in
 * memory is the truth and the file is its record.
 * @module json-list
 */
import { readJsonFile, serialized, writeFileAtomic } from '../vendor/atomic-write/index.ts'

export interface JsonList {
  /** The stored entries, unchecked: a broken or missing file reads as empty. */
  read(): Promise<readonly unknown[]>
  /**
   * Read, change and write in one turn of the file's writer queue, so two
   * changes in a row each keep theirs.
   * @param change - gets the stored entries, returns what to answer and,
   *   when the list changed, the entries to write.
   */
  update<T>(change: (entries: readonly unknown[]) => Promise<{ readonly answer: T; readonly next?: readonly unknown[] }>): Promise<T>
}

export function jsonList(file: string): JsonList {
  let entries: Promise<readonly unknown[]> | undefined
  const read = (): Promise<readonly unknown[]> => {
    entries ??= readJsonFile(file).then(body => (Array.isArray(body) ? body : []) as readonly unknown[])
    return entries
  }
  return {
    read,
    update: change => serialized(file, async () => {
      const { answer, next } = await change(await read())
      if (next !== undefined) {
        await writeFileAtomic(file, JSON.stringify(next), { mode: 0o644 })
        entries = Promise.resolve(next)
      }
      return answer
    }),
  }
}
