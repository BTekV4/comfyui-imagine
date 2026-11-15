/**
 * Imagine over MCP: the studio's projects, files and jobs as tools an LLM can
 * call, instead of a skill that has to remember routes and body shapes.
 *
 * A thin client of Imagine's own HTTP API (the routes the page uses), so it
 * runs as its own process and never touches the studio's state directly:
 * `POST /comfy-imagine` queues a job (and adopts it into `projectId`),
 * `PUT /comfy-imagine/projects` merges a project in, `POST /comfy-media`
 * uploads a file. Transport: MCP Streamable HTTP, stateless, behind a bearer.
 *
 * Every job can name a project. A project named by a title that does not exist
 * yet is created WITH the job in it: an empty project made from outside is
 * purged by the first browser that syncs (`purgeEmptyProjects`, 2026-10-18).
 * @module imagine-mcp
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import {
  IMAGINE_ACTIONS, IMAGINE_OBJECT_MODES, IMAGINE_QUALITIES, IMAGINE_SPEEDS, MEDIA_KINDS, type GalleryItem,
} from '../shared/imagine-types.ts'
import { IMAGINE_ASPECTS, IMAGE_RESOLUTIONS, type ImagineAspect, type ImagineResolution } from '../shared/imagine-media.ts'
import {
  VIDEO_RESOLUTIONS, clampSeconds, megapixelsFor, sizeFor, videoAspectLabel,
} from '../shared/imagine-sizing.ts'
import type { ImagineSegmentsIndex, ImagineSegmentsStatus } from '../shared/imagine-segments.ts'
import { checkedZone, growMask, joinMasks, maskDataUrl, readMask, rectangleMask, type Fractions } from './masks.ts'

const IMAGINE = (process.env.IMAGINE_URL ?? 'http://127.0.0.1:3090').replace(/\/+$/, '')
/** Where the links handed to the model point: set it to an address the model's client can reach (defaults to IMAGINE_URL). */
const PUBLIC = (process.env.IMAGINE_PUBLIC_URL ?? IMAGINE).replace(/\/+$/, '')
const PORT = Number(process.env.MCP_PORT ?? 3097)
const TOKEN = (() => {
  const file = process.env.MCP_TOKEN_FILE ?? './mcp-token'
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    throw new Error(`missing token file: ${file} (set MCP_TOKEN_FILE)`)
  }
})()
const HISTORY_PROJECT_ID = 'storico'

// ---------------------------------------------------------------- HTTP to Imagine

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${IMAGINE}${path}`, {
    ...init,
    headers: { 'accept': 'application/json', 'x-app-language': process.env.IMAGINE_LANGUAGE ?? 'en', ...init.body !== undefined && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}, ...init.headers },
    signal: init.signal ?? AbortSignal.timeout(120_000),
  })
  const text = await response.text()
  let body: unknown
  try { body = text === '' ? undefined : JSON.parse(text) } catch { body = text }
  if (!response.ok) {
    const reason = typeof body === 'object' && body !== null && 'error' in body ? String((body as { error: unknown }).error) : text.slice(0, 300)
    throw new Error(`Imagine ${init.method ?? 'GET'} ${path}: ${String(response.status)} ${reason}`)
  }
  return body as T
}

interface Project {
  id: string; title: string; createdAt: number; itemNames: string[]; jobIds: string[]; messages: unknown[]
  [field: string]: unknown
}
interface Studio { projects: Project[] }
interface Job {
  id: string; action: string; status: string; prompt?: string; createdAt?: number; startedAt?: number; updatedAt?: number
  error?: string; notice?: string; files?: { name: string; kind: string }[]
  progress?: { percent?: number; stage?: string; etaSeconds?: number; [k: string]: unknown }
  [field: string]: unknown
}

const gallery = async (): Promise<GalleryItem[]> => (await api<{ items: GalleryItem[] }>('/comfy-media')).items
const studio = async (): Promise<Studio> => await api<Studio>('/comfy-imagine/projects')
const jobs = async (): Promise<Job[]> => (await api<{ jobs: Job[] }>('/comfy-imagine')).jobs

const fileUrl = (name: string): string => `${PUBLIC}/comfy-media/${encodeURIComponent(name)}`

function describeFile(item: GalleryItem): Record<string, unknown> {
  return {
    name: item.name,
    kind: item.kind,
    url: fileUrl(item.name),
    ...item.width === undefined ? {} : { width: item.width, height: item.height },
    ...item.duration === undefined ? {} : { seconds: Math.round(item.duration * 10) / 10 },
    sizeKB: Math.round(item.size / 1024),
    created: new Date(item.mtime).toISOString(),
    ...item.tool === undefined ? {} : { tool: item.tool },
  }
}

function describeJob(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    action: job.action,
    status: job.status,
    ...job.progress === undefined ? {} : {
      progress: {
        ...job.progress.percent === undefined ? {} : { percent: Math.round(job.progress.percent) },
        ...job.progress.stage === undefined ? {} : { stage: job.progress.stage },
        ...job.progress.etaSeconds === undefined ? {} : { etaSeconds: Math.round(job.progress.etaSeconds) },
      },
    },
    ...job.error === undefined ? {} : { error: job.error },
    ...job.notice === undefined ? {} : { notice: job.notice },
    ...job.files === undefined || job.files.length === 0 ? {} : {
      files: job.files.map(file => ({ name: file.name, kind: file.kind, url: fileUrl(file.name) })),
    },
  }
}

// ---------------------------------------------------------------- projects

/** A project by id, or by title (case and spaces ignored). */
function findProject(all: Project[], wanted: string): Project | undefined {
  const key = wanted.trim().toLowerCase()
  return all.find(project => project.id === wanted)
    ?? all.find(project => project.title.trim().toLowerCase() === key)
}

/** A project id the studio's own minting would also produce (`p-<time>-<rand>`). */
function newProjectId(): string {
  return `p-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

/**
 * Where a job goes: an existing project, or a new one to create once the job
 * exists (so it is never empty).
 */
async function projectTarget(project: string | undefined): Promise<{ id: string; title: string; isNew: boolean } | undefined> {
  if (project === undefined || project.trim() === '') return undefined
  const found = findProject((await studio()).projects.filter(entry => entry.id !== HISTORY_PROJECT_ID), project)
  if (found !== undefined) return { id: found.id, title: found.title, isNew: false }
  return { id: newProjectId(), title: project.trim(), isNew: true }
}

/** Write one project, merged by the host over what is on disk (other projects untouched). */
async function putProject(project: Project): Promise<void> {
  await api('/comfy-imagine/projects', { method: 'PUT', body: JSON.stringify({ projects: [project] }) })
}

async function createProject(id: string, title: string, contents: { itemNames?: string[]; jobIds?: string[] }): Promise<void> {
  await putProject({ id, title, createdAt: Date.now(), itemNames: contents.itemNames ?? [], jobIds: contents.jobIds ?? [], messages: [] })
}

/** Add files to a project, sending its full copy (a partial copy would win over the disk's fields). */
async function addFilesToProject(projectId: string, names: string[]): Promise<void> {
  const current = (await studio()).projects.find(entry => entry.id === projectId)
  if (current === undefined) throw new Error(`project ${projectId} not found`)
  const have = new Set(current.itemNames)
  const extra = names.filter(name => !have.has(name))
  if (extra.length === 0) return
  await putProject({ ...current, itemNames: [...current.itemNames, ...extra] })
}

// ---------------------------------------------------------------- jobs

/** Queue a job, in a project when one is named. */
async function startJob(body: Record<string, unknown>, project: string | undefined): Promise<Record<string, unknown>> {
  const target = await projectTarget(project)
  const job = await api<Job>('/comfy-imagine', {
    method: 'POST',
    body: JSON.stringify({ ...body, ...target === undefined ? {} : { projectId: target.id } }),
  })
  if (target?.isNew === true) await createProject(target.id, target.title, { jobIds: [job.id] })
  return {
    job: describeJob(job),
    ...target === undefined ? {} : { project: { id: target.id, title: target.title, created: target.isNew } },
    next: 'Call imagine_job with this id (wait_seconds up to 50), again while it runs; finished files come back with their URLs.',
  }
}

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 1) }] })
const fail = (error: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] })
async function guarded(run: () => Promise<unknown>) {
  try {
    return ok(await run())
  } catch (error: unknown) {
    return fail(error)
  }
}

// ---------------------------------------------------------------- segments and zones

/** A segment's mask or cut-out, as the studio serves it. */
const segmentFileUrl = (photo: string, file: string): string =>
  `/api/segments/file/${encodeURIComponent(photo)}/${encodeURIComponent(file)}`

/** Where a photo's Segments analysis stands. */
const segmentsOf = async (photo: string): Promise<ImagineSegmentsStatus> =>
  await api<ImagineSegmentsStatus>(`/api/segments?name=${encodeURIComponent(photo)}`)

/**
 * A photo's segments as the model reads them: index (what the other tools
 * take), label, kind, box in fractions of the photo, share of the photo, and
 * links to the cut-out and the mask.
 */
function describeSegments(index: ImagineSegmentsIndex): Record<string, unknown> {
  const round = (value: number): number => Math.round(value * 1000) / 1000
  return {
    photo: index.photo,
    width: index.width,
    height: index.height,
    segments: index.segments.map(segment => ({
      index: segment.index,
      label: segment.label,
      kind: segment.kind,
      score: Math.round(segment.score * 100) / 100,
      box: { x: round(segment.bbox.x / index.width), y: round(segment.bbox.y / index.height), w: round(segment.bbox.w / index.width), h: round(segment.bbox.h / index.height) },
      // The index stores the area as a fraction of the photo already.
      areaPercent: Math.round(segment.area * 1000) / 10,
      cut: `${PUBLIC}${segmentFileUrl(index.photo, segment.cut)}`,
      mask: `${PUBLIC}${segmentFileUrl(index.photo, segment.mask)}`,
    })),
  }
}

/**
 * The mask of some of a photo's segments, joined, as a data URL: what Precise
 * edit and Remove object take. The analysis must be ready (imagine_segments).
 */
async function segmentsMask(photo: string, wanted: readonly number[], grow = 0): Promise<string> {
  const status = await segmentsOf(photo)
  if (status.state !== 'ready') {
    throw new Error(`the segments of "${photo}" are ${status.state === 'running' ? 'still being found' : 'not there'}: call imagine_segments first`)
  }
  const chosen = wanted.map((number) => {
    const segment = status.index.segments.find(entry => entry.index === number)
    if (segment === undefined) throw new Error(`segment ${String(number)} is not one of "${photo}" (see imagine_segments)`)
    return segment
  })
  const masks = await Promise.all(chosen.map(async (segment) => {
    const response = await fetch(`${IMAGINE}${segmentFileUrl(photo, segment.mask)}`, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`mask of segment ${String(segment.index)}: ${String(response.status)}`)
    return readMask(new Uint8Array(await response.arrayBuffer()))
  }))
  const joined = joinMasks(masks)
  return maskDataUrl(grow > 0 ? growMask(joined, Math.min(joined.width, joined.height) * grow) : joined)
}

/** How much Remove object grows a segment's mask: 2% of the photo's short side (about 20 px at 1080). */
const ERASE_MARGIN = 0.02

/** A photo of the library, with its size: a region becomes pixels on it. */
async function photoItem(name: string): Promise<GalleryItem> {
  const item = (await gallery()).find(entry => entry.name === name)
  if (item === undefined) throw new Error(`file not in the library: ${name} (see imagine_recent_media or imagine_project_files)`)
  if (item.kind !== 'image') throw new Error(`"${name}" is a ${item.kind}, not a photo`)
  return item
}

/** Put a file the studio just made into a project, when one was named. */
async function fileIntoProject(item: GalleryItem, project: string | undefined): Promise<Record<string, unknown>> {
  const target = await projectTarget(project)
  if (target !== undefined) {
    if (target.isNew) await createProject(target.id, target.title, { itemNames: [item.name] })
    else await addFilesToProject(target.id, [item.name])
  }
  return { file: describeFile(item), ...target === undefined ? {} : { project: { id: target.id, title: target.title, created: target.isNew } } }
}

/** Check that the named files exist, so a typo fails here and not minutes into a run. */
async function requireFiles(names: (string | undefined)[]): Promise<void> {
  const wanted = names.filter((name): name is string => name !== undefined && name !== '')
  if (wanted.length === 0) return
  const have = new Set((await gallery()).map(item => item.name))
  const missing = wanted.filter(name => !have.has(name))
  if (missing.length > 0) throw new Error(`files not in the library: ${missing.join(', ')} (see imagine_recent_media, imagine_project_files or imagine_upload)`)
}

// ---------------------------------------------------------------- tools

const aspect = z.enum(IMAGINE_ASPECTS).default('9:16').describe('Frame shape.')
const projectArg = z.string().optional().describe('Project id or title to put the result in. A title that does not exist creates that project. Omit to leave the file only in the library.')
const fileName = (what: string) => z.string().describe(`${what}: a gallery file name (from imagine_recent_media, imagine_project_files or imagine_upload).`)
const zoneArg = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
  .describe('A rectangle in fractions of the photo: x, y from the top-left corner, w and h its size, all between 0 and 1.')
const segmentsArg = z.array(z.number().int().min(0)).min(1)
  .describe('Segment indexes from imagine_segments: their masks are joined into the zone.')

function buildServer(): McpServer {
  const server = new McpServer({ name: 'imagine', version: '1.0.0' }, {
    instructions: [
      'ComfyUI Imagine: a local studio that runs ComfyUI graphs (Krea 2 images, Pika/H3 videos and object swaps, music, voice, upscaling).',
      'Files are referred to by their gallery name. Jobs are asynchronous: start one, then poll imagine_job (it can wait).',
      'Put work in a project (the `project` argument) so it shows on the studio board. Prompts are written in English.',
      'To look at a result yourself, call imagine_view: it returns the picture (or a video frame).',
    ].join(' '),
  })

  server.registerTool('imagine_list_projects', {
    title: 'List projects',
    description: 'The studio projects, most recently created first, with how many files and jobs each holds.',
    inputSchema: { query: z.string().optional().describe('Filter on the title.'), limit: z.number().int().min(1).max(200).default(30) },
    annotations: { readOnlyHint: true },
  }, async ({ query, limit }) => guarded(async () => {
    const key = query?.trim().toLowerCase()
    return (await studio()).projects
      .filter(project => project.id !== HISTORY_PROJECT_ID && (key === undefined || project.title.toLowerCase().includes(key)))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(project => ({ id: project.id, title: project.title, files: project.itemNames.length, jobs: project.jobIds.length, created: new Date(project.createdAt).toISOString() }))
  }))

  server.registerTool('imagine_create_project', {
    title: 'Create a project',
    description: 'Create a project holding the given files (at least one: an empty project is removed by the studio). To create one for a new generation, just pass a new title as `project` to the generation tool instead.',
    inputSchema: { title: z.string().min(1), files: z.array(z.string()).min(1).describe('Gallery file names to put in it.') },
  }, async ({ title, files }) => guarded(async () => {
    await requireFiles(files)
    const id = newProjectId()
    await createProject(id, title, { itemNames: files })
    return { id, title, files: files.length }
  }))

  server.registerTool('imagine_project_files', {
    title: 'Files of a project',
    description: 'The files a project holds, newest first, with their URLs.',
    inputSchema: {
      project: z.string().describe('Project id or title.'),
      kind: z.enum(MEDIA_KINDS).optional(),
      limit: z.number().int().min(1).max(500).default(50),
    },
    annotations: { readOnlyHint: true },
  }, async ({ project, kind, limit }) => guarded(async () => {
    const found = findProject((await studio()).projects, project)
    if (found === undefined) throw new Error(`project "${project}" not found`)
    const names = new Set(found.itemNames)
    const items = (await gallery()).filter(item => names.has(item.name) && (kind === undefined || item.kind === kind))
      .sort((a, b) => b.mtime - a.mtime)
    return { project: { id: found.id, title: found.title }, total: items.length, files: items.slice(0, limit).map(describeFile) }
  }))

  server.registerTool('imagine_recent_media', {
    title: 'Library files',
    description: 'Files in the studio library, newest first. `query` searches the words of the files (the prompt they were made with and what the vision pass saw in them).',
    inputSchema: {
      query: z.string().optional(),
      kind: z.enum(MEDIA_KINDS).optional(),
      limit: z.number().int().min(1).max(200).default(30),
    },
    annotations: { readOnlyHint: true },
  }, async ({ query, kind, limit }) => guarded(async () => {
    let items = await gallery()
    if (query !== undefined && query.trim() !== '') {
      const hits = await api<{ names?: string[] }>(`/api/media-search?q=${encodeURIComponent(query.trim())}`)
      const order = new Map((hits.names ?? []).map((name, index) => [name, index]))
      items = items.filter(item => order.has(item.name)).sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0))
    } else {
      items = [...items].sort((a, b) => b.mtime - a.mtime)
    }
    if (kind !== undefined) items = items.filter(item => item.kind === kind)
    return { total: items.length, files: items.slice(0, limit).map(describeFile) }
  }))

  server.registerTool('imagine_upload', {
    title: 'Upload a file',
    description: 'Put an image, video or audio file into the library (from a URL the studio can reach, or base64 data), optionally into a project. Returns the gallery name to use as `source`/`reference`.',
    inputSchema: {
      url: z.string().url().optional().describe('http(s) URL to download.'),
      data_base64: z.string().optional().describe('The file itself, base64 (without a data: prefix).'),
      filename: z.string().optional().describe('Name with extension (e.g. photo.jpg); required with data_base64.'),
      project: projectArg,
    },
  }, async ({ url, data_base64, filename, project }) => guarded(async () => {
    let bytes: Uint8Array
    let name = filename
    if (url !== undefined) {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
      if (!response.ok) throw new Error(`download ${String(response.status)} from ${url}`)
      bytes = new Uint8Array(await response.arrayBuffer())
      name ??= decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '') || 'upload.bin'
    } else if (data_base64 !== undefined) {
      if (name === undefined) throw new Error('data_base64 needs a filename')
      bytes = Buffer.from(data_base64, 'base64')
    } else {
      throw new Error('give url or data_base64')
    }
    const item = await api<GalleryItem>('/comfy-media', {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent(name), 'content-type': 'application/octet-stream' },
      body: new Blob([Uint8Array.from(bytes)]),
    })
    const target = await projectTarget(project)
    if (target !== undefined) {
      if (target.isNew) await createProject(target.id, target.title, { itemNames: [item.name] })
      else await addFilesToProject(target.id, [item.name])
    }
    return { file: describeFile(item), ...target === undefined ? {} : { project: { id: target.id, title: target.title, created: target.isNew } } }
  }))

  server.registerTool('imagine_view', {
    title: 'Look at a file',
    description: 'Returns a library file as an image you can see: the picture itself, or a frame of a video (reduced). Use it to check a result.',
    inputSchema: { name: fileName('The file'), width: z.number().int().min(128).max(1024).default(640) },
    annotations: { readOnlyHint: true },
  }, async ({ name, width }) => {
    try {
      const response = await fetch(`${IMAGINE}/comfy-media/${encodeURIComponent(name)}?thumb=${String(width)}`, { signal: AbortSignal.timeout(60_000) })
      if (!response.ok) throw new Error(`file "${name}": ${String(response.status)}`)
      const mimeType = response.headers.get('content-type') ?? 'image/webp'
      if (!mimeType.startsWith('image/')) throw new Error(`"${name}" has no preview (${mimeType})`)
      const data = Buffer.from(await response.arrayBuffer()).toString('base64')
      return { content: [{ type: 'image' as const, data, mimeType }, { type: 'text' as const, text: fileUrl(name) }] }
    } catch (error: unknown) {
      return fail(error)
    }
  })

  server.registerTool('imagine_generate_image', {
    title: 'Generate an image',
    description: 'Draw a new picture from a prompt with the studio\'s Krea 2 graph (the one behind «Nuova generazione», with its LoRAs).',
    inputSchema: {
      prompt: z.string().min(1).describe('What to draw, in English.'),
      aspect,
      resolution: z.enum(IMAGE_RESOLUTIONS).default('1080p').describe('Short side of the picture.'),
      quality: z.enum(IMAGINE_QUALITIES).default('standard').describe('high = 16 sampler steps instead of 8 (slower).'),
      count: z.number().int().min(1).max(8).default(1).describe('How many pictures, each its own job.'),
      project: projectArg,
    },
  }, async ({ prompt, aspect: shape, resolution, quality, count, project }) => guarded(async () => startJob({
    action: 'generate', prompt, size: sizeFor(shape as ImagineAspect, resolution as ImagineResolution),
    quality, speed: quality === 'high' ? 'slow' : 'fast', ...count > 1 ? { count } : {},
  }, project)))

  server.registerTool('imagine_edit_image', {
    title: 'Edit a picture',
    description: [
      'Change a picture with an instruction (Krea 2 edit graph): «make the dress red», «put her on a beach». The result is a new file beside the original.',
      'Precise edit: pass `segments` (indexes from imagine_segments) or `region` (a rectangle) and only that zone changes — «make this jacket leather», or "remove this layer" to take the segment away.',
      '`reference`: a second picture to take something from (an object, a garment, a style), named in the prompt.',
    ].join(' '),
    inputSchema: {
      source: fileName('The picture to edit'),
      prompt: z.string().min(1).describe('The change, in English.'),
      segments: segmentsArg.optional(),
      region: zoneArg.optional(),
      reference: fileName('A reference picture').optional(),
      quality: z.enum(IMAGINE_QUALITIES).default('standard'),
      project: projectArg,
    },
  }, async ({ source, prompt, segments, region, reference, quality, project }) => guarded(async () => {
    if (segments !== undefined && region !== undefined) throw new Error('give segments or region, not both')
    await requireFiles([source, reference])
    const zone = segments !== undefined
      ? { mask: await segmentsMask(source, segments) }
      : region !== undefined ? { region: checkedZone(region) } : {}
    return await startJob({
      action: 'remix', prompt, source, quality, speed: quality === 'high' ? 'slow' : 'fast',
      ...zone, ...reference === undefined ? {} : { reference },
    }, project)
  }))

  server.registerTool('imagine_segments', {
    title: 'Find the objects in a photo',
    description: [
      'Segments: the vision model names what is in the photo and SAM 3 cuts out each object (and boxes the readable text).',
      'Returns every segment with its index, label, box and share of the photo, and links to its transparent cut-out and its mask.',
      'The indexes go to imagine_edit_image (segments) and imagine_remove_object. The first analysis of a photo takes one to three minutes: wait_seconds keeps asking; call again while it runs. Photos made by the studio are often analysed already.',
    ].join(' '),
    inputSchema: {
      photo: fileName('The photo'),
      again: z.boolean().default(false).describe('Analyse it again even if it was done.'),
      wait_seconds: z.number().int().min(0).max(50).default(45).describe('Keep asking for up to this many seconds (max 50).'),
    },
  }, async ({ photo, again, wait_seconds }) => guarded(async () => {
    await photoItem(photo)
    let status = await api<ImagineSegmentsStatus>('/api/segments', { method: 'POST', body: JSON.stringify({ name: photo, again }) })
    const until = Date.now() + wait_seconds * 1000
    while (status.state === 'running' && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, Math.min(5000, Math.max(1000, until - Date.now()))))
      status = await segmentsOf(photo)
    }
    if (status.state === 'ready') return { state: 'ready', ...describeSegments(status.index) }
    if (status.state === 'failed') return { state: 'failed', error: status.error }
    return { state: status.state, photo, next: 'Still analysing: call imagine_segments again with the same photo (again: false).' }
  }))

  server.registerTool('imagine_remove_object', {
    title: 'Remove an object from a photo',
    description: 'Erase a zone and fill it from what is around it (LaMa, through the IOPaint plugin — a few seconds, no ComfyUI). The zone is `segments` (indexes from imagine_segments) or `region` (a rectangle). The result is a new photo beside the original.',
    inputSchema: {
      photo: fileName('The photo'),
      segments: segmentsArg.optional(),
      region: zoneArg.optional(),
      project: projectArg,
    },
  }, async ({ photo, segments, region, project }) => guarded(async () => {
    if ((segments === undefined) === (region === undefined)) throw new Error('give segments or region (one of the two)')
    const item = await photoItem(photo)
    let mask: string
    if (segments !== undefined) {
      mask = await segmentsMask(photo, segments, ERASE_MARGIN)
    } else {
      if (item.width === undefined || item.height === undefined) throw new Error(`the size of "${photo}" is not known`)
      mask = maskDataUrl(rectangleMask(item.width, item.height, region as Fractions))
    }
    const made = await api<GalleryItem>('/plugin/iopaint/erase', { method: 'POST', body: JSON.stringify({ name: photo, mask }), signal: AbortSignal.timeout(330_000) })
    return await fileIntoProject(made, project)
  }))

  server.registerTool('imagine_crop', {
    title: 'Crop a photo',
    description: 'Keep a rectangle of a photo, as a new lossless file beside the original.',
    inputSchema: { photo: fileName('The photo'), region: zoneArg, project: projectArg },
  }, async ({ photo, region, project }) => guarded(async () => {
    await photoItem(photo)
    const made = await api<GalleryItem>('/api/crop-copy', { method: 'POST', body: JSON.stringify({ name: photo, region: checkedZone(region) }) })
    return await fileIntoProject(made, project)
  }))

  server.registerTool('imagine_make_video', {
    title: 'Make a video from a picture',
    description: 'Animate a picture into a short clip (image to video). Optionally the clip arrives at a second picture.',
    inputSchema: {
      source: fileName('The starting picture'),
      prompt: z.string().default('').describe('What happens, in English (motion, camera). Empty lets the studio write it from the picture.'),
      seconds: z.number().int().min(2).max(20).default(5),
      aspect,
      resolution: z.enum(VIDEO_RESOLUTIONS).default('720p'),
      speed: z.enum(IMAGINE_SPEEDS).default('fast').describe('slow = the high-quality graph (several times longer).'),
      last_frame: z.string().optional().describe('Gallery picture the clip should end on.'),
      project: projectArg,
    },
  }, async ({ source, prompt, seconds, aspect: shape, resolution, speed, last_frame, project }) => guarded(async () => {
    await requireFiles([source, last_frame])
    return await startJob({
      action: 'video', prompt, source,
      aspectRatio: videoAspectLabel(shape as ImagineAspect),
      seconds: clampSeconds('video', resolution as ImagineResolution, seconds),
      megapixels: megapixelsFor(resolution as ImagineResolution),
      speed, quality: speed === 'slow' ? 'high' : 'standard',
      ...last_frame === undefined ? {} : { lastSource: last_frame },
    }, project)
  }))

  server.registerTool('imagine_run_action', {
    title: 'Run any studio action',
    description: [
      'Every other studio action, with the request fields the studio itself sends. `source` is the main file, `reference` the second one.',
      'upscale: source photo/video (extras.upscaleTo: short side). bg: remove background from a photo. loop: photo → seamless looping clip (extras.seconds up to 60, aspectRatio). extend: continue a video.',
      'music: prompt = style (extras.lyrics, extras.seconds). speak: prompt = text to read. voice: source audio re-sung by the RVC voice. relight: source photo, extras.light = look id.',
      `objectSwap: source video, prompt required, extras.objectMode one of ${IMAGINE_OBJECT_MODES.join('/')} (change needs reference photo).`,
      'compose: source person photo + reference costume/setting photo (Qwen). recreate: source video redrawn and shot again (extras.keepAudio). regenerate: source video rebuilt at 1.5x.',
      'scanFrame: source video → candidate opening frames for a recreate (extras.candidates). custom: extras.customWorkflowId from imagine_custom_workflows, extras.customFields/customFiles.',
    ].join(' '),
    inputSchema: {
      action: z.enum(IMAGINE_ACTIONS),
      prompt: z.string().default(''),
      source: z.string().optional(),
      reference: z.string().optional(),
      extras: z.record(z.string(), z.unknown()).default({}).describe('Further request fields, passed as they are.'),
      project: projectArg,
    },
  }, async ({ action, prompt, source, reference, extras, project }) => guarded(async () => {
    await requireFiles([source, reference])
    return await startJob({
      quality: 'standard', speed: 'fast', ...extras,
      action, prompt, ...source === undefined ? {} : { source }, ...reference === undefined ? {} : { reference },
    }, project)
  }))

  server.registerTool('imagine_custom_workflows', {
    title: 'Custom workflows',
    description: 'The workflows the user uploaded (cards under «I tuoi workflow»), with their inputs; run one with imagine_run_action action "custom".',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => guarded(async () => (await api<{ workflows: Record<string, unknown>[] }>('/comfy-custom-workflows')).workflows
    .map(({ id, title, description, output, inputs }) => ({ id, title, description, output, inputs }))))

  server.registerTool('imagine_job', {
    title: 'Follow a job',
    description: 'State of a job: queued, running (with percent and stage), done (with its files and URLs) or failed. wait_seconds (up to 50) keeps asking until it settles or the time is up; call it again while the job is still running — renders take minutes.',
    inputSchema: { job_id: z.string(), wait_seconds: z.number().int().min(0).max(50).default(0).describe('Keep asking for up to this many seconds (max 50: MCP clients cut longer calls). Call again while the job runs.') },
    annotations: { readOnlyHint: true },
  }, async ({ job_id, wait_seconds }) => guarded(async () => {
    const until = Date.now() + wait_seconds * 1000
    for (;;) {
      const job = (await jobs()).find(entry => entry.id === job_id)
      if (job === undefined) {
        return { id: job_id, status: 'unknown', note: 'The job is no longer listed: finished jobs stay for half an hour, and a restart of Imagine empties the queue. Look for its file with imagine_recent_media.' }
      }
      const settled = !['queued', 'running'].includes(job.status)
      if (settled || Date.now() >= until) return describeJob(job)
      await new Promise(resolve => setTimeout(resolve, Math.min(10_000, Math.max(1000, until - Date.now()))))
    }
  }))

  server.registerTool('imagine_list_jobs', {
    title: 'Jobs',
    description: 'The jobs the studio holds: running and queued first, then the ones finished in the last half hour.',
    inputSchema: { include_finished: z.boolean().default(false) },
    annotations: { readOnlyHint: true },
  }, async ({ include_finished }) => guarded(async () => (await jobs())
    .filter(job => include_finished || job.status === 'queued' || job.status === 'running')
    .map(describeJob)))

  server.registerTool('imagine_cancel_job', {
    title: 'Cancel a job',
    description: 'Stop a queued or running job (it is also taken off ComfyUI).',
    inputSchema: { job_id: z.string() },
    annotations: { destructiveHint: true },
  }, async ({ job_id }) => guarded(async () => {
    const response = await fetch(`${IMAGINE}/comfy-imagine/${encodeURIComponent(job_id)}`, { method: 'DELETE' })
    if (!response.ok && response.status !== 404) throw new Error(`cancel: ${String(response.status)}`)
    return { id: job_id, cancelled: response.status !== 404 }
  }))

  return server
}

// ---------------------------------------------------------------- HTTP

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? ''
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  const a = Buffer.from(given)
  const b = Buffer.from(TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    // A base64 upload can be big: 200 MB of JSON at most.
    if (size > 200 * 1024 * 1024) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? undefined : JSON.parse(text)
}

createServer((req, res) => {
  void (async () => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/health') return reply(res, 200, { ok: true })
    if (path !== '/mcp') return reply(res, 404, { error: 'not found' })
    if (!authorized(req)) return reply(res, 401, { error: 'unauthorized' })
    if (req.method !== 'POST') {
      // Stateless: no server-sent stream to resume, no session to delete.
      return reply(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null })
    }
    let body: unknown
    try {
      body = await readBody(req)
    } catch (error: unknown) {
      return reply(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: error instanceof Error ? error.message : 'Parse error' }, id: null })
    }
    const server = buildServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { void transport.close(); void server.close() })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (error: unknown) {
      console.error('[imagine-mcp]', error)
      if (!res.headersSent) reply(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
    }
  })()
}).listen(PORT, '0.0.0.0', () => {
  console.log(`[imagine-mcp] listening on :${String(PORT)}/mcp → ${IMAGINE}`)
})
