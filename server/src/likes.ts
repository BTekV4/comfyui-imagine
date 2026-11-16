/**
 * Likes on gallery files, for the Liked tab of All media, as Grok Imagine
 * has (2026-10-17). One JSON
 * list of names beside the studio's data; a name whose file is gone is
 * dropped the next time the list is read.
 */
import { safeBasename } from '../vendor/tool-comfy/gallery.ts'
import type { Handler } from './host.ts'
import { jsonList } from './json-list.ts'
import { message } from './messages.ts'
import { mediaNames, presentNames } from './media-names.ts'
import { methods, readObject, sendJson } from './route-kit.ts'

export function createLikesRoute(file: string, outputDir: string): Handler {
  const list = jsonList(file)
  const present = async (entries: readonly unknown[]): Promise<string[]> => presentNames(entries, await mediaNames(outputDir))
  return methods({
    GET: async (_req, res) => { sendJson(res, 200, { names: await present(await list.read()) }) },
    POST: async (req, res) => {
      // One file from the viewer's heart, or several from the selection's
      // "Add to Tag" → Liked.
      const body = await readObject<{ name?: unknown; names?: unknown; liked?: unknown }>(req)
      const asked = Array.isArray(body.names) ? body.names : [body.name]
      const chosen = asked.flatMap(entry => {
        const name = typeof entry === 'string' ? safeBasename(entry) : undefined
        return name === undefined ? [] : [name]
      })
      if (chosen.length === 0 || typeof body.liked !== 'boolean') return sendJson(res, 400, { error: message('like.required') })
      const liked = body.liked
      const names = await list.update(async entries => {
        const kept = new Set(chosen)
        const next = (await present(entries)).filter(entry => !kept.has(entry))
        if (liked) next.unshift(...chosen)
        return { answer: next, next }
      })
      sendJson(res, 200, { names })
    },
  })
}
