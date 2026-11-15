/**
 * The routes of the workflows the user added: `/comfy-custom-workflows`
 * (list, save, remove, graph, LoRAs, node options) and `/comfy-custom-cover`.
 *
 * Split out of `index.ts` on 2026-11-07. A LoRA edit here goes through the
 * same graph editor as the settings page's (`workflow-inventory.ts`), so a
 * `config.yaml` row reading the same `custom:<id>` graph sees it too.
 * @module tool-comfy/custom-workflow-routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ImagineHost } from '../../src/host.ts'
import { message } from '../../src/messages.ts'
import { allowOnly, notAllowed, rangeOf, readObject, restOf, sendJson } from '../../src/route-kit.ts'
import { coverTypeOfBytes } from '../../../shared/cover-kinds.ts'
import {
  customGraphFile, customKey, listCustomWorkflows, readCustomCover, readCustomGraph, removeCustomWorkflow,
  eitherOf, saveCustomWorkflow, type CustomInput,
} from './custom-workflows.ts'
import { insertLora, listLoras, loraStrength, removeLora, setLoraStrength } from './lora.ts'
import type { GraphEditor } from './workflow-inventory.ts'

/**
 * GET lists the uploaded workflows, POST adds or replaces one, DELETE removes.
 *
 * A save or a delete reloads the map the runner reads, so the card works at
 * once: waiting for a restart to see an upload is not a workflow anybody keeps.
 * @param ctx - plugin context, for the node options ComfyUI reports.
 * @param refresh - reloads the custom cards into the running workflows map.
 * @param editor - the graph-edit step shared with the settings page.
 * @returns the route handler.
 */
export function customWorkflowsHandler(
  ctx: ImagineHost,
  refresh: () => Promise<void>,
  editor: GraphEditor,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const rest = restOf(req, res, '/comfy-custom-workflows')
    if (rest === undefined) return
    // The collection only: `/<id>/loras` and `/<id>/options` are below.
    if ((req.method === 'GET' || req.method === 'HEAD') && rest === '') {
      sendJson(res, 200, { workflows: await listCustomWorkflows() })
      return
    }
    if (req.method === 'POST' && rest === '') {
      try {
        const asked = await readObject<Record<string, unknown>>(req, 16 * 1024 * 1024)
        const text = (name: string): string => typeof asked[name] === 'string' ? asked[name] as string : ''
        const either = eitherOf(asked.either)
        const meta = await saveCustomWorkflow({
          title: text('title'),
          description: text('description'),
          graph: asked.graph,
          output: asked.output === 'video' ? 'video' : 'image',
          outputExt: text('outputExt') === '' ? 'png' : text('outputExt'),
          promptNodeId: text('promptNodeId'),
          promptField: text('promptField'),
          seedNodeId: text('seedNodeId'),
          seedField: text('seedField'),
          imageNodeId: text('imageNodeId'),
          ...either === undefined ? {} : { either },
          ...typeof asked.batchControl === 'object' && asked.batchControl !== null
            && typeof (asked.batchControl as { node?: unknown }).node === 'string'
            && typeof (asked.batchControl as { field?: unknown }).field === 'string'
            ? { batchControl: asked.batchControl as { node: string; field: string } }
            : {},
          ...typeof asked.cover === 'string' && asked.cover !== '' ? { cover: asked.cover } : {},
          // The exposed inputs: which controls the card shows.
          ...Array.isArray(asked.inputs)
            ? {
              inputs: (asked.inputs as unknown[])
                .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
                .map(entry => ({
                  node: typeof entry.node === 'string' ? entry.node : '',
                  field: typeof entry.field === 'string' ? entry.field : '',
                  label: typeof entry.label === 'string' ? entry.label : '',
                  kind: (entry.kind === 'number' || entry.kind === 'boolean' || entry.kind === 'frame' ? entry.kind : 'text') as CustomInput['kind'],
                  ...typeof entry.value === 'string' || typeof entry.value === 'number' || typeof entry.value === 'boolean'
                    ? { value: entry.value }
                    : {},
                }))
                .filter(entry => entry.node !== '' && entry.field !== '' && entry.label !== ''),
            }
            : {},
        }, {
          // Only ComfyUI knows the batch field's values: the save needs them
          // to refuse a field that has just one.
          batchValues: async (classType, field) => (await ctx.comfy.nodeOptions(classType, field)) ?? [],
        })
        await refresh()
        /*
         * An upload replaces the graph of a card that may also be a configured
         * row's `custom:<id>`: that row's loaded copy follows it, as it does
         * for a LoRA edit.
         */
        const stored = await readCustomGraph(meta.id)
        const file = customGraphFile(customKey(meta.id))
        if (stored !== undefined && file !== undefined) editor.adopt(file, stored)
        sendJson(res, 200, { workflow: meta })
      } catch (error: unknown) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    const parts = rest.split('/')
    const id = parts[0] ?? ''
    /*
     * `GET /<id>/graph` hands the graph to the card, which derives its slots
     * and panel options from it: without it the panel would have to know by
     * heart the shape of a workflow it has never seen.
     */
    if ((req.method === 'GET' || req.method === 'HEAD') && parts.length === 2 && parts[1] === 'graph') {
      const graph = await readCustomGraph(id)
      if (graph === undefined) {
        sendJson(res, 404, { error: message('workflow.unknown') })
        return
      }
      sendJson(res, 200, { graph })
      return
    }
    /*
     * `/<id>/loras` adds one, `/<id>/loras/<node>` removes one, and
     * `/<id>/options` reports what a node input accepts — the LoRA names come
     * from ComfyUI, which is the only place that knows what is installed.
     */
    if (parts.length >= 2 && parts[1] === 'options') {
      const url = new URL(req.url ?? '/', 'http://x')
      const field = url.searchParams.get('field') ?? ''
      const askedClass = url.searchParams.get('class') ?? ''
      const nodeId = url.searchParams.get('node') ?? ''
      /*
       * Either the caller names the class (a LoRA node that is not in the graph
       * yet) or it names a node of this workflow, whose class is read here: a
       * card knows its inputs by node id, never by class.
       */
      let classType = askedClass
      if (classType === '' && nodeId !== '') {
        const graph = await readCustomGraph(id)
        classType = graph?.[nodeId]?.class_type ?? ''
      }
      if (classType === '' || field === '') {
        sendJson(res, 400, { error: message('workflow.classNodeField') })
        return
      }
      try {
        sendJson(res, 200, { options: await ctx.comfy.nodeOptions(classType, field) ?? [] })
      } catch (error: unknown) {
        sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    if (parts.length >= 2 && parts[1] === 'loras') {
      const graph = await readCustomGraph(id)
      const file = customGraphFile(customKey(id))
      if (graph === undefined || file === undefined) {
        sendJson(res, 404, { error: message('workflow.unknown') })
        return
      }
      try {
        if (req.method === 'GET' || req.method === 'HEAD') {
          sendJson(res, 200, { loras: listLoras(graph) })
          return
        }
        /*
         * The three edits go through the shared editor: it reads the graph
         * again inside the file's queue, checks the links, keeps a backup and
         * updates every loaded copy — this card's and any configured row's.
         */
        if (req.method === 'POST' && parts.length === 2) {
          const asked = await readObject<Record<string, unknown>>(req, 64 * 1024)
          let node = ''
          const done = await editor.edit(file, (stored) => {
            const next = insertLora(stored, {
              loraName: typeof asked.loraName === 'string' ? asked.loraName : '',
              strength: loraStrength(asked.strength, 1),
            })
            node = next.node
            return next.graph
          })
          sendJson(res, 200, { loras: listLoras(done.graph), node })
          return
        }
        if ((req.method === 'PATCH' || req.method === 'PUT') && parts.length === 3) {
          const asked = await readObject<{ strength?: unknown }>(req, 64 * 1024)
          const strength = loraStrength(asked.strength, Number.NaN)
          const done = await editor.edit(file, stored => setLoraStrength(stored, parts[2] ?? '', strength))
          sendJson(res, 200, { loras: listLoras(done.graph) })
          return
        }
        if (req.method === 'DELETE' && parts.length === 3) {
          const done = await editor.edit(file, stored => removeLora(stored, parts[2] ?? ''))
          sendJson(res, 200, { loras: listLoras(done.graph) })
          return
        }
        notAllowed(res, 'GET, HEAD, POST, DELETE')
      } catch (error: unknown) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    if (req.method === 'DELETE' && rest !== '') {
      const removed = await removeCustomWorkflow(rest)
      if (removed) await refresh()
      sendJson(res, removed ? 200 : 404, { ok: removed })
      return
    }
    notAllowed(res, 'GET, HEAD, POST, DELETE')
  }
}

/**
 * One workflow's cover, as the image (or the short clip) the card shows.
 *
 * The type is read from the bytes: a cover uploaded before 2026-11-04 said
 * nothing about it, and the type cannot be the fixed one used before — an mp4
 * served as `image/webp` does not play.
 * @returns the route handler.
 */
export function customCoverHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!allowOnly(req, res, 'GET', 'HEAD')) return
    const id = restOf(req, res, '/comfy-custom-cover')
    if (id === undefined) return
    const bytes = await readCustomCover(id)
    if (bytes === undefined) {
      sendJson(res, 404, { error: message('cover.none') })
      return
    }
    const type = coverTypeOfBytes(bytes)
    const headers: Record<string, string> = {
      'content-type': type?.mime ?? 'image/webp',
      'cache-control': 'no-store',
      'accept-ranges': 'bytes',
    }
    /*
     * A clip on a card is watched from the middle too: the player asks for a
     * byte range, and a 200 with the whole file makes it download instead of
     * starting.
     */
    const range = rangeOf(req.headers.range, bytes.byteLength)
    if (range === 'invalid') {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${String(bytes.byteLength)}` }).end()
      return
    }
    if (range !== undefined) {
      const part = bytes.subarray(range.start, range.end + 1)
      res.writeHead(206, {
        ...headers,
        'content-range': `bytes ${String(range.start)}-${String(range.end)}/${String(bytes.byteLength)}`,
        'content-length': String(part.byteLength),
      })
      res.end(req.method === 'HEAD' ? undefined : part)
      return
    }
    res.writeHead(200, { ...headers, 'content-length': String(bytes.byteLength) })
    res.end(req.method === 'HEAD' ? undefined : bytes)
  }
}
