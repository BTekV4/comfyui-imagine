/**
 * «Remove object»: the photo and the painted mask (white where to remove,
 * at the photo's own size, as the dialog paints it) go to IOPaint's
 * /api/v1/inpaint, which answers the photo with the zone filled in and in the
 * photo's own format. About 7-15 s for 1080×1920 on a CPU (LaMa, 2026-10-18).
 * Like the studio's other still edits, it writes a new gallery file beside
 * the original and never touches it.
 * @module iopaint/erase
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { message } from '../../../server/src/messages.ts'
import { galleryEditRoute, galleryName, HttpError, stamp, stem } from '../../../server/src/route-kit.ts'
import type { Handler } from '../../../server/src/host.ts'

/** IOPaint's answer types, to the gallery extension the file is saved with. */
const ERASED_EXT: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp' }

/**
 * The route of «Remove object».
 * @param outputDir - the gallery's folder.
 * @param iopaintUrl - IOPaint's address, read at every call.
 * @returns the handler.
 */
export function createEraseRoute(outputDir: string, iopaintUrl: () => string): Handler {
  return galleryEditRoute(outputDir, {
    failure: { status: 502, what: 'still.iopaintUnreachable' },
    async run(body) {
      const name = galleryName(body['name'], 'image')
      const mask = typeof body['mask'] === 'string' ? /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(body['mask'])?.[1] : undefined
      if (name === undefined) throw new HttpError(400, message('still.photoRequired'))
      if (mask === undefined) throw new HttpError(400, message('still.maskMissing'))
      const image = (await readFile(join(outputDir, name))).toString('base64')
      const answer = await fetch(`${iopaintUrl().replace(/\/+$/, '')}/api/v1/inpaint`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image, mask }),
        signal: AbortSignal.timeout(300_000),
      })
      if (!answer.ok) {
        const text = await answer.text()
        let detail = text
        try { detail = String((JSON.parse(text) as { detail?: unknown }).detail ?? text) } catch { /* not JSON: the text as it is */ }
        throw new HttpError(502, message('still.iopaintAnswered', { status: answer.status, detail: detail.slice(0, 300) }))
      }
      const ext = ERASED_EXT[(answer.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''] ?? 'png'
      const output = `erase_image-${stem(name)}-${stamp()}.${ext}`
      await writeFile(join(outputDir, output), Buffer.from(await answer.arrayBuffer()))
      return { output, origin: { action: 'erase', prompt: message('origin.erase'), source: name } }
    },
  })
}
