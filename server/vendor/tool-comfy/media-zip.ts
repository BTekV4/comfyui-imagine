/**
 * One ZIP of several gallery files, streamed from the Imagine output
 * directory.
 *
 * The studio can select many tiles at once; saving them one click at a time is
 * the only thing the browser offers on its own. Entries are STORED, not
 * deflated: every file in there is a PNG, WebP, MP4 or MP3, already compressed,
 * so deflating them again spends the host's CPU to grow the archive.
 * @module tool-comfy/media-zip
 */

import { message } from '../../src/messages.ts'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { once } from 'node:events'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import { Zip, ZipPassThrough } from 'fflate'
import { sendJson } from '../../src/route-kit.ts'
import { safeBasename } from './gallery.ts'
import { mapWithConcurrency } from './media-tools.ts'

/**
 * How many files one archive may hold.
 *
 * The gallery is a board the user picks from by hand, so this is a guard
 * against a crafted request rather than a limit anyone reaches by selecting.
 */
const MAX_ZIP_ENTRIES = 500

/**
 * Read the requested names out of a parsed `POST /comfy-zip` body.
 *
 * Every name is checked as a basename: the archive reads straight out of the
 * output directory, so a name that escapes it must not reach the file system.
 * Duplicates collapse — a ZIP with the same entry twice is what a double click
 * on one tile would otherwise produce.
 * @param parsed - the request body, as parsed JSON.
 * @returns the accepted names, or undefined when the body is not a usable list.
 */
export function parseZipNames(parsed: unknown): readonly string[] | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const names = (parsed as { names?: unknown }).names
  if (!Array.isArray(names) || names.length === 0 || names.length > MAX_ZIP_ENTRIES) return undefined
  const out: string[] = []
  for (const entry of names) {
    if (typeof entry !== 'string') return undefined
    const safe = safeBasename(entry)
    if (safe === undefined) return undefined
    if (!out.includes(safe)) out.push(safe)
  }
  return out
}

/**
 * The archive's filename, stamped with the day it was made.
 * @param now - the moment the request arrived.
 * @returns a filename for Content-Disposition.
 */
function zipFilename(now: Date): string {
  const stamp = `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return `imagine-${stamp}.zip`
}

/**
 * Stream the named files into the response as one ZIP.
 *
 * A name with no file behind it is skipped rather than failing the archive:
 * the selection is a client-side list that a delete elsewhere can outdate, and
 * losing one entry beats losing the download. The headers go out before the
 * first byte is read, so a read that fails mid-archive can only end the
 * response — the status is already sent.
 * @param outputDir - the validated media output directory.
 * @param names - already-validated basenames.
 * @param res - the response to stream into.
 * @param now - the moment the request arrived, for the filename.
 * @returns when the archive has been written.
 */
export async function streamMediaZip(
  outputDir: string,
  names: readonly string[],
  res: ServerResponse,
  now: Date = new Date(),
  options: { readonly entries?: readonly string[]; readonly filename?: string } = {},
): Promise<void> {
  const found = await mapWithConcurrency(names, 16, async name => (await stat(join(outputDir, name))).isFile())
  const present = names.filter((_name, index) => found[index] === true)
  // The name inside the archive: the file's own unless the caller gave one per file.
  const entryOf = new Map(names.map((name, index) => [name, options.entries?.[index] ?? name]))
  if (present.length === 0) {
    sendJson(res, 404, { error: message('zip.noneLeft') })
    return
  }
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${options.filename ?? zipFilename(now)}"`,
    'cache-control': 'no-store',
  })
  /*
   * The archive follows the client's pace: a chunk the socket would not take
   * pauses the file reads until it drains, so a slow download of many clips
   * is not held in memory, and a closed download stops the reads.
   */
  let closed = false
  const closing = once(res, 'close').then(() => { closed = true }, () => { closed = true })
  let draining: Promise<void> | undefined
  await new Promise<void>((resolve, reject) => {
    const zip = new Zip((error, chunk, final) => {
      if (error !== null) {
        reject(error)
        return
      }
      if (!res.write(chunk) && draining === undefined) {
        draining = once(res, 'drain').then(() => { draining = undefined }, () => { draining = undefined })
      }
      if (final) {
        res.end()
        resolve()
      }
    })
    void (async () => {
      try {
        for (const name of present) {
          if (closed) break
          const entry = new ZipPassThrough(entryOf.get(name) ?? name)
          zip.add(entry)
          for await (const chunk of createReadStream(join(outputDir, name))) {
            if (closed) break
            entry.push(chunk as Uint8Array, false)
            if (draining !== undefined) await Promise.race([draining, closing])
          }
          entry.push(new Uint8Array(0), true)
        }
        if (closed) {
          resolve()
          return
        }
        zip.end()
      } catch (error: unknown) {
        // A read that fails after its own stat succeeded: a delete landing mid-archive.
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })()
  })
}
