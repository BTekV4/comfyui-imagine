/**
 * Workflows the user added, as opposed to the ones the deployment ships.
 *
 * A graph is a file, and a graph nobody expected should not need a code change
 * and a restart of the studio to run. These live under `<data>/custom-workflows/
 * <id>/` — `meta.json`, `graph.json`, `cover.bin` — so they survive an update
 * of the repo and never enter it.
 *
 * At boot they are loaded into the same map the configured graphs sit in, under
 * the synthetic name `custom:<id>`, which is what lets the job runner treat one
 * like any other action: the pins in `meta.json` say which node takes the
 * prompt, the seed and the image, and the rest is the generic path.
 * @module tool-comfy/custom-workflows
 */

import { randomUUID } from 'node:crypto'
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { serialized, writeFileAtomic } from '../atomic-write/index.ts'
import { dataPath } from '../home-paths/index.ts'
import { coverTypeOfBytes } from '../../../shared/cover-kinds.ts'
import type { CustomEither, CustomInput, CustomWorkflowMeta } from '../../../shared/custom-workflows.ts'
import type { ComfyGraph } from '../comfyui/index.ts'
import type { LoadedWorkflow } from './index.ts'
import { message } from '../../src/messages.ts'
import { isPlainObject } from './guards.ts'

/*
 * The workflow as the host reports it is the page's type too: it lives in
 * `shared/custom-workflows.ts`, re-exported here for the server's importers.
 */
export type { CustomEither, CustomInput, CustomWorkflowMeta } from '../../../shared/custom-workflows.ts'

/** The prefix every custom graph is keyed by in the workflows map. */
const CUSTOM_PREFIX = 'custom:'

/** Where one workflow's files live. */
function customDir(id: string): string {
  return join(dataPath('custom-workflows'), id)
}

/** The key a custom workflow is loaded under. */
export function customKey(id: string): string {
  return `${CUSTOM_PREFIX}${id}`
}

/** Accept only ids this module wrote: they are a path segment. */
function isCustomId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
}

/**
 * Whether a workflow path is the virtual `custom:<id>` form rather than a file.
 *
 * Only the prefix is looked at: the config anchoring needs to leave every such
 * value verbatim, a malformed id included, so the loader is the one that
 * refuses it with a message instead of the boot reading a file named after it.
 * @param path - the path as the configuration writes it.
 * @returns true for any `custom:` path.
 */
export function isCustomPath(path: string): boolean {
  return path.startsWith(CUSTOM_PREFIX)
}

/**
 * The graph file behind a `custom:<id>` path (or a workflows-map key, which
 * has the same shape).
 *
 * The id has to be one this module mints: it becomes a path segment, and
 * `custom:../x` would otherwise resolve outside the custom-workflows folder.
 * @param path - the path or key.
 * @returns `<data>/custom-workflows/<id>/graph.json`, or undefined when the
 *   value is not a `custom:` path with a valid id.
 */
export function customGraphFile(path: string): string | undefined {
  if (!isCustomPath(path)) return undefined
  const id = path.slice(CUSTOM_PREFIX.length)
  return isCustomId(id) ? join(customDir(id), 'graph.json') : undefined
}

/**
 * Write one JSON file of a workflow folder by rename, so a reader (the boot,
 * the card list) never sees half a graph.
 * @param path - the file.
 * @param value - what to store.
 * @param indent - the indentation the file is kept at.
 */
async function writeCustomJson(path: string, value: unknown, indent: number): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, indent)}\n`, { mode: 0o644 })
}

/**
 * A card's steps, when the meta declares them.
 *
 * Only the shape is checked here: the node may no longer exist, because a
 * card's graph can be re-uploaded, and whatever writes into the graph already
 * tolerates a missing node instead of failing the run. The check against the
 * graph is done by {@link validSteps}, on save.
 * @param raw - the meta read from disk.
 * @returns the three values, or undefined when absent or malformed.
 */
function stepsOf(raw: Partial<CustomWorkflowMeta>): CustomWorkflowMeta['steps'] {
  const steps = raw.steps
  if (steps === null || typeof steps !== 'object') return undefined
  const { nodeId, field, high } = steps as { nodeId?: unknown; field?: unknown; high?: unknown }
  if (typeof nodeId !== 'string' || nodeId.length === 0) return undefined
  if (typeof field !== 'string' || field.length === 0) return undefined
  if (typeof high !== 'number' || !Number.isFinite(high) || high < 1) return undefined
  return { nodeId, field, high: Math.round(high) }
}

/**
 * A card's steps, kept only if the graph really has that node with a numeric
 * field: a pin pointing at nothing would make the save a silent no-op, and
 * «Quality» inert again without anyone saying so.
 * @param graph - the graph just saved.
 * @param steps - the declared steps, already cleaned.
 * @returns the same steps, or undefined when the graph cannot hold them.
 */
function validSteps(graph: ComfyGraph, steps: CustomWorkflowMeta['steps']): CustomWorkflowMeta['steps'] {
  if (steps === undefined) return undefined
  const node = graph[steps.nodeId] as { inputs?: Record<string, unknown> } | undefined
  if (node?.inputs === undefined || typeof node.inputs[steps.field] !== 'number') return undefined
  return steps
}

/**
 * What the two loaders below share — they differ only in reading the files
 * synchronously or not.
 *
 * `meta` turns the text of `meta.json` into the card, or undefined when it
 * does not describe one; `graph` turns the text of `graph.json` into the graph
 * the workflows map holds. `failed` decides what a failed read or parse means:
 * no `meta.json` (a folder with only `graph.json` is a personal workflow
 * addressed by the config, `path: custom:<id>`, not a broken upload) or no
 * folder at all is not a card, and must not clutter the journal at every
 * start; anything else is a card skipped and said, because one bad upload
 * must not stop the studio.
 */
const CARD = {
  meta: (id: string, text: string): CustomWorkflowMeta | undefined => metaOf(id, JSON.parse(text)),
  graph: (meta: CustomWorkflowMeta, text: string): LoadedWorkflow => asLoaded(meta, JSON.parse(text) as ComfyGraph),
  failed: (id: string, error: unknown, reading: 'meta' | 'graph'): void => {
    const code = (error as { code?: unknown }).code
    if (reading === 'meta' && (code === 'ENOENT' || code === 'ENOTDIR')) return
    console.warn(`[imagine] workflow ${id} ignored: ${String(error)}`)
  },
}

/**
 * The same map, read synchronously, for the boot.
 *
 * `apply()` is synchronous — it is called while the host is still starting and
 * its return value is the media directory — so the graphs it merges in cannot
 * be awaited. One sync read of a handful of small files at startup is cheaper
 * than making the whole boot path async.
 * @returns the graphs by key.
 */
export function loadCustomWorkflowsSync(): Record<string, LoadedWorkflow> {
  let ids: string[]
  try {
    ids = readdirSync(dataPath('custom-workflows'))
  } catch {
    return {}
  }
  const out: Record<string, LoadedWorkflow> = {}
  for (const id of ids.filter(isCustomId)) {
    const dir = customDir(id)
    let meta: CustomWorkflowMeta | undefined
    try {
      meta = CARD.meta(id, readFileSync(join(dir, 'meta.json'), 'utf8'))
    } catch (error: unknown) {
      CARD.failed(id, error, 'meta')
    }
    if (meta === undefined) continue
    try {
      out[customKey(id)] = CARD.graph(meta, readFileSync(join(dir, 'graph.json'), 'utf8'))
    } catch (error: unknown) {
      CARD.failed(id, error, 'graph')
    }
  }
  return out
}

/**
 * The clip-or-photo block of a card's meta, checked field by field.
 *
 * Two slots and one switch: anything else is a meta file that a hand edit or an
 * old save left half-written, and the card simply runs without the pair — the
 * panel then asks for the one file the graph names.
 * @param raw - the meta's `either`, as read from disk or sent by the form.
 * @returns the block, or undefined when it is not one.
 */
export function eitherOf(raw: unknown): CustomEither | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const slots = (raw as { slots?: unknown }).slots
  const source = (raw as { switch?: unknown }).switch
  if (!Array.isArray(slots) || slots.length !== 2 || !slots.every(entry => typeof entry === 'string')) return undefined
  if (typeof source !== 'object' || source === null) return undefined
  const node = (source as { node?: unknown }).node
  const field = (source as { field?: unknown }).field
  const video = (source as { video?: unknown }).video
  if (typeof node !== 'string' || node.length === 0) return undefined
  if (typeof field !== 'string' || field.length === 0) return undefined
  if (typeof video !== 'string' || !slots.includes(video)) return undefined
  return { slots: slots as readonly string[], switch: { node, field, video } }
}

/**
 * The batch control of a card («all the poses»): a node and one of its fields.
 *
 * The form's save and the meta's read checked the same shape each on its own.
 * @param raw - the value as sent by the form or read from `meta.json`.
 * @returns the control, or undefined when it is not one.
 */
export function batchControlOf(raw: unknown): { readonly node: string; readonly field: string } | undefined {
  if (!isPlainObject(raw)) return undefined
  const { node, field } = raw
  return typeof node === 'string' && typeof field === 'string' ? { node, field } : undefined
}

/**
 * One workflow's meta from the parsed `meta.json`, with every field checked.
 *
 * The boot and the card list read the same file; until 2026-11-07 each had
 * its own copy of this, and the boot's had already lost `coverKind`.
 * @param id - the workflow's id (the folder name, not the file's word for it).
 * @param parsed - the file's parsed content.
 * @returns the meta, or undefined when the file does not describe a card.
 */
function metaOf(id: string, parsed: unknown): CustomWorkflowMeta | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const raw = parsed as Partial<CustomWorkflowMeta>
  if (typeof raw.title !== 'string' || raw.title.length === 0) return undefined
  const steps = stepsOf(raw)
  const either = eitherOf(raw.either)
  const batchControl = batchControlOf(raw.batchControl)
  return {
    id,
    title: raw.title,
    description: typeof raw.description === 'string' ? raw.description : '',
    output: raw.output === 'video' ? 'video' : 'image',
    outputExt: typeof raw.outputExt === 'string' && raw.outputExt.length > 0 ? raw.outputExt : 'png',
    ...raw.promptNodeId === undefined ? {} : { promptNodeId: raw.promptNodeId },
    ...typeof raw.promptField === 'string' && raw.promptField.length > 0 ? { promptField: raw.promptField } : {},
    ...raw.seedNodeId === undefined ? {} : { seedNodeId: raw.seedNodeId },
    ...typeof raw.seedField === 'string' && raw.seedField.length > 0 ? { seedField: raw.seedField } : {},
    ...batchControl === undefined ? {} : { batchControl },
    ...raw.imageNodeId === undefined ? {} : { imageNodeId: raw.imageNodeId },
    ...either === undefined ? {} : { either },
    inputs: Array.isArray(raw.inputs) ? raw.inputs.filter((entry): entry is CustomInput => typeof entry === 'object' && entry !== null && typeof (entry as CustomInput).node === 'string' && typeof (entry as CustomInput).field === 'string') : [],
    hasCover: raw.hasCover === true,
    ...steps === undefined ? {} : { steps },
    ...raw.coverKind === 'image' || raw.coverKind === 'video' ? { coverKind: raw.coverKind } : {},
  }
}

/**
 * The metas already read, by id, with the size and mtime of the `meta.json`
 * they were read from.
 *
 * The card list, every save (which looks for a card with the same title) and
 * every removal read all the metas, and an old card's cover was read whole each
 * time to learn its type. A save rewrites `meta.json`, which changes its
 * stamp; it also drops the entry, and so does a removal.
 */
const metaCache = new Map<string, { readonly size: number; readonly mtimeMs: number; readonly meta: CustomWorkflowMeta | undefined }>()

/**
 * Read one workflow's `meta.json`, from {@link metaCache} while the file is unchanged.
 * @param id - the workflow's id.
 * @returns the meta, or undefined when the folder is not a workflow.
 */
async function readMeta(id: string): Promise<CustomWorkflowMeta | undefined> {
  const file = join(customDir(id), 'meta.json')
  const info = await stat(file).catch(() => undefined)
  if (info === undefined) {
    metaCache.delete(id)
    return undefined
  }
  const known = metaCache.get(id)
  if (known !== undefined && known.size === info.size && known.mtimeMs === info.mtimeMs) return known.meta
  const meta = await readMetaFile(id, file)
  metaCache.set(id, { size: info.size, mtimeMs: info.mtimeMs, meta })
  return meta
}

/** One `meta.json` read and checked, with the type of an old card's cover. */
async function readMetaFile(id: string, file: string): Promise<CustomWorkflowMeta | undefined> {
  try {
    const meta = metaOf(id, JSON.parse(await readFile(file, 'utf8')))
    if (meta === undefined) return undefined
    if (meta.hasCover && meta.coverKind === undefined) {
      /*
       * A cover uploaded before 4-11-2026 did not say what type it was: it is
       * recognised from its bytes, so the card knows whether it is an image or
       * a clip to play (and it need not be re-uploaded).
       */
      const bytes = await readCustomCover(id)
      const type = bytes === undefined ? undefined : coverTypeOfBytes(bytes)
      if (type !== undefined) return { ...meta, coverKind: type.kind }
    }
    return meta
  } catch {
    return undefined
  }
}

/**
 * Every workflow the user added, newest title order left to the caller.
 * @returns the metas of the folders that hold one.
 */
export async function listCustomWorkflows(): Promise<readonly CustomWorkflowMeta[]> {
  let ids: string[]
  try {
    ids = await readdir(dataPath('custom-workflows'))
  } catch {
    return []
  }
  const metas = await Promise.all(ids.filter(isCustomId).map(id => readMeta(id)))
  return metas.filter((meta): meta is CustomWorkflowMeta => meta !== undefined)
}

/** A graph as the studio keeps it: the pins it was given, over the file's own values. */
function asLoaded(meta: CustomWorkflowMeta, graph: ComfyGraph): LoadedWorkflow {
  return {
    graph,
    outputExt: meta.outputExt,
    ...meta.steps === undefined ? {} : { steps: meta.steps },
    ...meta.promptNodeId === undefined ? {} : { promptNodeId: meta.promptNodeId },
    ...meta.promptField === undefined ? {} : { promptField: meta.promptField },
    ...meta.batchControl === undefined ? {} : { batchControl: meta.batchControl },
    ...meta.seedNodeId === undefined ? {} : { seedNodeId: meta.seedNodeId },
    ...meta.seedField === undefined ? {} : { seedField: meta.seedField },
    ...meta.imageNodeId === undefined ? {} : { imageNodeId: meta.imageNodeId },
    // Read by the runner to decide what the produced file is.
    customOutput: meta.output,
  } as LoadedWorkflow
}

/**
 * Every custom graph, keyed by {@link customKey}, for the workflows map: the
 * boot's {@link loadCustomWorkflowsSync}, read without blocking.
 *
 * A folder whose meta or graph does not parse is skipped instead of thrown:
 * one bad upload must not stop the studio.
 * @returns the graphs by key.
 */
export async function loadCustomWorkflows(): Promise<Record<string, LoadedWorkflow>> {
  let ids: string[]
  try {
    ids = await readdir(dataPath('custom-workflows'))
  } catch {
    return {}
  }
  const cards = await Promise.all(ids.filter(isCustomId).map(async (id) => {
    const loaded = await loadCustomWorkflow(id)
    return loaded === undefined ? [] : [[customKey(id), loaded] as const]
  }))
  return Object.fromEntries(cards.flat())
}

/**
 * One custom graph as the workflows map holds it, read without blocking.
 *
 * A save or a removal touches one card: reloading only that one spares the
 * parse of every other card's meta and graph (2026-11-15).
 * @param id - the card's id; one the studio did not mint reads as no card.
 * @returns the loaded workflow, or undefined when the folder holds no card
 *   or its files do not parse.
 */
export async function loadCustomWorkflow(id: string): Promise<LoadedWorkflow | undefined> {
  if (!isCustomId(id)) return undefined
  const dir = customDir(id)
  let meta: CustomWorkflowMeta | undefined
  try {
    meta = CARD.meta(id, await readFile(join(dir, 'meta.json'), 'utf8'))
  } catch (error: unknown) {
    CARD.failed(id, error, 'meta')
  }
  if (meta === undefined) return undefined
  try {
    return CARD.graph(meta, await readFile(join(dir, 'graph.json'), 'utf8'))
  } catch (error: unknown) {
    CARD.failed(id, error, 'graph')
    return undefined
  }
}

/** How many values a batch field has, asked of ComfyUI by the caller. */
interface CustomWorkflowSaveOptions {
  /**
   * The values the field accepts. The batch needs them: a field with a single
   * value is not a series, and a wrong name here would be an empty panel.
   */
  readonly batchValues?: (classType: string, field: string) => Promise<readonly string[]> | readonly string[]
}

/** What an upload hands over. */
interface CustomWorkflowInput {
  readonly title: string
  readonly description: string
  /** The graph, already parsed: ComfyUI's API format. */
  readonly graph: unknown
  readonly output: 'image' | 'video'
  readonly outputExt: string
  readonly promptNodeId?: string
  readonly promptField?: string
  readonly seedNodeId?: string
  readonly seedField?: string
  readonly imageNodeId?: string
  /** Two slots of which only one is given, and the switch that picks it. */
  readonly either?: CustomEither
  /** A control whose values become one run each («all the poses»). */
  readonly batchControl?: { readonly node: string; readonly field: string }
  /** The inputs to expose, in order. */
  readonly inputs?: readonly CustomInput[]
  /** A cover as a data URL, when one was uploaded. */
  readonly cover?: string
}

/**
 * Store a workflow, replacing the one with the same title.
 *
 * Same title means the same card: a user who uploads a corrected graph expects
 * to see one entry, not two.
 * @param input - the graph and what the user wrote about it.
 * @returns the stored meta.
 * @throws {Error} when the graph is not an API-format one, or a pin names a node it does not have.
 */
export async function saveCustomWorkflow(input: CustomWorkflowInput, options: CustomWorkflowSaveOptions = {}): Promise<CustomWorkflowMeta> {
  const title = input.title.trim()
  if (title.length === 0) throw new Error(message('workflow.titleRequired'))
  const graph = input.graph
  if (!isPlainObject(graph)) {
    throw new Error(message('graph.apiObject'))
  }
  /*
   * An API graph is an object `{ "12": { class_type, inputs }, ... }`. Two
   * other shapes arrive too, though, and an error "node id has no class_type"
   * tells nothing to whoever uploaded them: we recognise them here.
   */
  let nodes = graph as ComfyGraph
  const wrapped = ['prompt', 'graph', 'workflow', 'api'].find(key => isPlainObject(graph[key]))
  if (wrapped !== undefined && Object.values(nodes).every(entry => typeof (entry as { class_type?: unknown })?.class_type !== 'string')) {
    nodes = (graph as Record<string, ComfyGraph>)[wrapped] ?? nodes
  }
  if (Array.isArray((nodes as Record<string, unknown>).nodes)) {
    throw new Error(message('custom.editorFormat'))
  }
  const ids = new Set(Object.keys(nodes))
  if (ids.size === 0) throw new Error(message('graph.empty'))
  for (const [node, entry] of Object.entries(nodes)) {
    const shape = entry as { class_type?: unknown; inputs?: unknown }
    if (typeof shape?.class_type !== 'string') throw new Error(message('custom.nodeNoClass', { node }))
  }
  for (const entry of input.inputs ?? []) {
    const node = nodes[entry.node] as { inputs?: Record<string, unknown> } | undefined
    if (node === undefined) throw new Error(message('custom.inputMissingNode', { input: entry.label, node: entry.node }))
    if (node.inputs === undefined || !Object.hasOwn(node.inputs, entry.field)) {
      throw new Error(message('custom.inputMissingField', { input: entry.label, field: entry.field, node: entry.node }))
    }
  }
  for (const [field, value] of [['promptNodeId', input.promptNodeId], ['seedNodeId', input.seedNodeId], ['imageNodeId', input.imageNodeId]] as const) {
    if (value !== undefined && value !== '' && !ids.has(value)) {
      throw new Error(message('custom.pinMissingNode', { field, node: value }))
    }
  }
  /*
   * The prompt/seed field is validated against the node that receives it: a
   * wrong name here would be a job rejected by ComfyUI much later, when the
   * card is already in «Your workflows».
   */
  for (const [pin, key] of [['promptNodeId', input.promptField], ['seedNodeId', input.seedField]] as const) {
    if (key === undefined || key === '') continue
    const nodeId = input[pin]
    if (nodeId === undefined || nodeId === '') throw new Error(message('custom.fieldNeedsNode', { field: key, pin }))
    const node = nodes[nodeId] as { inputs?: Record<string, unknown> } | undefined
    if (node?.inputs === undefined || !Object.hasOwn(node.inputs, key)) {
      throw new Error(message('custom.fieldMissing', { field: key, node: nodeId }))
    }
  }

  if (input.batchControl !== undefined) {
    const batch = input.batchControl
    const node = nodes[batch.node] as { class_type?: unknown; inputs?: Record<string, unknown> } | undefined
    if (node === undefined) throw new Error(message('custom.batchMissingNode', { node: batch.node }))
    if (node.inputs === undefined || !Object.hasOwn(node.inputs, batch.field)) {
      throw new Error(message('custom.batchMissingField', { field: batch.field, node: batch.node }))
    }
    const values = await options.batchValues?.(String(node.class_type ?? ''), batch.field)
    if (values === undefined) throw new Error(message('custom.batchNoValues'))
    const real = values.filter(value => !value.trim().startsWith('('))
    if (real.length < 2) throw new Error(message('custom.batchTooFewValues', { field: batch.field, count: real.length }))
  }

  /*
   * The clip-or-photo pair: both nodes have to be there, and the switch has to
   * be a node that really takes that field — a wrong name would only surface
   * when the run is already queued.
   */
  const either = eitherOf(input.either)
  if (input.either !== undefined && either === undefined) throw new Error(message('custom.eitherMalformed'))
  if (either !== undefined) {
    for (const slot of either.slots) {
      if (!ids.has(slot)) throw new Error(message('custom.eitherMissingNode', { node: slot }))
    }
    const gate = nodes[either.switch.node] as { inputs?: Record<string, unknown> } | undefined
    if (gate?.inputs === undefined || !Object.hasOwn(gate.inputs, either.switch.field)) {
      throw new Error(message('custom.inputMissingField', { input: 'either', field: either.switch.field, node: either.switch.node }))
    }
  }

  /*
   * The title lookup and the id it settles on are one step: two saves of the
   * same title at once used to both find no card and mint two ids. So every
   * save queues on the folder that holds all the cards, and the writes inside
   * one card's folder on that folder too (see removeCustomWorkflow).
   */
  return serialized(dataPath('custom-workflows'), async () => {
    const existing = (await listCustomWorkflows()).find(meta => meta.title.toLowerCase() === title.toLowerCase())
    /*
     * The high-quality recipe survives a re-upload of the card: the module
     * reuses the folder when the title is the same and the meta is rewritten
     * from scratch — without this line a re-uploaded graph lost the pin and
     * «Quality» went back to doing nothing, silently.
     */
    const steps = validSteps(nodes, existing?.steps)
    const id = existing?.id ?? randomUUID()
    const dir = customDir(id)
    return serialized(dir, async () => {
      let hasCover = existing?.hasCover === true
      let coverKind = existing?.coverKind
      let cover: Buffer | undefined
      if (input.cover !== undefined) {
        /*
         * Since 4-11-2026 the cover can also be a short video (Grok animated
         * them): the content tells the type, not the data URL prefix, which
         * would lie for a renamed file.
         */
        const match = /^data:(?:image|video)\/[a-z0-9.+-]+;base64,(.+)$/s.exec(input.cover)
        if (match === null) throw new Error(message('custom.dataUrlRequired'))
        cover = Buffer.from(match[1] ?? '', 'base64')
        const type = coverTypeOfBytes(cover)
        if (type === undefined) throw new Error(message('cover.notMedia'))
        hasCover = true
        coverKind = type.kind
      }
      /*
       * The unwrapped nodes, not the upload: a graph sent as `{ prompt: {...} }`
       * was validated as its inner object but stored with the wrapper, and the
       * loader then read the wrapper as one node without a class.
       */
      // On the file's own queue too: that is the one the graph editor
      // (workflow-edit.ts) waits on, so a LoRA edit cannot write back the
      // graph this upload just replaced.
      const graphFile = join(dir, 'graph.json')
      await serialized(graphFile, () => writeCustomJson(graphFile, nodes, 1))
      // Bytes, so not through the text-only atomic writer; the meta that says
      // a cover exists is written after it.
      if (cover !== undefined) await writeFile(join(dir, 'cover.bin'), cover)
      const meta: CustomWorkflowMeta = {
        id,
        title,
        description: input.description.trim(),
        output: input.output,
        outputExt: input.outputExt,
        ...input.promptNodeId === undefined || input.promptNodeId === '' ? {} : { promptNodeId: input.promptNodeId },
        ...input.promptField === undefined || input.promptField === '' ? {} : { promptField: input.promptField },
        ...input.seedNodeId === undefined || input.seedNodeId === '' ? {} : { seedNodeId: input.seedNodeId },
        ...input.seedField === undefined || input.seedField === '' ? {} : { seedField: input.seedField },
        ...input.imageNodeId === undefined || input.imageNodeId === '' ? {} : { imageNodeId: input.imageNodeId },
        ...input.batchControl === undefined ? {} : { batchControl: input.batchControl },
        ...either === undefined ? {} : { either },
        ...steps === undefined ? {} : { steps },
        inputs: input.inputs ?? [],
        hasCover,
        ...coverKind === undefined ? {} : { coverKind },
      }
      await writeCustomJson(join(dir, 'meta.json'), meta, 2)
      metaCache.delete(id)
      return meta
    })
  })
}

/**
 * One workflow's graph, as stored.
 * @param id - the workflow's id.
 * @returns the graph, or undefined when the folder is not a workflow.
 */
export async function readCustomGraph(id: string): Promise<ComfyGraph | undefined> {
  if (!isCustomId(id)) return undefined
  try {
    return JSON.parse(await readFile(join(customDir(id), 'graph.json'), 'utf8')) as ComfyGraph
  } catch {
    return undefined
  }
}

/**
 * Delete a workflow and its files.
 * @param id - the workflow's id.
 * @returns true when something was there.
 */
export async function removeCustomWorkflow(id: string): Promise<boolean> {
  if (!isCustomId(id)) return false
  // Queued behind a save of the same card, so the save cannot recreate half
  // a folder that was just removed.
  return serialized(customDir(id), async () => {
    const meta = await readMeta(id)
    if (meta === undefined) return false
    await rm(customDir(id), { recursive: true, force: true })
    metaCache.delete(id)
    return true
  })
}

/**
 * One workflow's cover bytes.
 * @param id - the workflow's id.
 * @returns the bytes, or undefined when it has no cover.
 */
export async function readCustomCover(id: string): Promise<Buffer | undefined> {
  if (!isCustomId(id)) return undefined
  try {
    return await readFile(join(customDir(id), 'cover.bin'))
  } catch {
    return undefined
  }
}
