/**
 * "Dettagli" for one gallery file: how it was made (the run's action, the
 * user's words, the prompt the studio actually sent, the file it started
 * from, size and shape asked), what the vision model saw in it, and the
 * file's own facts. Everything already on disk — the job runner files it
 * when a run lands (imagine-notes.ts, written-prompts.ts) — but no route
 * served it until the canvas asked (2026-10-17).
 */
import { message } from './messages.ts'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { galleryItemOf, kindOf, safeBasename } from '../vendor/tool-comfy/gallery.ts'
import { recallNote } from '../vendor/tool-comfy/imagine-notes.ts'
import { recallWrittenPrompt } from '../vendor/tool-comfy/written-prompts.ts'
import { sendJson } from './route-kit.ts'

export function createDetailsRoute(outputDir: string) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const name = safeBasename(new URL(req.url ?? '/', 'http://x').searchParams.get('name') ?? '')
    const kind = name === undefined ? undefined : kindOf(name)
    if (name === undefined || kind === undefined) {
      sendJson(res, 400, { error: message('file.nameRequired') })
      return
    }
    const path = join(outputDir, name)
    let info
    try {
      info = await stat(path)
    } catch {
      sendJson(res, 404, { error: message('file.notFound') })
      return
    }
    const [item, note, written] = await Promise.all([
      // The listing's own entry: pixel size, length and the tool the name declares.
      galleryItemOf(outputDir, name, info).catch(() => undefined),
      recallNote(name).catch(() => undefined),
      recallWrittenPrompt(name).catch(() => undefined),
    ])
    sendJson(res, 200, {
      ...item ?? { name, kind, size: info.size, mtime: info.mtimeMs },
      ...note?.origin === undefined ? {} : { origin: note.origin },
      ...note?.sight === undefined ? {} : { sight: note.sight },
      ...written === undefined ? {} : { writtenPrompt: written },
    })
  }
}
