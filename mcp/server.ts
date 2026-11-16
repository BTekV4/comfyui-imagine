/**
 * Imagine over MCP: the studio's projects, files and jobs as tools an LLM can
 * call, instead of a skill that has to remember routes and body shapes.
 *
 * A thin client of Imagine's own HTTP API (the routes the page uses), so it
 * runs as its own process and never touches the studio's state directly:
 * `POST /comfy-imagine` queues a job (and adopts it into `projectId`),
 * `POST /comfy-imagine/template` runs one of the studio's own models,
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
  SWAP_RESOLUTIONS, VIDEO_RESOLUTIONS, megapixelsFor, sizeFor, videoAspectLabel,
} from '../shared/imagine-sizing.ts'
import { segmentFileUrl, type ImagineSegmentsIndex, type ImagineSegmentsStatus } from '../shared/imagine-segments.ts'
import { HISTORY_PROJECT_ID, type ImagineProject } from '../shared/imagine-projects.ts'
import type { Template, TemplateField } from '../shared/imagine-templates.ts'
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

// ---------------------------------------------------------------- HTTP to Imagine

/**
 * A request to Imagine, answered as the raw response: the base URL, the
 * language of the error texts and a timeout, for every call. The callers that
 * need bytes (a mask, a preview) or the status itself (a 404 that is an
 * answer) use it directly; the rest go through {@link api}.
 */
async function raw(path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${IMAGINE}${path}`, {
    ...init,
    headers: { 'x-app-language': process.env.IMAGINE_LANGUAGE ?? 'en', ...init.headers },
    signal: init.signal ?? AbortSignal.timeout(120_000),
  })
}

/** A response's JSON body, or an error naming the call and the studio's reason. */
async function parsed<T>(response: Response, method: string, path: string): Promise<T> {
  const text = await response.text()
  let body: unknown
  try { body = text === '' ? undefined : JSON.parse(text) } catch { body = text }
  if (!response.ok) {
    const reason = typeof body === 'object' && body !== null && 'error' in body ? String((body as { error: unknown }).error) : text.slice(0, 300)
    throw new Error(`Imagine ${method} ${path}: ${String(response.status)} ${reason}`)
  }
  return body as T
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await raw(path, {
    ...init,
    headers: { 'accept': 'application/json', ...init.body !== undefined && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}, ...init.headers },
  })
  return await parsed<T>(response, init.method ?? 'GET', path)
}

type Project = ImagineProject
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

/**
 * One job, or undefined once the studio no longer holds it (404). Asked by id:
 * the full list prunes and decorates every job, and imagine_job asks again
 * every few seconds while a render runs.
 */
async function jobById(id: string): Promise<Job | undefined> {
  const path = `/comfy-imagine/${encodeURIComponent(id)}`
  const response = await raw(path, { headers: { accept: 'application/json' } })
  if (response.status === 404) {
    await response.body?.cancel()
    return undefined
  }
  return await parsed<Job>(response, 'GET', path)
}

/**
 * One library file, or undefined when there is none by that name. Asked of
 * `/api/file-details`, which looks at that one file: the gallery route sends
 * the whole library (some 1600 entries) for a check of one name.
 */
async function libraryItem(name: string): Promise<GalleryItem | undefined> {
  const path = `/api/file-details?name=${encodeURIComponent(name)}`
  const response = await raw(path, { headers: { accept: 'application/json' } })
  // 400: not a media name at all, so not in the library either.
  if (response.status === 404 || response.status === 400) {
    await response.body?.cancel()
    return undefined
  }
  return await parsed<GalleryItem>(response, 'GET', path)
}

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
async function projectTarget(project: string | undefined): Promise<{ id: string; title: string; isNew: boolean; found?: Project } | undefined> {
  if (project === undefined || project.trim() === '') return undefined
  const found = findProject((await studio()).projects.filter(entry => entry.id !== HISTORY_PROJECT_ID), project)
  // The project itself rides along, so adding files to it needs no second read of the studio.
  if (found !== undefined) return { id: found.id, title: found.title, isNew: false, found }
  return { id: newProjectId(), title: project.trim(), isNew: true }
}

/** Write one project, merged by the host over what is on disk (other projects untouched). */
async function putProject(project: Project): Promise<void> {
  await api('/comfy-imagine/projects', { method: 'PUT', body: JSON.stringify({ projects: [project] }) })
}

async function createProject(id: string, title: string, contents: { itemNames?: string[]; jobIds?: string[] }): Promise<void> {
  await putProject({ id, title, createdAt: Date.now(), itemNames: contents.itemNames ?? [], jobIds: contents.jobIds ?? [], messages: [] })
}

/**
 * Add files to a project, sending its full copy (a partial copy would win over the disk's fields).
 * @param current - the project as just read from the studio (by {@link projectTarget}).
 * @param names - the files to add.
 */
async function addFilesToProject(current: Project, names: string[]): Promise<void> {
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
      // The shared helper adds the analysis time: a new analysis (again: true)
      // can reuse a file name, and the route lets clients keep these a day.
      cut: `${PUBLIC}${segmentFileUrl(index, segment.cut)}`,
      mask: `${PUBLIC}${segmentFileUrl(index, segment.mask)}`,
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
    const response = await raw(segmentFileUrl(status.index, segment.mask), { signal: AbortSignal.timeout(60_000) })
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
  const item = await libraryItem(name)
  if (item === undefined) throw new Error(`file not in the library: ${name} (see imagine_recent_media or imagine_project_files)`)
  if (item.kind !== 'image') throw new Error(`"${name}" is a ${item.kind}, not a photo`)
  return item
}

/** Put a file the studio just made into a project, when one was named. */
async function fileIntoProject(item: GalleryItem, project: string | undefined): Promise<Record<string, unknown>> {
  const target = await projectTarget(project)
  if (target !== undefined) {
    if (target.isNew) await createProject(target.id, target.title, { itemNames: [item.name] })
    else if (target.found !== undefined) await addFilesToProject(target.found, [item.name])
  }
  return { file: describeFile(item), ...target === undefined ? {} : { project: { id: target.id, title: target.title, created: target.isNew } } }
}

/** Check that the named files exist, so a typo fails here and not minutes into a run. */
async function requireFiles(names: (string | undefined)[]): Promise<void> {
  const wanted = names.filter((name): name is string => name !== undefined && name !== '')
  if (wanted.length === 0) return
  const found = await Promise.all(wanted.map(async name => await libraryItem(name)))
  const missing = wanted.filter((_, at) => found[at] === undefined)
  if (missing.length > 0) throw new Error(`files not in the library: ${missing.join(', ')} (see imagine_recent_media, imagine_project_files or imagine_upload)`)
}

// ---------------------------------------------------------------- templates

/**
 * A model of the studio's «Templates» as its route hands it over: the catalog,
 * with the whole form and without the runs (the studio keeps those).
 */
type TemplateForm = Omit<Template, 'runs'>

/**
 * A form's field as the model reads it: what it takes, how many, and what a
 * valid answer looks like. The locale keys are left out — a client needs the
 * English label, not the page's dictionary.
 */
function describeTemplateField(field: TemplateField): Record<string, unknown> {
  const head = {
    id: field.id,
    kind: field.kind,
    label: field.label,
    ...field.required === true ? { required: true } : {},
  }
  switch (field.kind) {
    case 'photos':
      // The order counts and `min` may be 0 (an optional reference photo).
      return { ...head, min: field.min, max: field.max }
    case 'text':
      return {
        ...head,
        ...field.multiline === true ? { multiline: true } : {},
        ...field.placeholder === undefined ? {} : { placeholder: field.placeholder },
        ...field.maxLength === undefined ? {} : { maxLength: field.maxLength },
      }
    case 'aspect':
      // A ratio is its own label: the value is the text the page shows.
      return {
        ...head,
        options: field.options.map(value => ({ value, label: value })),
        ...field.multi === true ? { multi: true } : {},
        ...field.default === undefined ? {} : { default: field.default },
      }
    case 'choice':
      return {
        ...head,
        options: field.options.map(option => ({ value: option.value, label: option.label })),
        ...field.multi === true ? { multi: true } : {},
        ...field.default === undefined ? {} : { default: field.default },
      }
  }
}

/** The studio's models, whole: the page's own catalog (`GET /comfy-imagine/templates`). */
const templateForms = async (): Promise<TemplateForm[]> =>
  (await api<{ templates?: TemplateForm[] }>('/comfy-imagine/templates')).templates ?? []

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
      'ComfyUI Imagine: a local studio that runs ComfyUI graphs (Krea 2 images, Pika/H3 videos, character and object swaps, music, voice, upscaling).',
      'Videos past 6 seconds are rendered as one continuous take, a chain of scenes of at most 6 s each (make video, extend, loop, up to 60 s): longer runs, so poll imagine_job patiently.',
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
    // Typed on an ArrayBuffer so the Blob takes it as it is (no copy of up to 200 MB).
    let bytes: Uint8Array<ArrayBuffer>
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
      body: new Blob([bytes]),
    })
    return await fileIntoProject(item, project)
  }))

  server.registerTool('imagine_view', {
    title: 'Look at a file',
    description: 'Returns a library file as an image you can see: the picture itself, or a frame of a video (reduced). Use it to check a result.',
    inputSchema: { name: fileName('The file'), width: z.number().int().min(128).max(1024).default(640) },
    annotations: { readOnlyHint: true },
  }, async ({ name, width }) => {
    try {
      const response = await raw(`/comfy-media/${encodeURIComponent(name)}?thumb=${String(width)}`, { signal: AbortSignal.timeout(60_000) })
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
    description: 'Draw a new picture from a prompt with the studio\'s Krea 2 graph (the one behind «New generation», with its LoRAs).',
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
    description: 'Animate a picture into a video (image to video). Up to 6 s it is one clip; past that, up to 60 s, one continuous take rendered as chained scenes of at most 6 s, each continuing the last (the studio writes one prompt per scene). With last_frame the clip arrives at a second picture (one clip, up to 6 s).',
    inputSchema: {
      source: fileName('The starting picture'),
      prompt: z.string().default('').describe('What happens, in English (motion, camera). Empty lets the studio write it from the picture.'),
      seconds: z.number().int().min(2).max(60).default(5).describe('Length in seconds: up to 6 one clip, up to 60 chained scenes.'),
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
      seconds: last_frame === undefined ? seconds : Math.min(seconds, 6),
      megapixels: megapixelsFor(resolution as ImagineResolution),
      speed, quality: speed === 'slow' ? 'high' : 'standard',
      ...last_frame === undefined ? {} : { lastSource: last_frame },
    }, project)
  }))

  server.registerTool('imagine_swap_person', {
    title: 'Character swap in a video',
    description: 'Replace the main person of a video (the one who fills most of the frame) with the person in a photo, keeping the motion, framing, setting and soundtrack. Openjutsu\'s one-click recipe: the studio describes the photo and writes the shots, and the whole clip is rendered in chained 6 s scenes. Lip-sync on: the new person mouths the clip\'s voices and singing; off for music the people only move to.',
    inputSchema: {
      video: fileName('The video whose main person is replaced'),
      photo: fileName('A clear photo of the new character, face and outfit visible'),
      lip_sync: z.boolean().default(true).describe('false when the people in the clip do not sing or talk along.'),
      resolution: z.enum(SWAP_RESOLUTIONS).default('720p').describe('480p is fastest; 1080p needs much more time and memory.'),
      prompt: z.string().default('').describe('An optional note; the shots are written by the studio.'),
      project: projectArg,
    },
  }, async ({ video, photo, lip_sync, resolution, prompt, project }) => guarded(async () => {
    await requireFiles([video, photo])
    return await startJob({
      action: 'swapPerson', prompt, source: video, reference: photo,
      swapResolution: resolution,
      ...lip_sync ? {} : { lipSync: false },
    }, project)
  }))

  server.registerTool('imagine_object_swap', {
    title: 'Edit an object in a video',
    description: `Change, remove or add an object in a video, or change the setting around the subject; only that area is regenerated, the rest of the shot, the camera and the soundtrack stay. Openjutsu\'s object recipe, rendered in chained 6 s scenes. Modes: change (the object of \`photo\` replaces the tracked one: photo required), remove (the tracked object disappears), background (the setting around the subject becomes what \`prompt\` says), add (a new object, from \`prompt\` or \`photo\`, inside \`box\`). The studio finds what to track from the video and the prompt.`,
    inputSchema: {
      video: fileName('The video to edit'),
      mode: z.enum(IMAGINE_OBJECT_MODES).default('change'),
      prompt: z.string().describe('What to do, in a sentence: what to remove, the new setting, the object to add, or a note for change.'),
      photo: z.string().optional().describe('change: the new object (required); add: the look of the object to add. A gallery file name.'),
      box: zoneArg.optional().describe('add only: where the new object goes, in fractions of the frame (default: the centre).'),
      resolution: z.enum(SWAP_RESOLUTIONS).default('720p').describe('480p is fastest; 1080p needs much more time and memory.'),
      project: projectArg,
    },
  }, async ({ video, mode, prompt, photo, box, resolution, project }) => guarded(async () => {
    await requireFiles([video, photo])
    return await startJob({
      action: 'objectSwap', objectMode: mode, prompt, source: video,
      ...photo === undefined ? {} : { reference: photo },
      ...mode === 'add' && box !== undefined ? { placement: { x: box.x, y: box.y, width: box.w, height: box.h } } : {},
      swapResolution: resolution,
    }, project)
  }))

  server.registerTool('imagine_run_action', {
    title: 'Run any studio action',
    description: [
      'Every other studio action, with the request fields the studio itself sends. `source` is the main file, `reference` the second one.',
      'upscale: source photo/video (extras.upscaleTo: short side). bg: remove background from a photo. loop: photo → seamless looping clip (extras.seconds up to 60; past 6 s chained scenes, the last landing back on the first frame). extend: continue a video (extras.seconds up to 60; past 6 s chained scenes, the result is the whole clip with its continuation).',
      'music: prompt = style (extras.lyrics, extras.seconds). speak: prompt = text to read. voice: source audio re-sung by the RVC voice. relight: source photo, extras.light = look id.',
      'objectSwap and swapPerson have their own tools: imagine_object_swap, imagine_swap_person.',
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
    description: 'The workflows the user uploaded (cards under «Your workflows»), with their inputs; run one with imagine_run_action action "custom".',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => guarded(async () => (await api<{ workflows: Record<string, unknown>[] }>('/comfy-custom-workflows')).workflows
    .map(({ id, title, description, output, inputs }) => ({ id, title, description, output, inputs }))))

  server.registerTool('imagine_templates', {
    title: 'Models of the studio',
    description: [
      'The studio\'s «Templates»: ready-made models of the home page (photo edit, background, headshot, restyle, collage, product set, emoji pack, …), each one a form of photos, choices, a canvas and some words.',
      'Every model comes with its id, category, title, description and the shape of its form, so imagine_run_template can be called without guessing: photo fields take gallery names (min/max, in the order given), choice and aspect fields take one of the option `value`s (several when `multi`), text fields take words, and a field left out keeps its default.',
    ].join(' '),
    inputSchema: { category: z.string().optional().describe('Only the models of one group: one of `categories` in the answer (photo, people, style, product, social, collection).') },
    annotations: { readOnlyHint: true },
  }, async ({ category }) => guarded(async () => {
    const catalog = await templateForms()
    const key = category?.trim().toLowerCase()
    const listed = key === undefined || key === '' ? catalog : catalog.filter(entry => entry.category.toLowerCase() === key)
    return {
      // Read off the catalog, so a group the studio adds shows up here too.
      categories: [...new Set(catalog.map(entry => entry.category))],
      total: listed.length,
      templates: listed.map(entry => ({
        id: entry.id,
        category: entry.category,
        title: entry.title,
        description: entry.description,
        about: entry.about,
        fields: entry.fields.map(describeTemplateField),
      })),
      next: 'Call imagine_run_template with `template_id` (a model id from here), the `values` (option `value`s and text) and the `files` (gallery names, in the order they should be used).',
    }
  }))

  server.registerTool('imagine_run_template', {
    title: 'Run a model',
    description: [
      'Run one of the studio\'s models (imagine_templates lists them), named by `template_id`: the answers become jobs in the studio, which render like any other job and appear on the project\'s board.',
      '`files` are the gallery names of the photo fields (from imagine_recent_media, imagine_project_files or imagine_upload), one array per field id: the order counts — the first photo is the one the model starts from, the others are the set (a collage, a pack).',
      '`values` are the other answers by field id: a choice or aspect field takes the `value` of one of its options (an array when the field takes several), a text field takes the words. A field left out keeps its default.',
      'Returns the job ids, to follow with imagine_job, and the files the studio composed itself — a collage, a resize — which are ready at once. A model that chains steps (a picture, then its cut-out) queues the next run by itself when the one before it settles. An `error` next to them means the studio stopped half way: what is listed did start, the rest did not.',
    ].join(' '),
    inputSchema: {
      template_id: z.string().min(1).describe('The model id, as imagine_templates returns it.'),
      values: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional()
        .describe('The answers by field id: an option value (or several, for a field that takes more than one), a ratio, or the words of a text box.'),
      files: z.record(z.string(), z.array(z.string())).optional()
        .describe('Gallery file names by photo field id, in the order they should be used.'),
      project: projectArg,
    },
  }, async ({ template_id, values, files, project }) => guarded(async () => {
    await requireFiles(Object.values(files ?? {}).flat())
    /*
     * A title that is not a project yet gets its id minted here and the project
     * is created once the studio has queued the runs: created first, it would
     * be empty and the first page that syncs would purge it (see the module
     * note). The runs are adopted into that id straight away by the studio.
     */
    const target = await projectTarget(project)
    const answer = await api<{ jobs?: string[]; files?: string[]; error?: string }>('/comfy-imagine/template', {
      method: 'POST',
      body: JSON.stringify({
        templateId: template_id,
        ...values === undefined ? {} : { values },
        ...files === undefined ? {} : { files },
        ...target === undefined ? {} : { projectId: target.id },
      }),
    })
    const queued = answer.jobs ?? []
    const composed = answer.files ?? []
    if (target?.isNew === true) await createProject(target.id, target.title, { jobIds: queued, itemNames: composed })
    return {
      template: template_id,
      ...target === undefined ? {} : { project: { id: target.id, title: target.title, created: target.isNew } },
      jobs: queued,
      files: composed.map(name => ({ name, url: fileUrl(name) })),
      // The studio stopped half way: the jobs and files above did start (do not
      // run the model again for them), the rest did not.
      ...typeof answer.error === 'string' ? { error: answer.error } : {},
      ...queued.length === 0
        ? { next: 'Nothing to render: the files above are the whole result, composed by the studio. Look at them with imagine_view.' }
        : { next: 'Call imagine_job with these ids (wait_seconds up to 50), again while they run. A chained step is queued by the studio when the one before it finishes.' },
    }
  }))

  server.registerTool('imagine_job', {
    title: 'Follow a job',
    description: 'State of a job: queued, running (with percent and stage), done (with its files and URLs) or failed. wait_seconds (up to 50) keeps asking until it settles or the time is up; call it again while the job is still running — renders take minutes.',
    inputSchema: { job_id: z.string(), wait_seconds: z.number().int().min(0).max(50).default(0).describe('Keep asking for up to this many seconds (max 50: MCP clients cut longer calls). Call again while the job runs.') },
    annotations: { readOnlyHint: true },
  }, async ({ job_id, wait_seconds }) => guarded(async () => {
    const until = Date.now() + wait_seconds * 1000
    for (;;) {
      const job = await jobById(job_id)
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
    const response = await raw(`/comfy-imagine/${encodeURIComponent(job_id)}`, { method: 'DELETE' })
    await response.body?.cancel()
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

/** A base64 upload can be big: 200 MB of JSON at most. */
const MAX_BODY_BYTES = 200 * 1024 * 1024

/**
 * The request body parsed as JSON (undefined when empty), refused past
 * {@link MAX_BODY_BYTES}.
 *
 * Past the limit it stops keeping the bytes but goes on reading them, as
 * server/src/route-kit.ts's `readBody` does: throwing out of a `for await`
 * over the request destroys the socket, and the client then sees a dropped
 * connection instead of the 400 that names the reason. Not imported from
 * there: route-kit pulls the studio's gallery and stores into this bundle.
 */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let stopped = false
    req.on('data', (chunk: Buffer) => {
      if (stopped) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        stopped = true
        chunks.length = 0
        reject(new Error('body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (stopped) return
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(text === '' ? undefined : JSON.parse(text))
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error('Parse error'))
      }
    })
    req.on('error', reject)
  })
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
