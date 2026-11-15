/**
 * The routes under `/comfy-imagine`: the job queue, the projects, the
 * workflows and their edits, the settings page, the ComfyUI server, the
 * music-video form, sight, titles and the chat — one table from the path after
 * the prefix to the handler that answers it.
 * @module tool-comfy/imagine-routes
 */

import { SWAP_RESOLUTIONS, type SwapResolution } from '../../../shared/imagine-sizing.ts'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ImagineHost } from '../../src/host.ts'
import { currentLanguage, message, translateMessage } from '../../src/messages.ts'
import { allowOnly, languageOf, notAllowed, readObject, restOf, sendJson } from '../../src/route-kit.ts'
import { kindOf, safeBasename } from './gallery.ts'
import { isPlainObject } from './guards.ts'
import { isImagineAction } from './imagine-actions.ts'
import { readImagineChat, type ImagineChatRequest, type WorkflowInventory } from './imagine-chat.ts'
import {
  cancelImagineJob, getImagineJob, listImagineJobs, pruneOldJobs, startImagineJob, type ImagineJob, type SpeakTarget,
} from './imagine-jobs.ts'
import { approveSetup } from './job-queue.ts'
import { invalidChoiceReason } from './job-request.ts'
import {
  applyOverrideOps, imagineSettingsPath, readImagineOverrides, saveImagineOverrides, workflowConfigKey, type WorkflowMap,
} from './imagine-settings.ts'
import { lookSoon } from './imagine-sight.ts'
import { adoptJobsInto, loadImagineStoreJson, saveImagineStore } from './imagine-store.ts'
import { startMusicClip } from './music-clip.ts'
import type { LoraInGraph } from './lora.ts'
import { loraRoute } from './custom-workflow-routes.ts'
import { readProjectTitle } from './project-title.ts'
import { parseSize } from './snap-size.ts'
import type { WorkflowChange } from './workflow-edit.ts'
import type { ImagineSettingsView, WorkflowDetail } from '../../../shared/imagine-settings-view.ts'
import { WORKFLOW_KEYS, type ImagineWorkflows } from './workflow-fields.ts'
import type {
  ImagineJobView, ImagineObjectMode, ImaginePlacement, ImagineQuality, ImagineRegion,
  ImagineSettingOp, ImagineSpeed, ModelRoute,
} from '../../../shared/imagine-types.ts'

/** Everything the studio's routes are handed at boot. */
interface ImagineRoutes {
  /** Plugin context. */
  readonly ctx: ImagineHost
  /** The workflows the studio may talk about. */
  readonly inventory: WorkflowInventory
  /** Applies a confirmed workflow change. */
  readonly applyWorkflow: (key: string, changes: readonly WorkflowChange[]) => Promise<{ backup: string; applied: number }>
  /** Adds a LoRA to one workflow's model chain. */
  readonly addLora: (key: string, request: { readonly loraName: string; readonly strength: number }) =>
  Promise<{ backup: string; loras: readonly LoraInGraph[] }>
  /** Takes a LoRA out by node id. */
  readonly removeLora: (key: string, node: string) => Promise<{ backup: string; loras: readonly LoraInGraph[] }>
  /** The LoRAs one workflow carries. */
  readonly lorasOf: (key: string) => readonly LoraInGraph[] | undefined
  /**
   * Change one LoRA's strength.
   *
   * Its own path and not a `changes` entry: that list addresses node inputs,
   * and this is a node that may not have existed when the page was opened.
   */
  readonly tuneLora: (key: string, node: string, strength: number) =>
  Promise<{ backup: string; loras: readonly LoraInGraph[] }>
  /** The loaded graphs. */
  readonly workflows: ImagineWorkflows
  /** The validated media output directory. */
  readonly outputDir: string
  /** The configuration layers this entry booted with. */
  readonly settings: ImagineSettingsSurface
  /** Where a `speak` job reads its text out loud, when configured. */
  readonly speak: SpeakTarget | undefined
}

/** One named route: the request, the response and what the routes were handed. */
type Route = (req: IncomingMessage, res: ServerResponse, routes: ImagineRoutes) => Promise<void>

/**
 * Serve the studio's jobs and everything around them: GET /comfy-imagine lists
 * the jobs, GET /comfy-imagine/<id> returns one, POST /comfy-imagine starts
 * one in the background, DELETE stops it; the named paths are {@link ROUTES}
 * and `workflows/<key>`.
 * @param routes - what the routes were handed at boot.
 * @returns the route handler.
 */
export function imagineHandler(routes: ImagineRoutes): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const rest = restOf(req, res, '/comfy-imagine')
    if (rest === undefined) return
    const named = Object.hasOwn(ROUTES, rest) ? ROUTES[rest] : undefined
    if (named !== undefined) {
      await named(req, res, routes)
      return
    }
    if (rest.startsWith('workflows/')) {
      await workflowRoute(req, res, routes, rest.slice('workflows/'.length))
      return
    }
    // Every named route is above, so what is left is a job id: GET reads one
    // run with its progress, DELETE stops it, and the bare queue is the
    // listing and the POST.
    await jobRoute(req, res, routes, rest)
  }
}

/**
 * The shared studio: GET reads it with a validator, PUT merges a payload in.
 *
 * The PUT may name only part of the studio (`saveImagineStore` keeps every
 * project, tile and tombstone the payload leaves out), and its answer is a
 * bare `{ ok: true }`: until 2026-11-07 it echoed the whole store (~1 MB,
 * stringified afresh) to a client that cancelled the body unread. Not a 204:
 * Chromium surfaces a zero-byte answer on a keep-alive connection as
 * net::ERR_ABORTED (see the DELETE in `jobRoute`). The next GET revalidates
 * with the ETag.
 */
const projectsRoute: Route = async (req, res) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    writeJsonTagged('projects', req, res, req.method, await loadImagineStoreJson())
    return
  }
  if (req.method === 'PUT') {
    const body = await readObject(req, STUDIO_BODY_BYTES)
    await saveImagineStore(body)
    sendJson(res, 200, { ok: true })
    return
  }
  notAllowed(res, 'GET, HEAD, PUT')
}

/**
 * The workflows the studio may talk about, and the confirmed half of a
 * workflow change. Its own route, and a POST: the reading proposes, the user
 * says yes, and only then does anything reach the file.
 */
const workflowsRoute: Route = async (req, res, { inventory, applyWorkflow }) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    sendJson(res, 200, { workflows: inventory.list })
    return
  }
  if (!allowOnly(req, res, 'GET', 'HEAD', 'POST')) return
  const asked = await readObject<{ key?: string; changes?: WorkflowChange[] }>(req, SMALL_BODY_BYTES)
  if (typeof asked.key !== 'string' || !Array.isArray(asked.changes) || asked.changes.length === 0) {
    sendJson(res, 400, { error: message('workflow.keyAndChanges') })
    return
  }
  try {
    sendJson(res, 200, { ok: true, ...await applyWorkflow(asked.key, asked.changes) })
  } catch (error: unknown) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : message('change.failed') })
  }
}

/**
 * The Imagine settings page: it reads the layers this process holds and
 * writes its own, which the next boot merges over `config.yaml`.
 */
const settingsRoute: Route = async (req, res, { ctx, inventory, settings }) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    sendJson(res, 200, await describeImagineSettings(ctx, inventory, settings))
    return
  }
  if (!allowOnly(req, res, 'GET', 'HEAD', 'POST')) return
  const asked = await readObject<{ ops?: ImagineSettingOp[] }>(req, SMALL_BODY_BYTES)
  if (!Array.isArray(asked.ops) || asked.ops.length === 0) {
    sendJson(res, 400, { error: message('settings.opsRequired') })
    return
  }
  const current = await readImagineOverrides()
  /*
   * A file that was refused reads as an empty layer: editing on top of it
   * and saving would replace every override it held with this one change.
   */
  if (current.problem !== undefined) {
    sendJson(res, 400, {
      error: message('settings.cannotSave', { problem: current.problem }),
    })
    return
  }
  const { next, errors } = applyOverrideOps(current.overrides, asked.ops)
  if (errors.length > 0) {
    sendJson(res, 400, { error: errors.join('; ') })
    return
  }
  try {
    await saveImagineOverrides(next)
  } catch (error: unknown) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : message('write.failed') })
    return
  }
  sendJson(res, 200, await describeImagineSettings(ctx, inventory, settings))
}

/**
 * Live state of the connected ComfyUI. A server that does not answer is a
 * state this page exists to show, not a failed request.
 */
const serverRoute: Route = async (req, res, { ctx }) => {
  if (!allowOnly(req, res, 'GET', 'HEAD')) return
  const endpoint = ctx.comfy.endpoint
  try {
    const report = await ctx.comfy.serverReport()
    sendJson(res, 200, { ok: true, endpoint, ...report })
  } catch (error: unknown) {
    sendJson(res, 200, {
      ok: false,
      endpoint,
      error: error instanceof Error ? error.message : message('comfy.unreachable'),
    })
  }
}

/** Restart ComfyUI with the configured command. */
const serverRestartRoute: Route = async (req, res, { ctx }) => {
  if (!allowOnly(req, res, 'POST')) return
  if (!ctx.comfy.canRestart) {
    sendJson(res, 409, { error: message('comfy.noRestartCommand') })
    return
  }
  try {
    await ctx.comfy.restartServer()
    sendJson(res, 200, { ok: true })
  } catch (error: unknown) {
    sendJson(res, 502, { error: error instanceof Error ? error.message : message('comfy.restartFailed') })
  }
}

/**
 * The music-video form: one look, a genre, a voice and the words. It queues
 * the photos and the song and answers with their job ids; the montage is
 * started by the chain itself, once those have names.
 */
const clipRoute: Route = async (req, res, { ctx, workflows, outputDir }) => {
  if (!allowOnly(req, res, 'POST')) return
  const asked = await readObject<{
    look?: unknown
    genre?: unknown
    voice?: unknown
    lyrics?: unknown
    seconds?: unknown
    aspectRatio?: unknown
    size?: unknown
    model?: unknown
    projectId?: unknown
  }>(req, SMALL_BODY_BYTES)
  if (typeof asked.look !== 'string' || asked.look.trim().length === 0) {
    sendJson(res, 400, { error: message('music.lookRequired') })
    return
  }
  /*
   * The look is the words the user wrote: there is no catalogue to check it
   * against any more, so the form's value travels as it is.
   */
  const model = routeOf(asked.model)
  const projectId = projectIdOf(asked.projectId)
  try {
    const plan = await startMusicClip(ctx, workflows, outputDir, {
      look: asked.look,
      genre: typeof asked.genre === 'string' ? asked.genre : '',
      voice: asked.voice === 'male' ? 'male' : 'female',
      lyrics: typeof asked.lyrics === 'string' ? asked.lyrics : '',
      ...typeof asked.seconds === 'number' ? { seconds: asked.seconds } : {},
      ...typeof asked.aspectRatio === 'string' ? { aspectRatio: asked.aspectRatio } : {},
      ...typeof asked.size === 'string' ? { size: asked.size } : {},
      ...model === undefined ? {} : { model },
      ...projectId === undefined ? {} : { projectId },
    })
    sendJson(res, 202, plan)
  } catch (error: unknown) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * "Look at these, I'll ask later." The studio posts the board's stills when a
 * project opens, so that a line about them finds descriptions on file instead
 * of names. Nothing waits: the looks run behind, one vision call per file
 * never seen before, and the answer says only how many were started.
 */
const sightRoute: Route = async (req, res, { ctx, outputDir }) => {
  if (!allowOnly(req, res, 'POST')) return
  const asked = await readObject<{ names?: unknown }>(req, SMALL_BODY_BYTES)
  const names = (Array.isArray(asked.names) ? asked.names : [])
    // Clips are read through one of their own frames now, so a video is a
    // file that can be described too: the details card asks for one when the
    // file has no sight yet (2026-10-31).
    .filter((name): name is string => {
      if (typeof name !== 'string' || safeBasename(name) === undefined) return false
      const kind = kindOf(name)
      return kind === 'image' || kind === 'video'
    })
    .slice(0, 200)
  const queued = lookSoon(ctx, outputDir, names)
  sendJson(res, 202, { queued })
}

/**
 * A short name for the project the studio is about to fill: one bounded text
 * call, no side effect. The client asks fire and forget and keeps the
 * provisional name when nothing comes back, so a 200 with no title is a normal
 * answer, not an error.
 */
const titleRoute: Route = async (req, res, { ctx }) => {
  if (!allowOnly(req, res, 'POST')) return
  const asked = await readObject<{ text?: unknown; model?: unknown }>(req, SMALL_BODY_BYTES)
  if (typeof asked.text !== 'string' || asked.text.trim().length === 0) {
    sendJson(res, 400, { error: message('request.textRequired') })
    return
  }
  const title = await readProjectTitle(ctx, asked.text, routeOf(asked.model), languageOf(req))
  sendJson(res, 200, title === undefined ? {} : { title })
}

/**
 * The studio's written lane. It reads a line and answers with the runs it
 * asks for; the client starts them, so a misreading here can be corrected by
 * the next sentence instead of costing GPU time.
 */
const chatRoute: Route = async (req, res, { ctx, inventory, workflows, outputDir }) => {
  if (!allowOnly(req, res, 'POST')) return
  let asked = await readObject<ImagineChatRequest>(req, CHAT_BODY_BYTES)
  // The language comes from the header the client sends on every call: the
  // request body must not carry it.
  asked = { ...asked, language: languageOf(req) }
  if (typeof asked.text !== 'string' || asked.text.trim().length === 0) {
    sendJson(res, 400, { error: message('request.textRequired') })
    return
  }
  /*
   * The voices are the host's to know: they are the models installed on
   * the ComfyUI box. Without the list the reader answers "certo, con la
   * voce di Mariah Carey" and the run quietly uses the workflow's own.
   */
  if (workflows.changeVoice?.voices !== undefined) {
    asked = { ...asked, voices: workflows.changeVoice.voices }
  }
  /*
   * `stream: true` asks for the same answer with the steps that produced
   * it, as they happen: the studio's chat is one call and not an agent
   * turn, so without this the column can only show a spinner between the
   * line and the runs — twelve seconds of reading and a reading that had
   * already failed looked the same. The JSON form stays for every caller
   * that does not ask.
   */
  if ((asked as { stream?: unknown }).stream === true) {
    await streamImagineChat(ctx, res, asked, inventory, outputDir)
    return
  }
  sendJson(res, 200, await readImagineChat(ctx, asked, inventory, outputDir))
}

/** The named paths under `/comfy-imagine`, and the handler of each. */
const ROUTES: Readonly<Record<string, Route>> = {
  projects: projectsRoute,
  workflows: workflowsRoute,
  settings: settingsRoute,
  server: serverRoute,
  'server/restart': serverRestartRoute,
  clip: clipRoute,
  sight: sightRoute,
  title: titleRoute,
  chat: chatRoute,
}

/**
 * One workflow: `plan` previews a change with nothing written, `<key>` reads
 * its fields and warnings, `<key>/options` the values one input accepts.
 * @param req - the request.
 * @param res - the response.
 * @param routes - what the routes were handed at boot.
 * @param target - the path after `workflows/`.
 */
async function workflowRoute(
  req: IncomingMessage,
  res: ServerResponse,
  { ctx, inventory, addLora, removeLora, lorasOf, tuneLora }: ImagineRoutes,
  target: string,
): Promise<void> {
  if (target === 'plan') {
    if (!allowOnly(req, res, 'POST')) return
    const asked = await readObject<{ key?: string; changes?: WorkflowChange[] }>(req, SMALL_BODY_BYTES)
    if (typeof asked.key !== 'string' || !Array.isArray(asked.changes)) {
      sendJson(res, 400, { error: message('workflow.keyAndChanges') })
      return
    }
    const planned = inventory.plan(asked.key, asked.changes)
    if (planned === undefined) {
      sendJson(res, 404, { error: message('workflow.notConfigured', { key: asked.key }) })
      return
    }
    sendJson(res, 200, planned)
    return
  }
  const slash = target.indexOf('/')
  const key = slash < 0 ? target : target.slice(0, slash)
  const listed = inventory.list.find(entry => entry.key === key)
  if (listed === undefined) {
    sendJson(res, 404, { error: message('workflow.notConfigured', { key }) })
    return
  }
  if (slash >= 0) {
    const sub = target.slice(slash + 1)
    /*
     * The LoRAs of one workflow: the list, one added, one removed. A node is
     * not a value, so this is its own path rather than a `changes` entry.
     */
    if (sub === 'loras' || sub.startsWith('loras/')) {
      await loraRoute(req, res, sub, {
        list: () => lorasOf(key) ?? [],
        add: async request => await addLora(key, request),
        tune: async (node, strength) => await tuneLora(key, node, strength),
        remove: async node => await removeLora(key, node),
      })
      return
    }
    if (sub !== 'options') {
      sendJson(res, 404, { error: message('route.notFound') })
      return
    }
    if (!allowOnly(req, res, 'GET', 'HEAD')) return
    const url = new URL(req.url ?? '/', 'http://x')
    const node = url.searchParams.get('node') ?? ''
    const field = url.searchParams.get('field') ?? ''
    // `class` answers "what LoRAs are installed", which no node in the graph
    // can be asked before one has been added.
    const classType = url.searchParams.get('class') ?? ''
    const options = classType !== '' && field !== ''
      ? await ctx.comfy.nodeOptions(classType, field)
      : node === '' || field === '' ? undefined : await inventory.options(key, node, field)
    sendJson(res, 200, { options: options ?? [] })
    return
  }
  if (!allowOnly(req, res, 'GET', 'HEAD')) return
  sendJson(res, 200, {
    key,
    label: listed.label,
    file: listed.file,
    fields: inventory.fields(key) ?? [],
    warnings: inventory.warnings(key) ?? [],
  } satisfies WorkflowDetail)
}

/**
 * The job queue: GET lists it or reads one job, DELETE stops one, POST starts one.
 * @param req - the request.
 * @param res - the response.
 * @param routes - what the routes were handed at boot.
 * @param jobId - the path after the prefix; empty for the queue itself.
 */
async function jobRoute(
  req: IncomingMessage,
  res: ServerResponse,
  { ctx, workflows, outputDir, speak }: ImagineRoutes,
  jobId: string,
): Promise<void> {
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (jobId.length === 0) {
      pruneOldJobs()
      // Tagged like the studio and the gallery: the page asks every second or
      // three, and most answers repeat the last one.
      writeJsonTagged('jobs', req, res, req.method, JSON.stringify({ jobs: listImagineJobs().map(job => jobWithProgress(ctx, job)) }))
      return
    }
    const job = getImagineJob(jobId)
    if (job === undefined) {
      sendJson(res, 404, { error: message('job.notFound', { id: jobId }) })
      return
    }
    sendJson(res, 200, jobWithProgress(ctx, job))
    return
  }
  if (req.method === 'DELETE') {
    // The GPU is serial, so a mistaken start otherwise holds the queue until
    // it finishes, with nothing in the UI able to end it.
    if (jobId.length === 0) {
      notAllowed(res, 'GET, HEAD, POST')
      return
    }
    const stopped = await cancelImagineJob(ctx, jobId)
    // The body must not be empty: Chromium surfaces a zero-byte response on a
    // keep-alive connection as net::ERR_ABORTED even though it completed.
    sendJson(res, stopped ? 200 : 404, { ok: stopped })
    return
  }
  if (req.method !== 'POST') {
    notAllowed(res, 'GET, HEAD, POST, DELETE')
    return
  }
  // «Install»: the user's yes to what ComfyUI has to install for this job.
  if (jobId.endsWith('/setup')) {
    const approved = approveSetup(jobId.slice(0, -'/setup'.length))
    sendJson(res, approved ? 200 : 404, { ok: approved })
    return
  }
  const body = await readObject<{
    action?: string
    prompt?: string
    source?: string
    size?: string
    aspectRatio?: string
    seconds?: number
    megapixels?: number
    /** Character and object swap only: `480p`, `720p` or `1080p`. */
    swapResolution?: string
    /** The clip's render speed: `fast` as the graph ships, `slow` for more steps. */
    speed?: string
    /** The photo's recipe: `standard` as the graph ships, `high` for more steps. */
    quality?: string
    lyrics?: string
    voice?: string
    pitch?: number
    count?: number
    /** `scanFrame` only: how many candidate frames to draw (1-20). */
    candidates?: number
    /** `custom` only: which uploaded workflow to run. */
    customWorkflowId?: string
    /** `custom` only: the card's own controls, keyed `<node>.<field>`. */
    customFields?: Record<string, unknown>
    /** `custom` only: the card's file slots, keyed by node id. */
    customFiles?: Record<string, string>
    /**
     * A recreation's opening frame, already in the gallery: one of the
     * candidates a `scanFrame` drew, or a frame of an earlier run. Handed in,
     * the run draws nothing and renders from that picture.
     */
    frame?: string
    song?: string
    /** The second photo of an `objectSwap` or a `compose`; the first file travels in `source`. */
    reference?: string
    /** `relight` only: the light look to paint, by slug. */
    light?: string
    /**
     * `objectSwap` only: which of the four recipes runs — `change` (the photo
     * goes in), `remove`, `background`, `add`. Checked against the shared list
     * by `invalidChoiceReason` before a job exists.
     */
    objectMode?: string
    /**
     * `objectSwap` only, `add` mode: the box the new object goes into, as
     * shares of the frame ({ x, y, width, height }). Checked by
     * `invalidChoiceReason` before a job exists.
     */
    placement?: unknown
    upscaleTo?: number
    region?: unknown
    lastSource?: string
    mask?: string
    sources?: unknown
    clipSeconds?: number
    /** A montage whose shots stay in their own photo, joined on hard cuts. */
    hardCuts?: boolean
    /**
     * Whether a recreation keeps the reference clip's soundtrack.
     *
     * Absent or false leaves the audio the video model wrote under the new
     * picture; true lays the reference clip's own track over the finished
     * video, which is what a recreation of a filmed clip usually wants.
     */
    keepAudio?: boolean
    /** Character swap only: false turns lip-sync off (the people do not sing or talk along). */
    lipSync?: boolean
    /**
     * The board project this generation belongs to. The jobs are adopted
     * into it at once, so the canvas shows them while they run.
     */
    projectId?: unknown
    model?: unknown
  }>(req, MAX_BODY_BYTES)
  if (!isImagineAction(body.action)) {
    sendJson(res, 400, { error: message('job.actionInvalid') })
    return
  }
  // Reject bad parameters here rather than letting the job be created and
  // die later: a caller that sends the label it sees on the button ("720p")
  // should read why at the POST, not poll a queued job into an error.
  const invalid = invalidRequestReason(body) ?? invalidChoiceReason(body)
  if (invalid !== undefined) {
    sendJson(res, 400, { error: invalid })
    return
  }
  // The model the composer's chip is showing. Imagine writes text before it
  // runs a graph — a song's caption and structure tags, a story's beats, a
  // look's rewrite — and those passes take this route first, so the chip
  // names the model that actually writes rather than one the deployment
  // pinned behind it.
  const chosen = routeOf(body.model)
  try {
    // The card's file slots, read once: the job takes them and the project adopts them.
    const customFiles = isPlainObject(body.customFiles)
      ? Object.fromEntries(Object.entries(body.customFiles)
        .filter((entry): entry is [string, string] => /^\d+$/.test(entry[0]) && typeof entry[1] === 'string' && entry[1].length > 0))
      : undefined
    const job = await startImagineJob(ctx, workflows, outputDir, {
      action: body.action,
      prompt: typeof body.prompt === 'string' ? body.prompt : '',
      ...typedFields(body, JOB_FIELDS),
      // Already checked against the ladder by `invalidRequestReason`.
      ...(SWAP_RESOLUTIONS as readonly unknown[]).includes(body.swapResolution)
        ? { swapResolution: body.swapResolution as SwapResolution }
        : {},
      ...isPlainObject(body.customFields) ? { customFields: body.customFields } : {},
      ...customFiles === undefined ? {} : { customFiles },
      ...typeof body.region === 'object' && body.region !== null ? { region: body.region as ImagineRegion } : {},
      // One photo per shot: a montage instead of a single take. Filtered to
      // strings here so a malformed body cannot reach the queue as a name.
      ...Array.isArray(body.sources)
        ? { sources: body.sources.filter((name): name is string => typeof name === 'string') }
        : {},
      ...body.hardCuts === true ? { hardCuts: true } : {},
      ...body.keepAudio === true ? { keepAudio: true } : {},
      ...body.lipSync === false ? { lipSync: false } : {},
      // Already checked against the shared lists by `invalidChoiceReason`.
      ...body.speed === undefined ? {} : { speed: body.speed as ImagineSpeed },
      ...body.quality === undefined ? {} : { quality: body.quality as ImagineQuality },
      ...body.objectMode === undefined ? {} : { objectMode: body.objectMode as ImagineObjectMode },
      // The box is an object, not one of the scalar fields above: it reaches
      // the plan as it came, and the plan checks it (and defaults it).
      ...typeof body.placement === 'object' && body.placement !== null
        ? { placement: body.placement as ImaginePlacement }
        : {},
      ...chosen === undefined ? {} : { model: chosen },
    }, speak)
    /*
     * A job queued from outside the studio belongs to the project it names,
     * from the moment it is queued.
     *
     * The board draws a live tile only for the jobs a project lists, so a
     * generation started through this route was invisible while it ran: the
     * work happened and the canvas showed nothing until it finished (the
     * user asked three times why). A story's shots are all queued before
     * this returns, so adopting by their story puts the whole chain on the
     * board live.
     */
    const project = projectIdOf(body.projectId)
    if (project !== undefined) {
      const mine = job.storyId === undefined
        ? [job.id]
        : listImagineJobs().filter(seen => seen.storyId === job.storyId).map(seen => seen.id)
      /*
       * The files the job starts from go into the project too (2026-11-07).
       * The page puts a file on the board when it is uploaded or dropped; a
       * job queued from outside (an LLM, the MCP) only named it, so the
       * project showed the results and none of the clips they were made from
       * ("I have to go and find them one by one in the media"). A file key in the
       * adoptions is a file, a bare id is a job (`withSharedEdits`).
       */
      const inputs = [body.source, body.reference, body.lastSource, body.frame, body.song,
        ...Array.isArray(body.sources) ? body.sources : [],
        ...Object.values(customFiles ?? {})]
        .filter((name): name is string => typeof name === 'string' && safeBasename(name) === name && kindOf(name) !== undefined)
      await adoptJobsInto([project], [...mine, ...new Set(inputs)]).catch(() => undefined)
    }
    sendJson(res, 202, job)
  } catch (error: unknown) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}


/**
 * The plain fields of a job request and the type each must have: a field of
 * another type is dropped, as the spread-per-field this replaced did.
 */
const JOB_FIELDS = {
  source: 'string', size: 'string', aspectRatio: 'string', seconds: 'number', megapixels: 'number',
  lyrics: 'string', voice: 'string', pitch: 'number', count: 'number', candidates: 'number', song: 'string', reference: 'string',
  frame: 'string', upscaleTo: 'number',
  lastSource: 'string', mask: 'string', clipSeconds: 'number', customWorkflowId: 'string',
  light: 'string',
} as const

interface FieldTypes { string: string; number: number }

/**
 * The fields of an untrusted body that have the type the spec names.
 * @param body - the parsed request.
 * @param spec - field name → `typeof` it must have.
 * @returns the kept fields, typed.
 */
function typedFields<S extends Readonly<Record<string, keyof FieldTypes>>>(
  body: object,
  spec: S,
): { -readonly [K in keyof S]?: FieldTypes[S[K]] } {
  const kept: Record<string, unknown> = {}
  for (const [field, type] of Object.entries(spec)) {
    const value = (body as Record<string, unknown>)[field]
    if (typeof value === type) kept[field] = value
  }
  return kept as { -readonly [K in keyof S]?: FieldTypes[S[K]] }
}

/**
 * One provider/model pair off an untrusted body, or nothing.
 *
 * Both halves have to be non-empty strings: a half-written route reaches
 * `textRoutes` as the first candidate and every text pass then fails on it
 * before falling back, which reads as a studio that stopped writing prompts.
 * @param value - the `model` field as it arrived.
 * @returns the route, or undefined when the body did not carry a usable one.
 */
function routeOf(value: unknown): ModelRoute | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { provider, model } = value as { provider?: unknown; model?: unknown }
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return { provider, model }
}

/**
 * Attach the live ComfyUI progress snapshot to a live job, when the tracking
 * client knows its prompt id.
 * @param ctx - plugin context carrying the `comfy` client.
 * @param job - the Imagine job.
 * @returns the job with a `progress` field, when available.
 */
function jobWithProgress(ctx: ImagineHost, job: ImagineJob): ImagineJobView {
  /*
   * A job's reason is written when it happens, by the worker, in the base
   * language (`enqueueJob` runs it under none): here, where the job goes out
   * to whoever is watching it, a table sentence — fixed, or with its
   * placeholders read back — takes the reader's language.
   */
  const localized: ImagineJob = job.error === undefined ? job : { ...job, error: translateMessage(job.error, currentLanguage()) }
  // ComfyUI installing what the job needs: that is the progress there is.
  if (localized.promptId === undefined && localized.status === 'running' && localized.setupProgress !== undefined) {
    const { percent, etaSeconds } = localized.setupProgress
    return { ...localized, progress: { percent, ...etaSeconds === undefined ? {} : { etaSeconds } } }
  }
  if (localized.promptId === undefined || (localized.status !== 'queued' && localized.status !== 'running')) return localized
  const progress = ctx.comfy.progressOf(localized.promptId)
  return progress === undefined ? localized : { ...localized, progress }
}

/**
 * The board project a request names, or nothing: a non-empty name that is
 * not a path.
 * @param value - the `projectId` field as it arrived.
 * @returns the project id, or undefined.
 */
function projectIdOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && !value.includes('/') ? value : undefined
}

/**
 * Maximum size of a JSON body these routes read into memory (80 MB): only
 * for a body that can carry pixels — a job request with a painted mask as a
 * data URL. Dropped media does not pass through here: it is streamed to disk
 * by `saveGalleryUploadStream`, and has no size ceiling.
 */
const MAX_BODY_BYTES = 80 * 1024 * 1024

/**
 * The whole studio as one document (~1.4 MB on the reference deployment):
 * a PUT from a client that still sends every project must keep fitting as
 * the rail grows, so the ceiling is generous; a partial save is far smaller.
 */
const STUDIO_BODY_BYTES = 32 * 1024 * 1024

/**
 * One chat line with the context it was written in: the history the client
 * already trimmed, file names with their notes, the running jobs. Text only.
 */
const CHAT_BODY_BYTES = 4 * 1024 * 1024

/**
 * Every other route reads a handful of fields — names, keys, scalar workflow
 * values, a LoRA strength, a settings op — and nothing near a megabyte
 * (until 2026-11-07 each of them accepted 80 MB).
 */
const SMALL_BODY_BYTES = 1024 * 1024

/**
 * Read one line with the steps sent as they happen, as server-sent events.
 *
 * One `data:` frame per event, and a last one carrying the finished answer in
 * exactly the shape the JSON route returns — the client reads the same reply
 * either way, and a browser that cannot keep the stream open loses the
 * thinking, never the answer.
 * @param ctx - plugin context, carrying the models the reading uses.
 * @param res - the open response; this function ends it.
 * @param asked - the line and the state it was written in.
 * @param inventory - the workflows this deployment loaded.
 * @param outputDir - where the staged stills live, for the vision pass.
 * @returns nothing; failures are sent as the answer, not as a status code.
 */
async function streamImagineChat(
  ctx: ImagineHost,
  res: ServerResponse,
  asked: ImagineChatRequest,
  inventory: WorkflowInventory,
  outputDir: string,
): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    // Nginx sits in front of this deployment and buffers by default, which
    // holds every step until the answer arrives — the exact thing the stream
    // exists to avoid.
    'x-accel-buffering': 'no',
  })
  const send = (frame: unknown): void => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(frame)}\n\n`)
  }
  // The stop button closes the stream: the model call ends with it instead of
  // thinking on, for nobody, until the ceiling.
  const stopped = new AbortController()
  res.on('close', () => { if (!res.writableEnded) stopped.abort() })
  try {
    const answer = await readImagineChat(ctx, asked, inventory, outputDir, (event) => { send(event) }, stopped.signal)
    send({ kind: 'done', answer })
  } catch (error: unknown) {
    // The reading itself never throws; anything here is the plumbing, and the
    // chat still has to end up with a line rather than an open socket.
    send({
      kind: 'done',
      answer: {
        reply: error instanceof Error ? error.message : message('chat.readFailed'),
        intents: [],
        read: false,
        failed: true,
      },
    })
  }
  res.end()
}

/** The last body served under each tagged slot, with its tag. */
const lastTags = new Map<string, { readonly body: string; readonly tag: string }>()

/**
 * A JSON answer that a client may revalidate instead of re-downloading.
 *
 * The gallery inventory and the shared studio are 456 KB and 1.1 MB on this
 * deployment, and the page asks for both again after every finished job: with
 * no validator, "nothing changed" cost the whole body each time. The tag is a
 * hash of what the body says, so it only changes when the answer does; a client
 * that sends it back gets a 304 with no body.
 *
 * The tag is kept beside the last body served under the same `slot`: an
 * unchanged answer (the store hands back the very same string, the gallery an
 * equal one) reuses it instead of hashing a megabyte on every GET.
 * @param slot - which answer this is (`projects`, `gallery`).
 * @param req - the request, for its `if-none-match`.
 * @param res - the response.
 * @param method - the HTTP method, for HEAD.
 * @param body - the serialized answer.
 * @returns nothing.
 */
export function writeJsonTagged(
  slot: string,
  req: IncomingMessage,
  res: ServerResponse,
  method: string | undefined,
  body: string,
): void {
  const known = lastTags.get(slot)
  const tag = known !== undefined && known.body === body
    ? known.tag
    : `"${createHash('sha1').update(body).digest('base64url').slice(0, 16)}"`
  if (known?.tag !== tag) lastTags.set(slot, { body, tag })
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, no-cache',
    etag: tag,
  }
  if (req.headers['if-none-match'] === tag) {
    res.writeHead(304, headers)
    res.end()
    return
  }
  res.writeHead(200, { ...headers, 'content-length': Buffer.byteLength(body) })
  if (method === 'HEAD') {
    res.end()
    return
  }
  res.end(body)
}

/** Largest side a generation request may ask for, per axis. */
const MAX_REQUEST_SIDE = 8192

/**
 * Longest `seconds` each action accepts. A clip is a handful of seconds of
 * frames; a MiniMax Music 3 track is minutes of `max_duration`, and one blanket
 * ceiling rejected the 120s and 180s the music composer offers. A story's
 * seconds are the whole video's, spread over as many clips as it takes.
 */
const MAX_SECONDS: Readonly<Record<string, number>> = { music: 300, story: 300 }

/** Ceiling for every action MAX_SECONDS does not name. */
const DEFAULT_MAX_SECONDS = 60

/**
 * Say why the size or length of an Imagine request is refused, or undefined
 * when they fit.
 * @param body - the parsed request body, including the action it names.
 * @returns the reason, in the user's language.
 */
function invalidRequestReason(body: {
  action?: string
  size?: string
  seconds?: number
  megapixels?: number
  swapResolution?: string
}): string | undefined {
  if (typeof body.size === 'string') {
    const size = parseSize(body.size)
    if (size === undefined) {
      return message('request.sizeInvalid', { size: body.size })
    }
    if (size.width > MAX_REQUEST_SIDE || size.height > MAX_REQUEST_SIDE) {
      return message('request.sizeTooLarge', { max: MAX_REQUEST_SIDE })
    }
  }
  const maxSeconds = MAX_SECONDS[body.action ?? ''] ?? DEFAULT_MAX_SECONDS
  if (body.seconds !== undefined && (!Number.isFinite(body.seconds) || body.seconds <= 0 || body.seconds > maxSeconds)) {
    return message('request.secondsInvalid', { max: maxSeconds })
  }
  if (body.swapResolution !== undefined && !(SWAP_RESOLUTIONS as readonly string[]).includes(body.swapResolution)) {
    return message('request.swapResolutionInvalid', { allowed: SWAP_RESOLUTIONS.join(', ') })
  }
  if (body.megapixels !== undefined && (!Number.isFinite(body.megapixels) || body.megapixels <= 0 || body.megapixels > 16)) {
    return message('request.megapixelsInvalid')
  }
  // Speed, quality, batch size and scan count: `invalidChoiceReason`.
  return undefined
}

/** The configuration layers the entry booted with, for the settings page. */
export interface ImagineSettingsSurface {
  /** Media output directory: what `config.yaml` declares, and what runs now. */
  readonly outputDir: { readonly composed: string; readonly running: string }
  /** Workflows `config.yaml` declares, before any override. */
  readonly composedWorkflows: WorkflowMap
  /** The settings file as it stood when this process booted. */
  readonly appliedRaw: string | undefined
  /** Why the boot read refused the file, when it did. */
  readonly bootProblem: string | undefined
}

/**
 * Everything the Imagine settings page renders: what `config.yaml` declares,
 * what the settings file holds now, and what this process is actually using.
 * @param ctx - plugin context carrying the ComfyUI client.
 * @param inventory - the workflows this deployment loaded.
 * @param settings - the layers this entry booted with.
 * @returns the settings view.
 */
async function describeImagineSettings(
  ctx: ImagineHost,
  inventory: WorkflowInventory,
  settings: ImagineSettingsSurface,
): Promise<unknown> {
  const current = await readImagineOverrides()
  /*
   * The page shows every workflow the configuration accepts, not only the ones
   * this deployment wired: a graph nothing points at today is still editable,
   * and an entry `config.yaml` left empty is where a new one would go.
   */
  const workflows = WORKFLOW_KEYS.map((configKey) => {
    const config = settings.composedWorkflows[configKey]
    const override = current.overrides.workflows?.[configKey]
    const overridePath = override?.['path']
    const path = typeof overridePath === 'string' ? overridePath : config?.path
    const listed = inventory.list.find(entry => workflowConfigKey(entry.key) === configKey)
    return {
      key: configKey,
      listedKey: listed?.key,
      label: listed?.label,
      configured: path !== undefined,
      path,
      file: path === undefined ? undefined : basename(path),
      composed: config ?? {},
      override: override ?? {},
    }
  })
  return {
    path: imagineSettingsPath(),
    /*
     * What this process read is what it loaded; what is on disk is what the
     * next boot will use. The two differ exactly when a saved change has not
     * reached the running graphs yet.
     */
    pendingRestart: (current.raw ?? '') !== (settings.appliedRaw ?? ''),
    ...settings.bootProblem === undefined ? {} : { appliedProblem: settings.bootProblem },
    ...current.problem === undefined ? {} : { fileProblem: current.problem },
    server: {
      composed: ctx.comfy.composedConnection,
      override: current.overrides.server ?? {},
      running: ctx.comfy.connection,
      canRestart: ctx.comfy.canRestart,
    },
    output: {
      ...settings.outputDir,
      override: current.overrides.outputDir,
    },
    workflows,
    inventory: inventory.list,
  } satisfies ImagineSettingsView
}
