/**
 * The routes under `/comfy-imagine`: the job queue, the projects, the
 * workflows and their edits, the settings page, the ComfyUI server, the
 * music-video form, sight, titles, the chat and the home page's templates —
 * one table from the path after the prefix to the handler that answers it.
 * @module tool-comfy/imagine-routes
 */

import { basename } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ImagineHost } from '../../src/host.ts'
import { currentLanguage, message, translateMessage, type MessageKey } from '../../src/messages.ts'
import { allowOnly, languageOf, notAllowed, readObject, restOf, sendJson, writeJsonTagged } from '../../src/route-kit.ts'
import { expandTemplate, TEMPLATES, templateById, templateProblems } from '../../../shared/imagine-templates.ts'
import { kindOf, safeBasename } from './gallery.ts'
import { isPlainObject } from './guards.ts'
import { readImagineChat, type ImagineChatRequest, type WorkflowInventory } from './imagine-chat.ts'
import { cancelImagineJob, getImagineJob, listImagineJobs, pruneOldJobs, type ImagineJob } from './imagine-jobs.ts'
import { approveSetup } from './job-queue.ts'
import { projectIdOf, routeOf, startFromBody, type JobBody, type JobStartContext } from './job-start.ts'
import { isTemplatePhotoName, runTemplate } from './template-jobs.ts'
import { fieldLabels } from './template-labels.ts'
import {
  applyOverrideOps, imagineSettingsPath, readImagineOverrides, saveImagineOverrides, workflowConfigKey, type WorkflowMap,
} from './imagine-settings.ts'
import { lookSoon } from './imagine-sight.ts'
import { loadImagineStoreJson, saveImagineStore } from './imagine-store.ts'
import { startMusicClip } from './music-clip.ts'
import type { LoraInGraph } from './lora.ts'
import { loraRoute } from './custom-workflow-routes.ts'
import { readProjectTitle } from './project-title.ts'
import type { WorkflowChange } from './workflow-edit.ts'
import type { ImagineSettingsView, WorkflowDetail } from '../../../shared/imagine-settings-view.ts'
import { WORKFLOW_KEYS } from './workflow-fields.ts'
import type { ImagineJobView, ImagineSettingOp } from '../../../shared/imagine-types.ts'

/**
 * Everything the studio's routes are handed at boot: what a job needs to start
 * ({@link JobStartContext}) and what the other routes read.
 */
export interface ImagineRoutes extends JobStartContext {
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
  /**
   * Throws away this app's copy of a graph, so the one that ships with the
   * program is used again (and its updates with it).
   */
  readonly restoreWorkflow: (key: string) => Promise<{ restored: boolean }>
  /** The configuration layers this entry booted with. */
  readonly settings: ImagineSettingsSurface
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

/**
 * The catalog of the home page's ready-made models, for the callers that only
 * speak HTTP.
 *
 * The page imports the same list from `shared/imagine-templates.ts`, so this is
 * for the MCP server and the tests. The runs are left out: they are the
 * server's side of the contract, and a client writing bodies out of them would
 * be re-implementing `expandTemplate`.
 */
const templatesRoute: Route = async (req, res) => {
  if (!allowOnly(req, res, 'GET', 'HEAD')) return
  sendJson(res, 200, { templates: TEMPLATES.map(({ runs: _runs, ...rest }) => rest) })
}

/**
 * One template, run: the form's answers in, the queued jobs and the composed
 * files out.
 *
 * The checks are the form's own, in the same order, because they are the
 * shared engine's (`templateProblems`): a body the page would have refused is
 * refused here with the same sentence. What runs is the job route's own path
 * ({@link startFromBody}), so the argument checks, the project adoption and
 * the live tiles are the ones every other run has.
 *
 * Answers 202: a template queues work; its chains finish minutes later, in the
 * background, and are read off the job queue like any other run. Every planned
 * body is checked before the first is queued (`runTemplate`), so a refusal is
 * a 400 with nothing started; a run that stops half way anyway answers 202
 * with what did start and the sentence of what stopped it (`error`), so the
 * caller files those runs instead of retrying them all.
 */
const templateRoute: Route = async (req, res, routes) => {
  if (!allowOnly(req, res, 'POST')) return
  const body = await readObject<{
    /** Which of {@link TEMPLATES} the answers are for. */
    templateId?: unknown
    /** The choice, aspect and text fields, by field id. */
    values?: unknown
    /** The photo fields, each a list of gallery names, by field id. */
    files?: unknown
    /** The board project the runs belong to. */
    projectId?: unknown
  }>(req, MAX_BODY_BYTES)
  const template = typeof body.templateId === 'string' ? templateById(body.templateId) : undefined
  if (template === undefined) {
    sendJson(res, 400, { error: message('template.notFound', { id: typeof body.templateId === 'string' ? body.templateId : '' }) })
    return
  }
  /*
   * A body is not trusted: `values` and `files` are maps of field id to
   * answer, and a list where a map belongs would be read as field names.
   */
  if ((body.values !== undefined && !isPlainObject(body.values))
    || (body.files !== undefined && !isPlainObject(body.files))) {
    sendJson(res, 400, { error: message('json.objectRequired') })
    return
  }
  const values = valuesOf(body.values)
  const files = filesOfBody(body.files)
  const stranger = galleryStranger(files)
  if (stranger !== undefined) {
    sendJson(res, 400, { error: message('template.fileNotGallery', { name: stranger }) })
    return
  }
  // The field names in the sentence's own language: an Italian refusal with
  // the English name of the field read as two languages in one line.
  const problems = templateProblems(template, { values, files }, await fieldLabels())
  if (problems.length > 0) {
    sendJson(res, 400, {
      error: problems.map(problem => message(problem.key as MessageKey, problem.args)).join('; '),
    })
    return
  }
  if (expandTemplate(template, { values, files }).length === 0) {
    sendJson(res, 400, { error: message('template.nothingToRun') })
    return
  }
  try {
    // The chains go on in the background: the answer carries the runs queued
    // now, and the board shows the steps of a `then` as they are queued.
    const { jobs, files: composed, error } = await runTemplate(routes, template, {
      values, files, projectId: projectIdOf(body.projectId),
    })
    sendJson(res, 202, { jobs, files: composed, ...error === undefined ? {} : { error } })
  } catch (error: unknown) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * The `values` of a template body, as the shared engine reads them: a string
 * or a list of strings per field, anything else dropped — the engine checks
 * what is offered, and a number is not one of the answers a form gives.
 * @param source - the `values` field as it arrived.
 * @returns the answers, by field id.
 */
function valuesOf(source: unknown): Readonly<Record<string, string | readonly string[]>> {
  if (!isPlainObject(source)) return {}
  const kept: Record<string, string | readonly string[]> = {}
  for (const [field, value] of Object.entries(source)) {
    if (typeof value === 'string') kept[field] = value
    else if (Array.isArray(value)) kept[field] = value.filter((entry): entry is string => typeof entry === 'string')
  }
  return kept
}

/**
 * The `files` of a template body, as the shared engine reads them: one list of
 * gallery names per photo field. A single name is taken as a list of one, and
 * anything that is not a name is dropped — `templateProblems` counts what is
 * left, and refuses a form that lost its photos.
 * @param source - the `files` field as it arrived.
 * @returns the names, by field id.
 */
function filesOfBody(source: unknown): Readonly<Record<string, readonly string[]>> {
  if (!isPlainObject(source)) return {}
  const kept: Record<string, readonly string[]> = {}
  for (const [field, value] of Object.entries(source)) {
    if (typeof value === 'string') kept[field] = [value]
    else if (Array.isArray(value)) kept[field] = value.filter((entry): entry is string => typeof entry === 'string')
  }
  return kept
}

/**
 * The first name a template body offers as a photo that is not a gallery photo.
 *
 * A run reads its pictures out of the media folder: a name with a path in it,
 * a dot-file (an intermediate, a composition still being written), or a file
 * that is not a picture (a clip, a song) is not a photo and has to be refused
 * before a job is queued on it.
 * @param files - the photo fields of the body.
 * @returns the offending name, or undefined when every name is a gallery file.
 */
function galleryStranger(files: Readonly<Record<string, readonly string[]>>): string | undefined {
  for (const names of Object.values(files)) {
    for (const name of names) {
      if (!isTemplatePhotoName(name)) return name
    }
  }
  return undefined
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
  templates: templatesRoute,
  template: templateRoute,
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
  { ctx, inventory, addLora, removeLora, lorasOf, tuneLora, restoreWorkflow }: ImagineRoutes,
  target: string,
): Promise<void> {
  if (target === 'plan') {
    if (!allowOnly(req, res, 'POST')) return
    const asked = await readObject<{ key?: string; changes?: WorkflowChange[] }>(req, SMALL_BODY_BYTES)
    if (typeof asked.key !== 'string' || !Array.isArray(asked.changes)) {
      sendJson(res, 400, { error: message('workflow.keyAndChanges') })
      return
    }
    // The facts go with the preview: a page that shows a value the apply
    // would refuse is a confirmation that fails one click later.
    const planned = inventory.plan(asked.key, asked.changes, await inventory.facts(asked.key))
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
    /*
     * «Restore default»: the graph this app changed goes back to the one that
     * ships with the program. Its own path and a POST, because it writes:
     * the copy is deleted and every loaded workflow read from that file is
     * replaced with the program's graph, without a restart.
     */
    if (sub === 'restore') {
      if (!allowOnly(req, res, 'POST')) return
      const done = await restoreWorkflow(key)
      sendJson(res, 200, { ok: true, restored: done.restored, overridden: inventory.overridden(key) })
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
    overridden: inventory.overridden(key),
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
  routes: ImagineRoutes,
  jobId: string,
): Promise<void> {
  // The queue, its progress and the cancels read the ComfyUI client; the POST
  // is `startFromBody`, which reads the rest off the same object.
  const { ctx } = routes
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
  const body = await readObject<JobBody>(req, MAX_BODY_BYTES)
  try {
    sendJson(res, 202, await startFromBody(routes, body))
  } catch (error: unknown) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
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
 * How often an open chat stream says something while the model has not yet.
 *
 * The reading has no deadline of its own (see `server/src/llm.ts`), and a
 * thinking model may spend minutes before its first token, during which
 * nothing at all flows down the socket. The proxy in front of the studio
 * closes a quiet connection (nginx's `proxy_read_timeout` is 60 s by default)
 * and the page then reports a reading that failed while the model is still
 * working. An SSE comment is ignored by the client and counts as traffic.
 */
const CHAT_KEEPALIVE_MS = 15_000

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
  const beat = setInterval(() => { if (!res.writableEnded) res.write(': keep-alive\n\n') }, CHAT_KEEPALIVE_MS)
  beat.unref()
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
  } finally {
    clearInterval(beat)
  }
  res.end()
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
      // One pass over the inventory, so the page can mark every changed graph
      // without asking for one workflow's detail per row.
      overridden: listed === undefined ? false : inventory.overridden(listed.key),
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
