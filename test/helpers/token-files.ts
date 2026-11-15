/**
 * A throwaway config folder holding one token file, as the Instagram
 * plugin's token readers find it. Three test files carried their own copy
 * until 2026-11-15.
 * @module test/helpers/token-files
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Writes `content` as JSON to `<new folder under root>/<file>`, owner-only.
 * @param root - the test file's temporary folder.
 * @param file - the token file's name.
 * @param content - what the file says.
 * @returns the new folder.
 */
export async function tokenDir(root: string, file: string, content: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(root, 'cfg-'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, file), `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 })
  return dir
}
