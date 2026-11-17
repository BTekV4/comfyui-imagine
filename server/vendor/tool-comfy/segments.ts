/**
 * «Segments»: cut a gallery photo into its parts and keep them.
 *
 * Three steps, the first two slow: the vision model lists what is in the
 * photo (segment-concepts.ts, about 50 s with the default model), the
 * `ImagineSegments` node on ComfyUI runs SAM 3 over that list (5-20 s), and
 * the masks, cut-outs and index it wrote to ComfyUI's temp folder are
 * downloaded under `<data>/comfy/segments/<photo>/`. A photo is analysed
 * once.
 *
 * As on Grok, a photo is analysed before anyone asks: every still a run
 * delivers joins a queue (`segmentSoon`, one analysis at a time, so the
 * card is not taken from the user's own runs for long), and opening the
 * panel on an older photo starts its analysis there and then. Either way the
 * request answers «running» at once and the page asks until it is ready.
 * @module tool-comfy/segments
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { renameWithRetry, rmWithRetry } from '../retry-fs/index.ts'
import { extname, join } from 'node:path'
import type { ImagineHost } from '../../src/host.ts'
import { message } from '../../src/messages.ts'
import { dataPath } from '../home-paths/index.ts'
import type { ComfyGraph } from '../comfyui/index.ts'
import { finite, isPlainObject, trimmedText } from './guards.ts'
import { conceptLines, lookForSegments } from './segment-concepts.ts'
import { ensureComfyReady } from './comfy-setup.ts'
import type {
  ImagineSegment, ImagineSegmentKind, ImagineSegmentsIndex, ImagineSegmentsStatus,
} from '../../../shared/imagine-segments.ts'

/** The SAM 3 checkpoint the node loads, as ComfyUI lists it. */
const SAM3_CHECKPOINT = 'sam3.1_multiplex_fp16.safetensors'

/** The index file of a photo's folder. */
const INDEX_FILE = 'index.json'

/** The files the node writes; nothing else is served from a photo's folder. */
const SEGMENT_FILE = /^[A-Za-z0-9_-]+_(?:mask|cut)_\d{3}\.png$/

/** How long a failure is reported before the photo counts as never analysed. */
const FAILURE_KEPT_MS = 10 * 60_000

/** The folder of one photo's segments. */
export function segmentsDir(photo: string): string {
  return dataPath('comfy', 'segments', photo)
}

/** Whether a name is one of the files the node writes. */
export function isSegmentFile(name: string): boolean {
  return SEGMENT_FILE.test(name)
}

/** One segment of the node's index, or undefined when it is not one. */
function segmentOf(value: unknown): ImagineSegment | undefined {
  if (!isPlainObject(value) || !isPlainObject(value.bbox)) return undefined
  const index = finite(value.index)
  const label = trimmedText(value.label)
  const mask = trimmedText(value.mask)
  const cut = trimmedText(value.cut)
  const kind: ImagineSegmentKind = value.kind === 'text' ? 'text' : 'object'
  const [x, y, w, h] = ['x', 'y', 'w', 'h'].map(key => finite((value.bbox as Record<string, unknown>)[key]))
  if (index === undefined || label === undefined || mask === undefined || cut === undefined) return undefined
  if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined
  if (!isSegmentFile(mask) || !isSegmentFile(cut)) return undefined
  return { index, kind, label, score: finite(value.score) ?? 0, bbox: { x, y, w, h }, area: finite(value.area) ?? 0, mask, cut }
}

/**
 * Read the index the node wrote.
 * @param text - the file's text.
 * @param photo - the gallery photo it belongs to.
 * @param model - the vision model that listed the parts.
 * @returns the index, or undefined when the file is not one.
 */
export function parseNodeIndex(text: string, photo: string, model?: string): ImagineSegmentsIndex | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isPlainObject(value) || !Array.isArray(value.segments)) return undefined
  const width = finite(value.width)
  const height = finite(value.height)
  if (width === undefined || height === undefined) return undefined
  const segments = value.segments.map(segmentOf).filter((segment): segment is ImagineSegment => segment !== undefined)
  return { photo, width, height, createdAt: new Date().toISOString(), ...model === undefined ? {} : { model }, segments }
}

/** The graph: SAM 3 from its checkpoint, the uploaded photo, the node. */
function segmentsGraph(image: string, concepts: string, texts: string, prefix: string): ComfyGraph {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: SAM3_CHECKPOINT } },
    '2': { class_type: 'LoadImage', inputs: { image } },
    '3': {
      class_type: 'ImagineSegments',
      inputs: {
        model: ['1', 0], clip: ['1', 1], image: ['2', 0],
        concepts, texts,
        threshold: 0.5, refine_iterations: 2, dedupe_iou: 0.85, min_area: 0.0002, max_area: 0.9,
        filename_prefix: prefix, save_to: 'temp',
      },
    },
  }
}

/** A short time stamp, to keep two runs of the same photo apart. */
const stamp = (): string => Date.now().toString(36)

/** How many of a photo's masks and cut-outs are downloaded at once. */
const DOWNLOAD_PARALLEL = 6

/**
 * Run a task over every item, at most `limit` at a time, failing as the
 * sequential loop did: the first error stops new tasks from starting and is
 * thrown once the ones in flight have settled. (`mapWithConcurrency` in
 * media-tools.ts swallows errors, which here would store an analysis with
 * missing files.)
 */
async function eachLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  let failure: { readonly error: unknown } | undefined
  const worker = async (): Promise<void> => {
    while (failure === undefined && next < items.length) {
      const item = items[next] as T
      next += 1
      try {
        await task(item)
      } catch (error: unknown) {
        failure ??= { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (failure !== undefined) throw failure.error
}

/**
 * Analyse one photo and store what came out, replacing an older analysis.
 * @param ctx - the host: vision and ComfyUI.
 * @param outputDir - the gallery folder.
 * @param photo - the photo's basename, already checked.
 * @returns the stored index.
 * @throws when the model lists nothing, ComfyUI fails or answers no index.
 */
async function analyzeSegments(ctx: ImagineHost, outputDir: string, photo: string, background = false): Promise<ImagineSegmentsIndex> {
  const path = join(outputDir, photo)
  const stem = photo.slice(0, photo.length - extname(photo).length).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60)
  /*
   * Three independent steps, run together: the setup check (ComfyUI has the
   * Segments node and SAM 3, comfyui-imagine's setup; nobody is in the chat to
   * say yes, so it installs only with «Install automatically» on), the vision
   * pass, which costs minutes, and the photo's upload. A check or an upload
   * that fails stops the vision pass, so a ComfyUI without the node does not
   * cost every new still a look; a look that lists nothing costs one upload.
   */
  const stop = new AbortController()
  const [, sight, upload] = await Promise.all([
    ensureComfyReady(ctx, segmentsGraph('probe.png', 'object', '[]', 'imagine-segments/probe')),
    lookForSegments(ctx, path, background, stop.signal),
    readFile(path).then(async bytes => await ctx.comfy.uploadImage(`segments-${stem}-${stamp()}${extname(photo)}`, bytes)),
  ]).catch((error: unknown) => {
    stop.abort()
    throw error
  })
  if (sight === undefined) throw new Error(message('segments.nothingListed'))
  const texts = JSON.stringify(sight.texts)
  const run = await ctx.comfy.run(segmentsGraph(upload.name, conceptLines(sight.concepts), texts, `imagine-segments/${stem}`))
  const indexRef = run.media.find(ref => ref.filename.endsWith('_index.json'))
  if (indexRef === undefined) throw new Error(message('segments.noIndex'))

  const dir = segmentsDir(photo)
  const scratch = `${dir}.tmp-${stamp()}`
  await mkdir(scratch, { recursive: true })
  try {
    const nodeIndex = join(scratch, 'node-index.json')
    await ctx.comfy.fetchMediaTo(indexRef, nodeIndex)
    const index = parseNodeIndex(await readFile(nodeIndex, 'utf8'), photo, sight.model)
    if (index === undefined) throw new Error(message('segments.noIndex'))
    await rmWithRetry(nodeIndex)
    const wanted = new Set(index.segments.flatMap(segment => [segment.mask, segment.cut]))
    // Two PNGs per segment, up to 40 concepts times their count: one request
    // at a time made the download the slowest step after the vision pass.
    await eachLimited(run.media.filter(ref => wanted.has(ref.filename)), DOWNLOAD_PARALLEL,
      async (ref) => { await ctx.comfy.fetchMediaTo(ref, join(scratch, ref.filename)) })
    await writeFile(join(scratch, INDEX_FILE), JSON.stringify(index))
    await rmWithRetry(dir, { recursive: true, force: true })
    await renameWithRetry(scratch, dir)
    return index
  } catch (error: unknown) {
    await rmWithRetry(scratch, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * The stored analysis of a photo.
 * @param photo - the photo's basename, already checked.
 * @returns the index, or undefined when there is none (or it does not read).
 */
export async function storedSegments(photo: string): Promise<ImagineSegmentsIndex | undefined> {
  try {
    const value = JSON.parse(await readFile(join(segmentsDir(photo), INDEX_FILE), 'utf8')) as ImagineSegmentsIndex
    return Array.isArray(value.segments) ? value : undefined
  } catch {
    return undefined
  }
}

/*
 * The analyses running and the recent failures, by photo, for the whole
 * process: the queue and the page's requests see the same runs, and two asks
 * for one photo share it. In memory: a restart forgets an analysis halfway,
 * and the page starts it again when the panel opens.
 */
const running = new Map<string, { since: string; done: Promise<void> }>()
const failed = new Map<string, { at: number; error: string }>()
const queue: { ctx: ImagineHost; outputDir: string; photo: string }[] = []
const queued = new Set<string>()
let draining = false

/**
 * Where a photo's analysis stands.
 * @param photo - the photo's basename, already checked.
 */
export async function segmentsStatus(photo: string): Promise<ImagineSegmentsStatus> {
  const run = running.get(photo)
  if (run !== undefined) return { state: 'running', since: run.since }
  const failure = failed.get(photo)
  if (failure !== undefined && Date.now() - failure.at < FAILURE_KEPT_MS) return { state: 'failed', error: failure.error }
  const index = await storedSegments(photo)
  return index === undefined ? { state: 'none' } : { state: 'ready', index }
}

/**
 * Start a photo's analysis unless it is running or done (or `again`).
 * @param background - nobody is waiting: the vision look goes in the capped lane.
 * @returns the state right after, «running» when it started.
 */
export async function startSegments(ctx: ImagineHost, outputDir: string, photo: string, again = false, background = false): Promise<ImagineSegmentsStatus> {
  const now = await segmentsStatus(photo)
  if (now.state === 'running' || (now.state === 'ready' && !again)) return now
  failed.delete(photo)
  const since = new Date().toISOString()
  const done = analyzeSegments(ctx, outputDir, photo, background).then(
    () => undefined,
    (error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      console.warn(`[imagine] segmenti di ${photo}: ${reason}`)
      failed.set(photo, { at: Date.now(), error: reason.slice(0, 300) })
    },
  ).finally(() => { running.delete(photo) })
  running.set(photo, { since, done })
  return { state: 'running', since }
}

/**
 * Queue stills a run has just made, and come back at once. They are analysed
 * one after the other; a photo the page asks for meanwhile runs at once and
 * the queue finds it done.
 * @param names - basenames of the new stills.
 */
export function segmentSoon(ctx: ImagineHost, outputDir: string, names: readonly string[]): void {
  for (const photo of names) {
    if (queued.has(photo) || running.has(photo)) continue
    queued.add(photo)
    queue.push({ ctx, outputDir, photo })
  }
  void drain()
}

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      queued.delete(next.photo)
      await startSegments(next.ctx, next.outputDir, next.photo, false, true)
      await running.get(next.photo)?.done
    }
  } finally {
    draining = false
  }
}
