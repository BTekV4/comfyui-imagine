/**
 * One Imagine job started from a request body: the checks, the queue and the
 * adoption into the board project, in one place.
 *
 * The POST under `/comfy-imagine` (`imagine-routes.ts`) hands its body here,
 * and so does the runner of the home page's templates (`template-jobs.ts`).
 * Its own module so that neither of the two imports the other: the runner
 * used to reach into the routes for this, and the routes into the runner for
 * the template route, which made a cycle of the two files.
 * @module tool-comfy/job-start
 */

import { SWAP_RESOLUTIONS, type SwapResolution } from '../../../shared/imagine-sizing.ts'
import type { ImagineHost } from '../../src/host.ts'
import { message } from '../../src/messages.ts'
import type {
  ImagineObjectMode, ImaginePlacement, ImagineQuality, ImagineRegion, ImagineSpeed, ModelRoute,
} from '../../../shared/imagine-types.ts'
import { kindOf, safeBasename } from './gallery.ts'
import { isPlainObject } from './guards.ts'
import { isImagineAction } from './imagine-actions.ts'
import { listImagineJobs, startImagineJob, type ImagineJob, type SpeakTarget } from './imagine-jobs.ts'
import { adoptJobsInto } from './imagine-store.ts'
import { invalidChoiceReason } from './job-request.ts'
import { parseSize } from './snap-size.ts'
import type { ImagineWorkflows } from './workflow-fields.ts'

/**
 * What starting a job needs from the boot: the plugin context, the graphs,
 * the media folder and where a `speak` job reads aloud. The routes are handed
 * more (`ImagineRoutes` extends this); a job reads only these.
 */
export interface JobStartContext {
  /** Plugin context. */
  readonly ctx: ImagineHost
  /** The loaded graphs. */
  readonly workflows: ImagineWorkflows
  /** The validated media output directory. */
  readonly outputDir: string
  /** Where a `speak` job reads its text out loud, when configured. */
  readonly speak: SpeakTarget | undefined
}

/**
 * The fields a job request may carry, as an untrusted body arrives.
 *
 * Everything is optional and unchecked: the POST under `/comfy-imagine`
 * reads this, and {@link startFromBody} checks it before a job exists. The
 * template runner builds one too, so a run started from a model of the home
 * page goes through the same checks as one started by hand.
 */
export interface JobBody {
  action?: string
  prompt?: string
  source?: string
  size?: string
  aspectRatio?: string
  /** The run's canvas came from a ratio the user named (the written lane). */
  canvasAsked?: boolean
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
  /** Remix only: the thing the zone was grounded on, when the reading found it. */
  target?: string
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
}

/**
 * Why a job body would be refused, without starting anything.
 *
 * The checks {@link startFromBody} makes before a job exists, on their own:
 * the template runner reads every body it is about to queue through this
 * first, so a form whose third run would be refused queues none of them.
 * @param body - the parsed request, its fields unchecked.
 * @returns the sentence saying why, or undefined when the body would be queued.
 */
export function jobBodyProblem(body: JobBody): string | undefined {
  if (!isImagineAction(body.action)) return message('job.actionInvalid')
  return invalidRequestReason(body) ?? invalidChoiceReason(body)
}

/**
 * Start one Imagine job from a request body, the way the job route does.
 *
 * The POST under `/comfy-imagine` hands its body here, and so does the runner
 * of the home page's templates (`runTemplate` in `template-jobs.ts`): the
 * checks, the queue, and the adoption of the job and of the files it starts
 * from into the board project are one path, so a run started from a template
 * shows its live tile and can be cancelled exactly like one started by hand.
 * @param routes - what the routes were handed at boot.
 * @param body - the parsed request, its fields unchecked.
 * @returns the job that was queued (the first of a batch, or of a story's chain).
 * @throws {Error} the sentence saying why the request was refused, or what
 *   starting it threw; the POST turns it into its 400 answer.
 */
export async function startFromBody(routes: JobStartContext, body: JobBody): Promise<ImagineJob> {
  const { ctx, workflows, outputDir, speak } = routes
  const action = body.action
  // Reject bad parameters here rather than letting the job be created and
  // die later: a caller that sends the label it sees on the button ("720p")
  // should read why at the POST, not poll a queued job into an error.
  const invalid = jobBodyProblem(body)
  if (invalid !== undefined) throw new Error(invalid)
  if (!isImagineAction(action)) throw new Error(message('job.actionInvalid'))
  // The model the composer's chip is showing. Imagine writes text before it
  // runs a graph — a song's caption and structure tags, a story's beats, a
  // look's rewrite — and those passes take this route first, so the chip
  // names the model that actually writes rather than one the deployment
  // pinned behind it.
  const chosen = routeOf(body.model)
  // The card's file slots, read once: the job takes them and the project adopts them.
  const customFiles = isPlainObject(body.customFiles)
    ? Object.fromEntries(Object.entries(body.customFiles)
      .filter((entry): entry is [string, string] => /^\d+$/.test(entry[0]) && typeof entry[1] === 'string' && entry[1].length > 0))
    : undefined
  const job = await startImagineJob(ctx, workflows, outputDir, {
    action,
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
    ...body.canvasAsked === true ? { canvasAsked: true } : {},
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
  return job
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
  light: 'string', target: 'string',
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
export function routeOf(value: unknown): ModelRoute | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { provider, model } = value as { provider?: unknown; model?: unknown }
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return { provider, model }
}

/**
 * The board project a request names, or nothing: a non-empty name that is
 * not a path.
 * @param value - the `projectId` field as it arrived.
 * @returns the project id, or undefined.
 */
export function projectIdOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && !value.includes('/') ? value : undefined
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
