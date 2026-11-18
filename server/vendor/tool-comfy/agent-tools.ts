/**
 * The agent's tools: what the model may ask the studio to do, the arguments it
 * may pass, and the executor of each.
 *
 * Every tool reuses the path the page and the MCP already use — a run goes
 * through `startFromBody` (`job-start.ts`), a look through the same vision
 * client and sight cache, a project file through the same gallery and notes.
 * Arguents are validated, never restyled: a ratio off the ladder, a name that
 * is not in the gallery, a zone past the edge is refused with a sentence the
 * model can correct. The prompt is the user's words, passed as they arrived.
 *
 * F1 covers a still, an edit, the masked removal, a look, the project's files
 * and a run's state. Everything that renders a clip is F2; a line asking for
 * one is told so instead of being answered with an invented action.
 * @module tool-comfy/agent-tools
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImagineHost } from '../../src/host.ts'
import { ERASE_FEATHER, grownRegion } from '../../../shared/imagine-grounding.ts'
import { IMAGE_RESOLUTIONS, IMAGINE_ASPECTS, type ImagineAspect, type ImagineResolution } from '../../../shared/imagine-media.ts'
import { sizeFor } from '../../../shared/imagine-sizing.ts'
import type { ImagineChatEvent } from '../../../shared/imagine-chat.ts'
import type { GalleryItem, ImagineJobView, ImagineRegion, MediaFileRef, ModelRoute } from '../../../shared/imagine-types.ts'
import type { AgentToolSchema } from '../../../shared/agent-chat.ts'
import { languageName } from '../../../shared/locale-names.ts'
import { featherMask, maskDataUrl, rectangleMask } from '../../../shared/masks.ts'
import { frameAt } from './media-tools.ts'
import { galleryItemOf, kindOf, listGallery, safeBasename } from './gallery.ts'
import { groundTarget } from './grounding.ts'
import { eyesOf } from './eyes.ts'
import { recallNotes, rememberSight } from './imagine-notes.ts'
import { sightInMemory } from './imagine-sight.ts'
import { loadImagineStore } from './imagine-store.ts'
import { lookWith } from './imagine-models.ts'
import type { ImagineJob } from './job-queue.ts'
import type { JobBody } from './job-start.ts'

/** What one tool call produced: the result the model reads, and the runs to wait for. */
export interface AgentToolOutcome {
  /** A small JSON object; a failure is `{ ok: false, error }`. */
  readonly result: Readonly<Record<string, unknown>>
  /** The runs this call queued, in order. */
  readonly jobs: readonly ImagineJob[]
  /** A file the host made without a job (the masked removal). */
  readonly files: readonly MediaFileRef[]
}

/** Everything the tools read off the turn. */
export interface AgentToolDeps {
  /** The host, for the vision client. */
  readonly ctx: ImagineHost
  /** The media directory. */
  readonly outputDir: string
  /** The board project the turn belongs to, when the page sent one. */
  readonly projectId?: string
  /** The model the composer shows: the route a look uses. */
  readonly model?: ModelRoute
  /** The interface's language, for the sight instruction. */
  readonly language?: string
  /** The user's line: a closed choice they named is recovered when the model drops it. */
  readonly asked: string
  /** Stops a look when the chat closes. */
  readonly signal?: AbortSignal
  /** Whether «Remove object» is mounted (the request says so). */
  readonly eraseTool: boolean
  /** The studio's own address, for the plugin route the eraser lives behind. */
  readonly selfURL?: string
  /** Starts one run: the route's `startFromBody`, or a fake in the tests. */
  readonly start: (body: JobBody) => Promise<readonly ImagineJob[]>
  /** One run with its live progress. */
  readonly jobView: (job: ImagineJob) => ImagineJobView
  /** The jobs still in memory. */
  readonly listJobs: () => readonly ImagineJob[]
  /** One job by id, when it is still in memory. */
  readonly getJob: (id: string) => ImagineJob | undefined
  /** Puts a host-made file into the project. */
  readonly adoptFiles: (names: readonly string[]) => Promise<void>
  /** The files the page offered the turn (staged and recent). */
  readonly known: readonly MediaFileRef[]
  /** How many more runs the turn may queue. */
  readonly canQueue: () => number
  /** Tells the page a step happened. */
  readonly say: (event: ImagineChatEvent) => void
}

/** The name the model uses, the schema it sees, and the call it runs. */
export interface AgentTool {
  readonly schema: AgentToolSchema
  run(args: Readonly<Record<string, unknown>>, deps: AgentToolDeps): Promise<AgentToolOutcome>
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined

/** One tool result with nothing queued. */
function done(result: Readonly<Record<string, unknown>>): AgentToolOutcome {
  return { result, jobs: [], files: [] }
}

/** A refusal the model can read and correct. */
function refused(error: string): AgentToolOutcome {
  return { result: { ok: false, error }, jobs: [], files: [] }
}

/** The gallery image a tool names, or a refusal. */
async function galleryImage(deps: AgentToolDeps, name: string): Promise<GalleryItem | string> {
  const safe = safeBasename(name)
  if (safe === undefined || kindOf(safe) !== 'image') return `"${name}" is not a picture in the gallery`
  const item = await galleryItemOf(deps.outputDir, safe)
  return item ?? `"${name}" is not in the gallery`
}

/** The longest prompt a tool takes: longer than any line a person writes. */
const MAX_PROMPT = 4_000

/** The batch ceiling the job route itself accepts. */
const MAX_COUNT = 8

/** How many files `project_files` returns when the model names no limit. */
const FILES_DEFAULT = 40

/** The most `project_files` will ever return: a digest, not a catalogue. */
const FILES_MAX = 80

/**
 * The tools, in the order the instruction lists them.
 *
 * A tool's `name` is the studio's word for the action, English like the rest
 * of the code. `prompt` is the user's own description: the executor trims it
 * and does nothing else to it.
 */
export const AGENT_TOOLS: readonly AgentTool[] = [
  {
    schema: {
      type: 'function',
      function: {
        name: 'generate_image',
        description: 'Queue a new picture. The prompt is the user\'s own description, copied as they wrote it: do not add style words they did not write.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'What to draw, in the user\'s words.' },
            aspect: { type: 'string', enum: [...IMAGINE_ASPECTS], description: 'Frame shape; omit for the studio default.' },
            resolution: { type: 'string', enum: [...IMAGE_RESOLUTIONS], description: 'Short side; 1080p when an aspect is named.' },
            count: { type: 'integer', minimum: 1, maximum: MAX_COUNT, description: 'How many variants.' },
          },
          required: ['prompt'],
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      const prompt = str(args['prompt'])
      if (prompt === undefined) return refused('prompt is required and cannot be empty')
      if (prompt.length > MAX_PROMPT) return refused(`prompt is longer than ${String(MAX_PROMPT)} characters`)
      /*
       * A closed choice the user named (a ratio, a resolution) is recovered
       * from their line when the model leaves the argument out: measured on
       * Strata, it kept the description and dropped "3:2" and "480p" from the
       * call while saying them in the reply. Filling a choice the user made is
       * not rewriting their prompt — that stays exactly as they wrote it.
       */
      const named = choicesInLine(deps.asked)
      const aspect = str(args['aspect']) ?? named.aspect
      if (aspect !== undefined && !(IMAGINE_ASPECTS as readonly string[]).includes(aspect)) {
        return refused(`aspect must be one of ${IMAGINE_ASPECTS.join(', ')}`)
      }
      const resolution = str(args['resolution']) ?? named.resolution
      if (resolution !== undefined && !(IMAGE_RESOLUTIONS as readonly string[]).includes(resolution)) {
        return refused(`resolution must be one of ${IMAGE_RESOLUTIONS.join(', ')}`)
      }
      const count = args['count'] === undefined ? 1 : Number(args['count'])
      if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
        return refused(`count must be an integer from 1 to ${String(MAX_COUNT)}`)
      }
      if (deps.canQueue() < count) return refused('this turn has already queued all the runs it may')
      const size = aspect === undefined ? undefined : sizeFor(aspect as ImagineAspect, (resolution ?? '1080p') as ImagineResolution)
      deps.say({ kind: 'step', step: 'tool', name: 'generate_image', detail: prompt, count })
      const jobs = await deps.start({
        action: 'generate',
        prompt,
        ...size === undefined ? {} : { size },
        ...aspect === undefined ? {} : { aspectRatio: aspect, canvasAsked: true },
        ...count > 1 ? { count } : {},
        ...deps.projectId === undefined ? {} : { projectId: deps.projectId },
        ...deps.model === undefined ? {} : { model: deps.model },
      })
      for (const job of jobs) deps.say({ kind: 'step', step: 'queued', jobId: job.id, detail: job.action })
      return {
        result: {
          ok: true,
          queued: jobs.map(job => job.id),
          state: 'queued',
          ...size === undefined ? {} : { size },
          ...aspect === undefined ? {} : { aspect },
        },
        jobs,
        files: [],
      }
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'edit_image',
        description: 'Change an existing picture. One change per call. The prompt is the user\'s words; name the thing to change in `target` when they did ("the red handbag"), or pass `region` for a marked zone. The rest of the photo is kept by the studio.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'The one change, in the user\'s words.' },
            source: { type: 'string', description: 'The picture to edit, by gallery name.' },
            target: { type: 'string', description: 'The thing in the photo the change is about, in the photo\'s own words.' },
            region: {
              type: 'object',
              description: 'A rectangle in fractions of the photo, when the user marked one.',
              properties: {
                x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
              },
              required: ['x', 'y', 'w', 'h'],
              additionalProperties: false,
            },
            reference: { type: 'string', description: 'A second picture to take something from (a garment, a style).' },
          },
          required: ['prompt', 'source'],
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      const prompt = str(args['prompt'])
      if (prompt === undefined) return refused('prompt is required and cannot be empty')
      if (prompt.length > MAX_PROMPT) return refused(`prompt is longer than ${String(MAX_PROMPT)} characters`)
      const source = str(args['source'])
      if (source === undefined) return refused('source is required: the picture to edit, by gallery name')
      const item = await galleryImage(deps, source)
      if (typeof item === 'string') return refused(item)
      const target = str(args['target'])
      let region = regionOf(args['region'])
      if (region === undefined && target !== undefined) {
        const sight = (await recallNotes([item.name])).get(item.name)?.sight ?? sightInMemory(item.name)
        const box = await groundTarget(deps.ctx, deps.outputDir, item.name, {
          target,
          ...sight === undefined ? {} : { description: sight },
        }, deps.model, deps.signal)
        if (box === undefined) {
          return refused(`could not find "${target}" in ${item.name}: name it in the photo's own words, or pass a region`)
        }
        region = box
        deps.say({ kind: 'step', step: 'grounding', detail: target })
      }
      const reference = str(args['reference'])
      if (reference !== undefined) {
        const other = await galleryImage(deps, reference)
        if (typeof other === 'string') return refused(other)
      }
      if (deps.canQueue() < 1) return refused('this turn has already queued all the runs it may')
      deps.say({ kind: 'step', step: 'tool', name: 'edit_image', detail: prompt })
      const jobs = await deps.start({
        action: 'remix',
        prompt,
        source: item.name,
        ...region === undefined ? {} : { region },
        ...reference === undefined ? {} : { reference },
        ...deps.projectId === undefined ? {} : { projectId: deps.projectId },
        ...deps.model === undefined ? {} : { model: deps.model },
      })
      for (const job of jobs) deps.say({ kind: 'step', step: 'queued', jobId: job.id, detail: job.action })
      return {
        result: { ok: true, queued: jobs.map(job => job.id), state: 'queued', source: item.name },
        jobs,
        files: [],
      }
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'erase',
        description: 'Take something out of a picture and fill the place from what is around it (the masked removal). Use this for a logo, a watermark, a mark printed on the photo — not for a redraw. Needs the eraser plugin.',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'The picture, by gallery name.' },
            target: { type: 'string', description: 'What has to disappear, in the photo\'s own words.' },
            region: {
              type: 'object',
              description: 'A rectangle in fractions of the photo, when one is marked.',
              properties: {
                x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
              },
              required: ['x', 'y', 'w', 'h'],
              additionalProperties: false,
            },
          },
          required: ['source'],
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      if (!deps.eraseTool) return refused('the eraser plugin is not mounted on this studio: use edit_image instead')
      if (deps.selfURL === undefined) return refused('the eraser is not reachable from the server')
      const source = str(args['source'])
      if (source === undefined) return refused('source is required: the picture, by gallery name')
      const item = await galleryImage(deps, source)
      if (typeof item === 'string') return refused(item)
      const target = str(args['target'])
      let region = regionOf(args['region'])
      if (region === undefined && target !== undefined) {
        const sight = (await recallNotes([item.name])).get(item.name)?.sight ?? sightInMemory(item.name)
        const box = await groundTarget(deps.ctx, deps.outputDir, item.name, {
          target,
          ...sight === undefined ? {} : { description: sight },
        }, deps.model, deps.signal)
        if (box === undefined) {
          return refused(`could not find "${target}" in ${item.name}: name it in the photo's own words, or pass a region`)
        }
        region = box
        deps.say({ kind: 'step', step: 'grounding', detail: target })
      }
      if (region === undefined) return refused('the thing to remove is missing: name a target or pass a region')
      const width = item.width
      const height = item.height
      if (width === undefined || height === undefined || width <= 0 || height <= 0) {
        return refused(`${item.name} has no measured size: the eraser needs the photo's pixels`)
      }
      const box = grownRegion(region)
      const feather = Math.max(2, Math.round(Math.min(width, height) * ERASE_FEATHER))
      const mask = featherMask(rectangleMask(width, height, box), feather)
      deps.say({ kind: 'step', step: 'tool', name: 'erase', detail: target ?? 'the marked zone' })
      let answer: Response
      try {
        answer = await fetch(`${deps.selfURL.replace(/\/+$/, '')}/plugin/iopaint/erase`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: item.name, mask: maskDataUrl(mask) }),
          signal: deps.signal,
        })
      } catch (error: unknown) {
        return refused(`the eraser did not answer: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!answer.ok) {
        const detail = await answer.text().catch(() => '')
        if (answer.status === 404) return refused('the eraser plugin is not mounted on this studio: use edit_image instead')
        return refused(`the eraser answered ${String(answer.status)}: ${detail.slice(0, 300)}`)
      }
      const made = await answer.json().catch(() => undefined) as GalleryItem | undefined
      if (made === undefined || typeof made.name !== 'string') return refused('the eraser answered no file')
      await deps.adoptFiles([made.name]).catch(() => undefined)
      return {
        result: { ok: true, file: made.name, kind: 'image', note: 'the rest of the photo is the source\'s own pixels' },
        jobs: [],
        files: [{ name: made.name, kind: 'image' }],
      }
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'look',
        description: 'Look at one file and describe what is in it, through the studio\'s vision pass. Use it after a run to check the result against the request, and before claiming what a photo contains.',
        parameters: {
          type: 'object',
          properties: {
            file: { type: 'string', description: 'The gallery file to look at.' },
            frame: { type: 'number', description: 'For a clip: the second to take a frame at. Default 0.' },
            question: { type: 'string', description: 'What to ask about the file; omit for a plain description.' },
          },
          required: ['file'],
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      const file = str(args['file'])
      if (file === undefined) return refused('file is required')
      const safe = safeBasename(file)
      if (safe === undefined) return refused(`"${file}" is not a gallery file name`)
      const kind = kindOf(safe)
      if (kind !== 'image' && kind !== 'video') return refused(`"${safe}" is not a picture or a clip`)
      const item = await galleryItemOf(deps.outputDir, safe)
      if (item === undefined) return refused(`"${safe}" is not in the gallery`)
      const eyes = eyesOf(deps.ctx, deps.model)
      if (eyes === undefined) return refused('no vision model is configured on this studio')
      const asked = str(args['question'])
      const instruction = asked ?? `Describe what is visible in this file, in ${languageName(deps.language)} and in 2-3 sentences. Name the subject, the setting, the dominant colours and any written text. Describe only what you see.`
      let target = join(deps.outputDir, safe)
      let scratch: string | undefined
      try {
        if (kind === 'video') {
          const at = Number(args['frame'] ?? 0)
          if (!Number.isFinite(at) || at < 0) return refused('frame must be a non-negative number of seconds')
          scratch = await mkdtemp(join(tmpdir(), 'imagine-agent-look-'))
          target = await frameAt(join(deps.outputDir, safe), join(scratch, 'frame.jpg'), { at, maxSide: 1024, quality: 3, timeoutMs: 20_000 })
        }
        const seen = await lookWith(eyes.vision, target, instruction, eyes.route, {
          ...deps.signal === undefined ? {} : { signal: deps.signal },
        })
        if (seen === undefined) return refused(`the vision model did not answer for ${safe}`)
        const text = seen.text.replace(/\s+/g, ' ').trim()
        await rememberSight(safe, text).catch(() => undefined)
        deps.say({ kind: 'step', step: 'looked', detail: safe })
        return done({ ok: true, file: safe, seen: text })
      } finally {
        if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
      }
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'project_files',
        description: 'The files of this project, newest first, with how each was made and what a vision pass saw in it. Use this instead of remembering names.',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['image', 'video', 'audio'], description: 'Only this kind, when set.' },
            limit: { type: 'integer', minimum: 1, maximum: FILES_MAX, description: 'How many files, newest first.' },
          },
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      const kind = str(args['kind'])
      if (kind !== undefined && kind !== 'image' && kind !== 'video' && kind !== 'audio') {
        return refused('kind must be image, video or audio')
      }
      const limit = args['limit'] === undefined ? FILES_DEFAULT : Number(args['limit'])
      if (!Number.isInteger(limit) || limit < 1 || limit > FILES_MAX) {
        return refused(`limit must be an integer from 1 to ${String(FILES_MAX)}`)
      }
      const names = await projectFileNames(deps)
      const gallery = new Map((await listGallery(deps.outputDir)).map(item => [item.name, item]))
      const shown = [...names].reverse().filter((name) => {
        const item = gallery.get(name)
        return item !== undefined && (kind === undefined || item.kind === kind)
      }).slice(0, limit)
      const notes = await recallNotes(shown)
      const files = shown.map((name) => {
        const item = gallery.get(name) as GalleryItem
        const note = notes.get(name)
        const seen = note?.sight ?? sightInMemory(name)
        return {
          name,
          kind: item.kind,
          ...item.width === undefined ? {} : { width: item.width },
          ...item.height === undefined ? {} : { height: item.height },
          ...note?.origin === undefined ? {} : { made: note.origin },
          ...seen === undefined ? {} : { seen },
        }
      })
      return done({ ok: true, files })
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'job_status',
        description: 'The state of one run by id, or of the runs still going. Use it to answer "is it done?" without guessing.',
        parameters: {
          type: 'object',
          properties: {
            job: { type: 'string', description: 'The run id; omit for the runs still going.' },
          },
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      const id = str(args['job'])
      if (id !== undefined) {
        const job = deps.getJob(id)
        if (job === undefined) return refused(`no run with id ${id} is in memory (runs live half an hour after they finish)`)
        return done({ ok: true, job: viewOf(deps, job) })
      }
      const live = deps.listJobs().filter(job => job.status === 'queued' || job.status === 'running')
      return done({ ok: true, jobs: live.map(job => viewOf(deps, job)), note: live.length === 0 ? 'no run is in progress' : undefined })
    },
  },
]

/**
 * The tools the loop offers, as the gateway takes them.
 * @returns the schemas, in catalogue order.
 */
export function agentToolSchemas(): readonly AgentToolSchema[] {
  return AGENT_TOOLS.map(tool => tool.schema)
}

/**
 * Run one tool call, checking its name and reporting a refusal as a result
 * rather than an exception: the model reads the sentence and corrects itself.
 * @param name - the tool the model named.
 * @param args - its arguments, already parsed from the model's JSON.
 * @param deps - the turn's state.
 * @returns the outcome, always (a failure is `{ ok: false, error }`).
 */
export async function runAgentTool(
  name: string,
  args: Readonly<Record<string, unknown>>,
  deps: AgentToolDeps,
): Promise<AgentToolOutcome> {
  const tool = AGENT_TOOLS.find(entry => entry.schema.function.name === name)
  if (tool === undefined) {
    return refused(`there is no tool called "${name}": use one of ${AGENT_TOOLS.map(entry => entry.schema.function.name).join(', ')}`)
  }
  try {
    return await tool.run(args, deps)
  } catch (error: unknown) {
    return refused(error instanceof Error ? error.message : String(error))
  }
}

/**
 * One run as the model reads it: state, where it is, and what it made.
 * @param deps - the turn's state, for the live progress.
 * @param job - the run.
 * @returns a compact object, no pixels.
 */
function viewOf(deps: AgentToolDeps, job: ImagineJob): Readonly<Record<string, unknown>> {
  const view = deps.jobView(job)
  const progress = view.progress
  return {
    id: job.id,
    action: job.action,
    state: job.status,
    prompt: job.prompt.length > 300 ? `${job.prompt.slice(0, 299)}…` : job.prompt,
    ...job.source === undefined ? {} : { source: job.source },
    ...progress?.percent === undefined ? {} : { percent: progress.percent },
    ...progress?.nodeClass === undefined ? {} : { stage: progress.nodeClass },
    ...progress?.etaSeconds === undefined ? {} : { etaSeconds: progress.etaSeconds },
    ...job.error === undefined ? {} : { error: job.error },
    ...job.files === undefined || job.files.length === 0 ? {} : { files: job.files.map(file => file.name) },
  }
}

/**
 * The names of the project's files, oldest first: what it lists, what its runs
 * in memory made, and what the host adopted into it.
 * @param deps - the turn's state.
 * @returns the names, deduplicated, without the page's own offer as a fallback.
 */
async function projectFileNames(deps: AgentToolDeps): Promise<string[]> {
  const names = new Set<string>()
  if (deps.projectId !== undefined) {
    const store = await loadImagineStore().catch(() => undefined)
    const project = store?.projects.find(entry => entry.id === deps.projectId)
    if (project !== undefined) {
      for (const name of project.itemNames) names.add(name)
      for (const id of project.jobIds) {
        const job = deps.getJob(id)
        for (const file of job?.files ?? []) names.add(file.name)
      }
      const adopted = store?.adopted[deps.projectId] ?? {}
      for (const key of Object.keys(adopted)) {
        if (kindOf(key) !== undefined) names.add(key)
      }
    }
  }
  if (names.size === 0) for (const file of deps.known) names.add(file.name)
  return [...names]
}

/**
 * The choices a line names in the studio's own spelling: a ratio or a
 * resolution, which the model may leave out of the call even when it repeats
 * them in its reply.
 * @param asked - the user's line.
 * @returns the aspect and the resolution it names, when it names them.
 */
export function choicesInLine(asked: string): { aspect?: ImagineAspect; resolution?: ImagineResolution } {
  const resolutionWord = /\b(480p|720p|1080p|1440p)\b/i.exec(asked)?.[1]?.toLowerCase()
  const ratio = /\b(\d{1,2}:\d{1,2})\b/.exec(asked)?.[1]
  const words: readonly (readonly [RegExp, ImagineAspect])[] = [
    [/\bquadrat[oaie]\b/i, '1:1'],
    [/\bvertical[ei]?\b|\bportrait\b/i, '9:16'],
    [/\borizzontal[ei]?\b|\blandscape\b|\bwidescreen\b/i, '16:9'],
  ]
  const named: ImagineAspect | undefined = ratio !== undefined && (IMAGINE_ASPECTS as readonly string[]).includes(ratio)
    ? ratio as ImagineAspect
    : words.find(([pattern]) => pattern.test(asked))?.[1]
  return {
    ...named === undefined ? {} : { aspect: named },
    ...resolutionWord === undefined || !(IMAGE_RESOLUTIONS as readonly string[]).includes(resolutionWord)
      ? {}
      : { resolution: resolutionWord as ImagineResolution },
  }
}

/**
 * A region out of the model's arguments, checked by the shared rule when the
 * removal or the edit reaches the job.
 * @param value - the `region` argument.
 * @returns the region, or undefined when the model sent none.
 */
function regionOf(value: unknown): ImagineRegion | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { x, y, w, h } = value as Record<string, unknown>
  if (![x, y, w, h].every(part => typeof part === 'number' && Number.isFinite(part))) return undefined
  return { x: x as number, y: y as number, w: w as number, h: h as number }
}
