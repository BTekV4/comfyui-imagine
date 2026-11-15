/**
 * Tags of All media ("Tutti i media"), as Grok Imagine has (read off
 * /imagine/saved 2026-10-18): named sets of files the user makes with
 * "New Tag" ("Nuovo Tag") and fills from the selection's "Add to Tag"
 * ("Aggiungi al Tag"). One JSON list beside the studio's data, like the
 * likes; a name whose file is gone is dropped on read.
 */
import { message } from './messages.ts'
import { randomUUID } from 'node:crypto'
import type { Handler } from './host.ts'
import { jsonList } from './json-list.ts'
import { mediaNames, presentNames } from './media-names.ts'
import { methods, readObject, sendJson } from './route-kit.ts'
import type { MediaTag } from '../../shared/imagine-types.ts'

const NAME_MAX = 60

const tagName = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const name = value.trim().replace(/\s+/g, ' ').slice(0, NAME_MAX)
  return name === '' ? undefined : name
}

/** The stored tags that are well formed, each with only its present files. */
const tagsOf = (entries: readonly unknown[], present: ReadonlySet<string>): MediaTag[] => entries.flatMap((entry: unknown) => {
  const raw = (entry ?? {}) as { id?: unknown; name?: unknown; names?: unknown }
  const name = tagName(raw.name)
  return typeof raw.id === 'string' && name !== undefined ? [{ id: raw.id, name, names: presentNames(raw.names, present) }] : []
})

/** One change: answered status and body, and the tags to save when they moved. */
type Outcome = { readonly answer: readonly [number, Record<string, unknown>]; readonly next?: readonly MediaTag[] }

function change(body: { action?: unknown; id?: unknown; name?: unknown; names?: unknown }, tags: MediaTag[], present: ReadonlySet<string>): Outcome {
  const names = presentNames(body.names, present)
  const index = tags.findIndex(tag => tag.id === body.id)
  const current = tags[index]
  switch (body.action) {
    case 'create': {
      const name = tagName(body.name)
      if (name === undefined) return { answer: [400, { error: message('tag.nameRequired') }] }
      const id = randomUUID()
      tags.push({ id, name, names })
      return { answer: [200, { tags, id }], next: tags }
    }
    case 'add':
    case 'remove': {
      if (current === undefined) return { answer: [404, { error: message('tag.notFound') }] }
      const picked = new Set(names)
      const rest = current.names.filter(name => !picked.has(name))
      tags[index] = { ...current, names: body.action === 'add' ? [...names, ...rest] : rest }
      break
    }
    case 'rename': {
      const name = tagName(body.name)
      if (current === undefined) return { answer: [404, { error: message('tag.notFound') }] }
      if (name === undefined) return { answer: [400, { error: message('tag.nameRequired') }] }
      tags[index] = { ...current, name }
      break
    }
    case 'delete': {
      if (current === undefined) return { answer: [404, { error: message('tag.notFound') }] }
      tags.splice(index, 1)
      break
    }
    default:
      return { answer: [400, { error: message('tag.unknownAction') }] }
  }
  return { answer: [200, { tags }], next: tags }
}

export function createTagsRoute(file: string, outputDir: string): Handler {
  const list = jsonList(file)
  return methods({
    GET: async (_req, res) => { sendJson(res, 200, { tags: tagsOf(await list.read(), await mediaNames(outputDir)) }) },
    POST: async (req, res) => {
      const body = await readObject<{ action?: unknown; id?: unknown; name?: unknown; names?: unknown }>(req)
      const [status, answer] = await list.update(async entries => {
        const present = await mediaNames(outputDir)
        return change(body, tagsOf(entries, present), present)
      })
      sendJson(res, status, answer)
    },
  })
}
