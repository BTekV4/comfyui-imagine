/**
 * What a studio request may ask for, checked before a job exists: which
 * graph an action runs, which file it needs, the canvas and length an object
 * swap or a recreation takes from its clip. Nothing here queues anything.
 * @module tool-comfy/job-request
 */

import type { SwapResolution } from '../../../shared/imagine-sizing.ts'
import { join } from 'node:path'
import type { LoadedWorkflow } from './index.ts'
import { kindOf, probePixels, safeBasename } from './gallery.ts'
import { UPSCALE_IMAGE_STEPS, UPSCALE_VIDEO_STEPS, upscaleBlocked } from '../../../shared/imagine-media.ts'
import { probeMedia } from './media-tools.ts'
import { h3AreaCanvas } from './extend-video.ts'
import { formatSize, H3_NATIVE_MEGAPIXELS } from './snap-size.ts'
import { regenerateCanvas } from './regenerate.ts'
import type { ImagineWorkflows, WorkflowGraphs } from './workflow-fields.ts'
import { customKey } from './custom-workflows.ts'
import { CHAIN_SCENE_SECONDS } from './video-prompt.ts'
import { objectSwapUsesPhoto } from './object-swap-texts.ts'
import { RELIGHT_LOOKS, relightLookOf, relightPromptOf, type RelightLook } from '../../../shared/relight-looks.ts'
import { message } from '../../src/messages.ts'
import type { Singer } from './music-prompt.ts'
import { ACTION_TABLE, outputKindOf } from '../../../shared/imagine-action-table.ts'
import {
  DEFAULT_OBJECT_PLACEMENT, IMAGINE_ACTIONS, IMAGINE_OBJECT_MODES, IMAGINE_QUALITIES, IMAGINE_SPEEDS,
  type ImagineAction, type ImagineObjectMode, type ImaginePlacement, type ImagineQuality,
  type ImagineRegion, type ImagineSpeed, type MediaKind, type ModelRoute,
} from '../../../shared/imagine-types.ts'

/** Most jobs one request may queue as a batch (`count`). */
export const MAX_JOB_COUNT = 10

/**
 * Most candidates one scan may draw (`candidates`): twenty draws are already
 * minutes of GPU before the recreation even starts.
 */
export const MAX_SCAN_CANDIDATES = 20

/**
 * Longest name a grounded zone may carry: the phrase the vision pass matched
 * on the photo, not a paragraph someone pasted into the field.
 */
const MAX_EDIT_TARGET = 200

/**
 * The box a new object goes into, normalised and checked, or undefined when it
 * is not a box.
 *
 * `{ x, y, width, height }` as shares of the frame, which is what the graph's
 * placement node takes (`H3ObjectPlacementMask`). A box that leaves the frame,
 * or has no area, is refused rather than clamped: a mask built from
 * coordinates the node never expected is a render of the wrong place, and the
 * sentence that says so is cheaper than the video that has to be re-made
 * (2026-11-06).
 *
 * Exported for `test/object-swap.test.ts` only; this module is its one caller.
 * @param value - the untrusted value, e.g. a request's `placement`.
 * @returns the box, or undefined when it is not one.
 */
export function placementOf(value: unknown): ImaginePlacement | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { x, y, width, height } = value as Record<string, unknown>
  if (![x, y, width, height].every(n => typeof n === 'number' && Number.isFinite(n))) return undefined
  const box: ImaginePlacement = { x: x as number, y: y as number, width: width as number, height: height as number }
  if (box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0) return undefined
  if (box.x + box.width > 1 + 1e-6 || box.y + box.height > 1 + 1e-6) return undefined
  return box
}

/**
 * The placement as the graph's node reads it: a JSON array of keyframes.
 *
 * One keyframe holds the box still for the whole clip, which is what the panel
 * draws; the node also accepts several, for a camera that moves, and the
 * studio does not offer that yet (2026-11-06).
 * @param box - the normalised box.
 * @returns the JSON string for the placement node's input.
 */
export function placementKeyframes(box: ImaginePlacement): string {
  return JSON.stringify([{ frame: 0, x: box.x, y: box.y, width: box.width, height: box.height }])
}

/**
 * Why the choice fields of a request are refused, or undefined when they are
 * fine: the speed, the quality, the batch size and the scan's count. The
 * one place these are checked, against the shared lists and the limits above;
 * the route answers 400 with the sentence.
 * @param body - the untrusted request fields.
 * @returns a sentence for the user, or undefined.
 */
export function invalidChoiceReason(body: {
  readonly speed?: unknown
  readonly quality?: unknown
  readonly count?: unknown
  readonly candidates?: unknown
  readonly objectMode?: unknown
  readonly light?: unknown
  readonly placement?: unknown
}): string | undefined {
  if (body.speed !== undefined && !(IMAGINE_SPEEDS as readonly unknown[]).includes(body.speed)) {
    return message('job.speed', { list: IMAGINE_SPEEDS.join(', ') })
  }
  if (body.quality !== undefined && !(IMAGINE_QUALITIES as readonly unknown[]).includes(body.quality)) {
    return message('job.quality', { list: IMAGINE_QUALITIES.join(', ') })
  }
  if (body.count !== undefined
    && (typeof body.count !== 'number' || !Number.isInteger(body.count) || body.count < 1 || body.count > MAX_JOB_COUNT)) {
    return message('job.count', { max: MAX_JOB_COUNT })
  }
  if (body.candidates !== undefined
    && (typeof body.candidates !== 'number' || !Number.isInteger(body.candidates)
      || body.candidates < 1 || body.candidates > MAX_SCAN_CANDIDATES)) {
    return message('job.candidates', { max: MAX_SCAN_CANDIDATES })
  }
  if (body.objectMode !== undefined && !(IMAGINE_OBJECT_MODES as readonly unknown[]).includes(body.objectMode)) {
    return message('job.objectMode', { list: IMAGINE_OBJECT_MODES.join(', ') })
  }
  /*
   * The box of «add an object»: normalized coordinates, inside the
   * frame. It is a mask, not a preference, so an impossible box is refused
   * instead of being silently corrected.
   */
  if (body.placement !== undefined && placementOf(body.placement) === undefined) {
    return message('job.placement')
  }
  /*
   * The light of «relight the photo» is a closed choice: an invented sentence
   * would give a different photo, and the refusal names the looks that exist.
   */
  if (body.light !== undefined && relightLookOf(typeof body.light === 'string' ? body.light : '') === undefined) {
    return message('job.light', { list: RELIGHT_LOOKS.map(look => look.id).join(', ') })
  }
  return undefined
}

/** One studio request, as the route and the music-video chain hand it over. */
export interface ImagineJobRequest {
  action: ImagineAction
  prompt: string
  source?: string
  size?: string
  aspectRatio?: string
  /** The size is a ratio the user named, not the composer's resting value. */
  canvasAsked?: boolean
  /** `custom` only: which uploaded workflow to run. */
  customWorkflowId?: string
  /** `custom` only: the card's own controls, keyed `<node>.<field>`. */
  customFields?: Readonly<Record<string, unknown>>
  /**
   * `custom` only: the card's file slots, keyed by node id, as gallery
   * basenames. The runner uploads each one and writes the name the node wants.
   */
  customFiles?: Readonly<Record<string, string>>
  seconds?: number
  megapixels?: number
  /** Character and object swap only: the ladder step their plan renders at. */
  swapResolution?: SwapResolution
  /**
   * How the clip is rendered: `fast`, the distilled graph as it ships, or
   * `slow`, the high-quality half — the entry's `highInputs` (the 6-step Pika
   * inputs) or its second graph `pathHigh`, `steps.high` when it has neither.
   * The old recipe that swapped in the base weights and sampled at 24 steps is
   * gone; the route refuses any other value before a job exists.
   */
  speed?: ImagineSpeed
  /**
   * How a photo is drawn: `standard`, the graph's own step count, or `high`,
   * the workflow's `steps.high` (sixteen on the Krea 2 graphs).
   */
  quality?: ImagineQuality
  lyrics?: string
  voice?: string
  pitch?: number
  /**
   * The second photo: the object of an `objectSwap`, the reference of a
   * `compose`. The clip or the first photo travels in `source`.
   */
  reference?: string
  /**
   * `relight` only: the light look to paint, by slug (`shared/relight-looks.ts`).
   *
   * Absent means the recipe's first look. The route refuses a slug that is not
   * in the list before a job exists; the look is what writes the prompt, so a
   * wrong one is not a different light, it is a different picture.
   */
  light?: string
  /**
   * `objectSwap` only: which of the four recipes the run uses.
   *
   * Absent means `change`, the one that takes the photo. The route refuses a
   * value that is not one of {@link IMAGINE_OBJECT_MODES} before a job exists.
   */
  objectMode?: ImagineObjectMode
  /**
   * `objectSwap` only, `add` mode: the box the new object goes into, as shares
   * of the frame. Absent means the middle of the frame.
   */
  placement?: ImaginePlacement
  /** Recreate only: a frame already drawn, to reuse instead of drawing another. */
  frame?: string
  /**
   * How many candidate frames a `scanFrame` draws (1-20).
   *
   * Deliberately not `count`: that one makes a BATCH of jobs, one per
   * variant, which for a scan would be N jobs each drawing N frames. Absent,
   * the scan draws its default set (`SCAN_FRAMES`).
   */
  candidates?: number
  /** Recreate only: keep the reference clip's own soundtrack. */
  keepAudio?: boolean
  /** Character swap only: false when the people do not sing or talk along (the default is lip-sync on). */
  lipSync?: boolean
  /** Upscale only: the short side to arrive at (1080, 1440, 2160 for a still; 720, 1080 for a clip). */
  upscaleTo?: number
  /** Remix only: the zone the edit is confined to. */
  region?: ImagineRegion
  /**
   * Remix only: the thing the zone was grounded on ("the red handbag").
   *
   * The run cuts that object's own outline out of the photo with SAM 3, so
   * the rectangle's background is not regenerated. Absent on a rectangle the
   * user marked, which stays a rectangle.
   */
  target?: string
  /** Remix only: a painted zone, as a PNG data URL (white = change). */
  mask?: string
  /** Video only: the photo the clip has to arrive at (first and last frame). */
  lastSource?: string
  count?: number
  song?: string
  /** A montage's photos, one per shot; `story` only. */
  sources?: readonly string[]
  clipSeconds?: number
  /**
   * A montage whose shots do not continue each other: every clip is
   * generated from its own photo alone and the shots are joined on hard
   * cuts.
   *
   * A montage whose photos are different scenes wants this. Without it each
   * clip is asked to travel from its photo to the next one, so the costume
   * and the place change inside a single shot — measured 2026-09-23 on a
   * seventeen-costume music video: a clip opening on the bedroom with a
   * handheld console ended on a woman walking through a field.
   */
  hardCuts?: boolean
  /** The model the composer's chip is showing, when the caller sends one. */
  model?: ModelRoute
  /** The music video this job is a stage of. */
  clipId?: string
  /** Which voice the music form asked to sing. */
  singer?: Singer
}

/**
 * The zone a request named, clamped into the photo, or undefined when it is
 * not one: four finite numbers and at least 2% of each side.
 */
export function regionOf(value: unknown): ImagineRegion | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const [x, y, w, h] = [raw.x, raw.y, raw.w, raw.h].map(entry => typeof entry === 'number' && Number.isFinite(entry) ? entry : Number.NaN)
  if ([x, y, w, h].some(Number.isNaN)) return undefined
  const left = Math.min(Math.max(x as number, 0), 1)
  const top = Math.min(Math.max(y as number, 0), 1)
  const width = Math.min(w as number, 1 - left)
  const height = Math.min(h as number, 1 - top)
  return width >= 0.02 && height >= 0.02 ? { x: left, y: top, w: width, h: height } : undefined
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47]

/** The bytes of a painted mask sent as a PNG data URL, or undefined. */
function paintedMaskOf(value: unknown): Uint8Array | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(value)
  if (match === null) return undefined
  const bytes = new Uint8Array(Buffer.from(match[1] ?? '', 'base64'))
  return bytes.length > 0 && bytes.length < 16 * 1024 * 1024 && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
    ? bytes
    : undefined
}

/**
 * The graph an uploaded workflow names.
 *
 * It sits in the same map as the configured ones, under `custom:<id>`, so the
 * runner needs no second registry — and an id that names nothing is simply
 * undefined, which the plan reports as a workflow the deployment does not have.
 * @param workflows - the loaded graphs.
 * @param id - the uploaded workflow's id.
 * @returns the graph, or undefined when the id is unknown.
 */
function customGraph(workflows: WorkflowGraphs, id: string | undefined): LoadedWorkflow | undefined {
  if (id === undefined || id === '') return undefined
  return (workflows as unknown as Readonly<Record<string, LoadedWorkflow | undefined>>)[customKey(id)]
}

/**
 * What a graph-running action runs: its workflow, the tool name its output
 * file is declared under, and what kind of file it writes.
 *
 * `remix` and `upscale` pick their graph and their tool from the source (a
 * zone edit, a clip), so they are resolved beside this table, not in it.
 * The two nested ternaries this replaced spelt the same mapping twice. The
 * output kind is the action's row in the shared table (imagine-action-table.ts).
 */
export const ACTION_RUNS: Partial<Record<ImagineAction, {
  readonly workflow: keyof ImagineWorkflows
  readonly tool: string
  readonly output: 'video' | 'audio' | 'image'
}>> = {
  generate: { workflow: 'generate', tool: 'generate_image', output: outputKindOf('generate') },
  video: { workflow: 'video', tool: 'create_video', output: outputKindOf('video') },
  loop: { workflow: 'loopVideo', tool: 'animated_background', output: outputKindOf('loop') },
  extend: { workflow: 'extendVideo', tool: 'extend_video', output: outputKindOf('extend') },
  bg: { workflow: 'removeBackground', tool: 'remove_background', output: outputKindOf('bg') },
  voice: { workflow: 'changeVoice', tool: 'change_voice', output: outputKindOf('voice') },
  music: { workflow: 'generateMusic', tool: 'generate_music', output: outputKindOf('music') },
  /*
   * The scan half of «Recreate video»: the same Krea 2 graph draws the opening
   * frame (the pin `recreateFrame` points at the scan's own file), so the graph
   * is the one the recreation already uses for its first frame.
   */
  scanFrame: { workflow: 'recreateFrame', tool: 'recreate_frame', output: outputKindOf('scanFrame') },
  recreate: { workflow: 'recreateVideo', tool: 'recreate_video', output: outputKindOf('recreate') },
  /*
   * «Regenerate detail»: the Open-H3 refiner redraws the clip at 1.5×. The
   * file comes out as `regenerate_detail-…mp4`, which is the prefix the
   * gallery reads the origin from (gallery.ts).
   */
  regenerate: { workflow: 'regenerateDetail', tool: 'regenerate_detail', output: outputKindOf('regenerate') },
  /*
   * «Object swap»: the object tracked in the clip is changed, removed, or its
   * background replaced, or an object added. This entry is a SINGLE one
   * because the file, the tool and the output type are the same for every
   * mode; the graph instead is one per mode (each plans and chains its own
   * clips), resolved by `readJobRequest`. The file comes out as
   * `object_swap-…mp4`, which is the prefix the gallery reads the origin from.
   */
  objectSwap: { workflow: 'objectSwap', tool: 'object_swap', output: outputKindOf('objectSwap') },
  /*
   * «Character swap»: the main person of the clip becomes the one in the
   * photo. Openjutsu's one-click graph does the windows, the prompt and the
   * seams by itself, so the whole clip goes in one run.
   */
  swapPerson: { workflow: 'swapPerson', tool: 'swap_person', output: outputKindOf('swapPerson') },
  /*
   * «Relight the photo»: the photo relit with one of the light looks. The
   * look's text IS the prompt (written by `readJobRequest`), so the file comes
   * from an image and not from a sentence of the user's.
   */
  relight: { workflow: 'relight', tool: 'relight', output: outputKindOf('relight') },
  compose: { workflow: 'compose', tool: 'compose_refs', output: outputKindOf('compose') },
}

/** What is said when an action's file is missing or of the wrong kind. */
interface NeedMessages {
  readonly missing: () => string
  readonly wrong?: (kind: MediaKind | undefined) => string
}

/**
 * The sentences of {@link NEEDS}, by action.
 * @returns the messages for every action that reads a file.
 */
function needMessages(): Partial<Record<ImagineAction, NeedMessages>> {
  /*
   * These four animate, edit or cut out a PHOTO. Handed a clip they reached
   * the graph as a video to load and came back as 'workflow has no LoadVideo
   * node for the input video', which says nothing to the person who asked —
   * the same wording that made a failed song look like a failed video
   * (2026-09-09). Continuing a clip is `extend`, and it says so.
   */
  const photo = {
    missing: () => message('job.startImageRequired'),
    wrong: (kind: MediaKind | undefined) => kind === 'video'
      ? message('job.videoNeedsExtend')
      : message('job.startImageRequired'),
  } as const
  /*
   * An object swap reads the clip that gets modified; its photo, when the
   * mode wants one, travels beside it in `reference`.
   */
  const plate = { missing: () => message('job.plateRequired') } as const
  /*
   * «Recreate video» and its scan read ONE file: the reference clip. The opening
   * frame is drawn by the run with Krea 2 from the clip's own frames, so there
   * is no second file to ask for.
   */
  const reference = { missing: () => message('job.recreateVideoRequired') } as const
  /*
   * «Regenerate detail» reads ONE clip and nothing else: the prompt is
   * optional (without it, the run fetches the one the clip was born from —
   * regenerate.ts), and the clip decides the canvas, not the composer.
   */
  const refiner = { missing: () => message('job.regenerateVideoRequired') } as const
  /*
   * «Relight the photo» wants ONE photo. A video here is not «continue the
   * clip» (that is `extend`): it is simply the wrong file, and the message
   * says what is needed without sending the user to another action.
   */
  const picture = {
    missing: () => message('job.startImageRequired'),
    wrong: () => message('job.startImageRequired'),
  } as const
  return {
    remix: photo,
    video: photo,
    loop: photo,
    bg: photo,
    upscale: { missing: () => message('job.startFileRequired'), wrong: () => message('job.sourceInvalid') },
    /*
     * The graph separates a sung track: a picture has nothing to convert, and
     * a clip has its soundtrack — what a user calls "this clip" is a video
     * nine times out of ten, and asking them for an extracted track was a
     * refusal of the thing they asked for. A clip is accepted, and the run
     * takes its audio out before the graph sees it.
     */
    voice: { missing: () => message('job.trackRequired'), wrong: () => message('job.trackOrClipRequired') },
    recreate: reference,
    scanFrame: reference,
    regenerate: refiner,
    /*
     * «Object swap» reads ONE clip: the tracker finds the object to change
     * from a phrase written by the vision model, and the photo — when the mode
     * wants one (`change`) — travels beside it in `reference`.
     */
    objectSwap: plate,
    // The clip whose main person changes; the photo travels in `reference`.
    swapPerson: plate,
    relight: picture,
    /* Two photos: the person (source) and the reference, both already in the gallery. */
    compose: photo,
  }
}

/**
 * The file an action reads, by action: the kinds it accepts (the action's
 * `accepts` in the shared table, imagine-action-table.ts), what is said when
 * there is none, and what is said when there is one of the wrong kind (the
 * same sentence when not given).
 *
 * Five `if (X && sourceKind !== 'video') throw` and their siblings for stills
 * and tracks, until 2026-10-25.
 */
const NEEDS: Partial<Record<ImagineAction, NeedMessages & { readonly kinds: readonly MediaKind[] }>> = (() => {
  const messages = needMessages()
  return Object.fromEntries(IMAGINE_ACTIONS.flatMap(action => {
    const kinds = ACTION_TABLE[action].accepts
    if (kinds === undefined) return []
    const said = messages[action]
    // A row that accepts a file with no sentence for it is a table mistake: fail at load, not at run.
    if (said === undefined) throw new Error(`action ${action} accepts a file but has no message for it`)
    return [[action, { kinds, ...said }]]
  }))
})()

/**
 * Longest clip one recreation renders.
 *
 * Ten seconds, which is the rung the composer offers at 720p and the length
 * this graph has been measured at on the 16 GB card. A longer reference is
 * recreated for its first ten seconds and the job says so: one run rather
 * than a chain, because a recreation is one scene read once.
 */
const MAX_RECREATE_SECONDS = 10

/**
 * The length a recreation asks for: the reference clip's own, inside
 * {@link MAX_RECREATE_SECONDS}.
 * @param duration - the reference clip's length in seconds.
 * @returns the seconds to render, rounded to half a second.
 */
function recreateSecondsFor(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 5
  return Math.min(MAX_RECREATE_SECONDS, Math.max(2, Math.round(duration * 2) / 2))
}

/**
 * The upscale graph a clip is long enough to need.
 *
 * Two graphs exist because the two ComfyUI hosts solve a long clip differently
 * and the host is a deployment choice: one pass fits the whole clip on a card
 * with room to spare, a small card needs the VHS meta-batch chain that hands
 * it over block by block. A deployment that configures only one of them gets
 * that one for every clip.
 * @param workflows - the graphs this deployment loaded.
 * @param seconds - the clip's length, when it could be measured.
 * @param short - the single-pass graph, and the boundary it is good for.
 * @returns the graph to run, or undefined when neither is configured.
 */
function upscaleWorkflowFor(
  workflows: WorkflowGraphs,
  seconds: number | undefined,
  short: LoadedWorkflow | undefined,
): LoadedWorkflow | undefined {
  const long = workflows.upscaleVideoLong
  if (short === undefined || long === undefined) return short ?? long
  const limit = short.shortSeconds
  if (limit === undefined) return short
  // Unmeasurable length keeps the configured default rather than guessing at
  // a graph the deployment may not have meant for this clip.
  return seconds !== undefined && seconds > limit ? long : short
}

/**
 * The graph each object swap mode renders on, by configuration key.
 *
 * One graph per mode, because `path` is static and the three edit types have
 * different topologies. A mode whose entry is `undefined` has no graph in this
 * deployment, and {@link readJobRequest} refuses the job by name rather than
 * starting it on another mode's graph — the clip would come back with the
 * wrong thing changed and nobody would notice until they watched it.
 *
 * «Add an object» has two graphs because the photo is optional: one
 * without an image branch (the sentence describes the object) and one with
 * the photo that gives its look. The choice is not a user preference: it is
 * which of the two can render that request, so the graph is resolved from
 * the presence of the photo (2026-11-06).
 */
const OBJECT_SWAP_GRAPHS: Readonly<Record<ImagineObjectMode, keyof ImagineWorkflows | undefined>> = {
  change: 'objectSwap',
  remove: 'objectSwapRemove',
  background: 'objectSwapBackground',
  add: 'objectSwapAdd',
}

/** The graph of the «add» mode when the request carries a photo. */
const OBJECT_SWAP_ADD_PHOTO = 'objectSwapAddPhoto' as const

/**
 * The graph one object swap mode would run, or undefined when this deployment
 * has no such graph.
 * @param workflows - the loaded graphs.
 * @param mode - the recipe the request asked for; absent means `change`.
 * @returns the graph, or undefined.
 */
function objectSwapGraph(
  workflows: WorkflowGraphs,
  mode: ImagineObjectMode | undefined,
  withPhoto = false,
): LoadedWorkflow | undefined {
  const key = objectSwapKey(mode, withPhoto)
  return key === undefined ? undefined : workflows[key]
}

/**
 * The configuration key of the graph one mode would run.
 *
 * `add` is the only mode whose graph depends on the request: with a photo the
 * object's look comes from it, without one the line describes it, and the two
 * graphs differ by that branch alone (2026-11-06).
 * @param mode - the recipe the request asked for; absent means `change`.
 * @param withPhoto - whether the request brings a photo of the new object.
 * @returns the key, or undefined when the deployment has no such graph.
 */
function objectSwapKey(mode: ImagineObjectMode | undefined, withPhoto: boolean): keyof ImagineWorkflows | undefined {
  const recipe = mode ?? 'change'
  if (recipe === 'add' && withPhoto) return OBJECT_SWAP_ADD_PHOTO
  return OBJECT_SWAP_GRAPHS[recipe]
}

/**
 * The second recipe of a mode, when the deployment declares one (`pathHigh`,
 * or `highInputs` on the same graph):
 * «Quality: High» / «Speed: Slow» render the mode with that graph instead
 * of raising the step count of the one it ships, as every other clip action
 * does since 2026-11-05.
 *
 * Filed under the same key as the graph it replaces, photo included: an «add»
 * with a photo must not fall onto the high graph of the branch without one.
 * @param workflows - the loaded graphs.
 * @param mode - the recipe the request asked for.
 * @param withPhoto - whether the request brings a photo of the new object.
 * @param request - the request, for the speed and quality it carries.
 * @returns the high graph, or undefined to use the mode's own.
 */
function highObjectSwap(
  workflows: WorkflowGraphs,
  mode: ImagineObjectMode | undefined,
  withPhoto: boolean,
  request: ImagineJobRequest,
): LoadedWorkflow | undefined {
  if (request.quality !== 'high' && request.speed !== 'slow') return undefined
  const key = objectSwapKey(mode, withPhoto)
  return key === undefined ? undefined : workflows.high?.[key]
}

/**
 * The request as it will run: a «Regenerate detail» on the canvas its clip
 * decides.
 * @param outputDir - the validated media output directory.
 * @param request - the studio request.
 * @returns the request, its canvas possibly set by its clip.
 */
export async function routeRequest(
  outputDir: string,
  request: ImagineJobRequest,
): Promise<ImagineJobRequest> {
  /*
   * «Regenerate detail»: the CLIP decides the canvas, not the composer —
   * 1.5× its sides, aligned to 32, long side never above 1920
   * (regenerate.ts). The sizes that come out: 720x1280 → 1088x1920,
   * 1280x720 → 1920x1088, 960x960 → 1440x1440. The request already carries
   * `size` for the other graphs, so here it is overridden only when the clip
   * can be measured.
   */
  if (request.action === 'regenerate' && request.source !== undefined) {
    const named = safeBasename(request.source)
    const measured = named === undefined ? {} : await probePixels(join(outputDir, named), 'video')
    const canvas = 'width' in measured ? regenerateCanvas(measured.width, measured.height) : undefined
    request = { ...request, ...canvas === undefined ? {} : { size: formatSize(canvas) } }
  }
  /*
   * The speed and the quality are not routed here: the graph they pick — the
   * entry's second graph (`pathHigh`) or its `highInputs`, else the same
   * graph at its `steps.high` — is chosen by `readJobRequest`, with the
   * workflow it resolves for the job.
   */
  return request
}

/** A graph-running request, checked and resolved into what its jobs carry. */
interface JobPlan {
  readonly prompt: string
  readonly source?: string
  /** The second photo: an object swap's object, a composition's reference. */
  readonly reference?: string
  /** A recreation's opening frame handed in. */
  readonly frame?: string
  /** An object swap's recipe, resolved (absent means `change`). */
  readonly objectMode?: ImagineObjectMode
  /**
   * An «add» run's box, resolved: a request that names none gets the middle of
   * the frame, so the chat can add an object without drawing on the video.
   */
  readonly placement?: ImaginePlacement
  /** A relight's look, resolved (absent means the recipe's first). */
  readonly light?: string
  /** The canvas an object swap or a recreation renders on, else the composer's. */
  readonly size?: string
  /** A recreation's length, measured on its clip. */
  readonly recreateSeconds?: number
  readonly region?: ImagineRegion
  /** The thing the zone was grounded on, when it was found by name. */
  readonly target?: string
  readonly painted?: Uint8Array
  readonly lastSource?: string
  readonly workflow: LoadedWorkflow
}

/** A file's pixel size from its header, read at most once per path and kind. */
export type PixelsOf = (path: string, kind: MediaKind) => ReturnType<typeof probePixels>

/**
 * A {@link PixelsOf} with its own memory, for one request or one run.
 *
 * Keyed by kind and path, so a second file asked of the same cache gets its
 * own header instead of the first one's in silence. The promise is kept, so
 * two passes that ask at once share one read.
 * @returns a fresh cache.
 */
export function pixelCache(): PixelsOf {
  const headers = new Map<string, ReturnType<typeof probePixels>>()
  return (path, kind) => {
    const key = `${kind}:${path}`
    const known = headers.get(key) ?? probePixels(path, kind)
    headers.set(key, known)
    return known
  }
}

/**
 * Check one graph-running request and resolve it into what its jobs carry.
 *
 * The steps run in this order, and each throws with a sentence for the user:
 * the recipe the deployment has, the prompt, the source file, what the source
 * allows, the second file, the canvas, the edit's zone, and last the graph
 * itself. The order is the order the refusals are
 * met in, so a request wrong in two ways hears about the first.
 * @param workflows - the loaded graphs.
 * @param outputDir - the validated media output directory.
 * @param request - the request as {@link routeRequest} returned it.
 * @returns the plan; throws with a sentence for the user when it cannot run.
 */
export async function readJobRequest(
  workflows: WorkflowGraphs,
  outputDir: string,
  request: ImagineJobRequest,
): Promise<JobPlan> {
  const action = request.action
  /*
   * «Object swap»: before the files, check whether this deployment can render
   * that mode. A mode without a graph is not fixed by the right files, and the
   * job must not start with another recipe — the video would come out with
   * the wrong thing changed and nobody would notice until watching it.
   */
  const swapGraph = action === 'objectSwap'
    ? objectSwapGraph(workflows, request.objectMode, request.reference !== undefined)
    : undefined
  if (action === 'objectSwap' && swapGraph === undefined) {
    throw new Error(message('job.objectSwapNotConfigured', { mode: request.objectMode ?? 'change' }))
  }
  const { prompt, lightLook } = promptOf(request)
  const { source, sourceKind } = sourceOf(request)
  const sourcePath = source === undefined ? undefined : join(outputDir, source)
  const pixelsOf = pixelCache()
  await checkSource(request, sourceKind, sourcePath, pixelsOf)
  const files = referencesOf(request)
  const canvas = await canvasOf(request, sourcePath)
  const edit = editInputsOf(workflows, request)
  /*
   * «Character swap» without lip-sync is its own graph (Openjutsu's export
   * with the mute and face nodes); with it, the graph without them.
   */
  const noLipSyncGraph = action === 'swapPerson' && request.lipSync === false ? workflows.swapPersonNoLipSync : undefined
  if (action === 'swapPerson' && request.lipSync === false && noLipSyncGraph === undefined) {
    throw new Error(message('job.noLipSyncNotConfigured'))
  }
  const workflow = noLipSyncGraph !== undefined
    ? noLipSyncGraph
    : swapGraph === undefined
    ? await workflowOf(workflows, request, edit, sourceKind, sourcePath, pixelsOf)
    // «Object swap»: the mode decides the graph, and so does the «High»
    // recipe when the entry declares a second one like all the others.
    : highObjectSwap(workflows, request.objectMode, request.reference !== undefined, request) ?? swapGraph
  return {
    prompt,
    ...source === undefined ? {} : { source },
    ...files.reference === undefined ? {} : { reference: files.reference },
    ...files.givenFrame === undefined ? {} : { frame: files.givenFrame },
    ...files.objectMode === undefined ? {} : { objectMode: files.objectMode },
    ...files.objectPlacement === undefined ? {} : { placement: files.objectPlacement },
    ...lightLook === undefined ? {} : { light: lightLook.id },
    ...canvas.size === undefined ? {} : { size: canvas.size },
    ...canvas.recreateSeconds === undefined ? {} : { recreateSeconds: canvas.recreateSeconds },
    ...edit.region === undefined ? {} : { region: edit.region },
    ...edit.target === undefined ? {} : { target: edit.target },
    ...edit.painted === undefined ? {} : { painted: edit.painted },
    ...edit.lastSource === undefined ? {} : { lastSource: edit.lastSource },
    workflow,
  }
}

/**
 * The prompt the run starts from, and the light look of a relight.
 * @param request - the studio request.
 * @returns the prompt, and the look when the action is a relight.
 */
function promptOf(request: ImagineJobRequest): { prompt: string; lightLook: RelightLook | undefined } {
  const action = request.action
  const need = NEEDS[action]
  /*
   * «Relight the photo»: the user's line is not the prompt — the prompt is the
   * sentence of the chosen look, picked by the panel (or the chat). The
   * default is the recipe's first look, so a run without a choice is still a
   * real light and not an empty text.
   */
  const lightLook = action === 'relight' ? relightLookOf(request.light) ?? RELIGHT_LOOKS[0] : undefined
  /*
   * The name a run takes when nobody describes it (`untitled` in the shared
   * table): an upscale, a cut-out and a voice change are named by their
   * source, not by a prompt — there is nothing for the user to describe.
   */
  const prompt = lightLook === undefined
    ? request.prompt.trim() || (ACTION_TABLE[action].untitled ?? '')
    : relightPromptOf(lightLook)
  /*
   * A recreation, its scan and «Regenerate detail» are described by their clip, and what the sampler is given is written from it:
   * the line the user typed is a brief for that pass, so an empty one is a run
   * with a default scene and not a refusal. They are the actions that read a
   * clip and nothing else.
   *
   * «Object swap» reads a clip but needs the line: its three modes without a
   * photo (`remove`, `background`, `add`) have nothing else saying what to
   * remove or what to turn the take into, so the sentence decides — and that
   * is why it is excluded below.
   */
  const clipOnly = need?.kinds.length === 1 && need.kinds[0] === 'video' && action !== 'objectSwap'
  /*
   * An uploaded card may have its own controls instead of the sentence (the
   * lookbook: title and pose are picked from the catalogue), so an empty text
   * field is not a refusal: if the graph wants a line, its validation will say
   * so more precisely than we can.
   */
  const cardFields = action === 'custom'
  if (lightLook === undefined && !clipOnly && !cardFields && prompt.length === 0) {
    throw new Error(message('job.promptRequired'))
  }
  return { prompt, lightLook }
}

/**
 * The file the run reads, checked against what its action accepts.
 * @param request - the studio request.
 * @returns the gallery basename and its kind, or neither for an action that reads none.
 */
function sourceOf(request: ImagineJobRequest): { source: string | undefined; sourceKind: MediaKind | undefined } {
  const action = request.action
  const named = request.source === undefined ? undefined : safeBasename(request.source)
  if (request.source !== undefined && named === undefined) throw new Error(message('job.sourceInvalid'))
  /*
   * A song, a look and a plain generation are written, not derived from a
   * file. Whatever is staged in the composer when the line is typed is context
   * for the sentence, not an input their graph can take: the music workflow
   * has no loader at all, and the run died on 'workflow has no LoadVideo node
   * for the input video' — so a clip left attached from an earlier message
   * silently cost the user the song they had just asked for (2026-09-09).
   * Dropping it here keeps the run, and there is nothing to lose: none of the
   * three ever reads `source`.
   *
   * A generation is the same case with the picture: the written lane named the
   * staged photo in a `generate`, and the t2i graph has no image loader at all
   * — "workflow has no LoadImage node for the input image", measured
   * 2026-10-17 on "genera un'immagine" asked with an uploaded photo still in
   * the composer. Editing a picture is `remix`.
   */
  const source = action === 'music' || action === 'generate' ? undefined : named
  const sourceKind = source === undefined ? undefined : kindOf(source)
  const need = NEEDS[action]
  if (need !== undefined) {
    if (source === undefined) throw new Error(need.missing())
    if (sourceKind === undefined || !need.kinds.includes(sourceKind)) throw new Error(need.wrong?.(sourceKind) ?? need.missing())
  }
  return { source, sourceKind }
}

/**
 * What the source itself allows: a voice change needs a soundtrack, an upscale
 * a target on the ladder and a picture that is not already at the top of it.
 */
async function checkSource(
  request: ImagineJobRequest,
  sourceKind: MediaKind | undefined,
  sourcePath: string | undefined,
  pixelsOf: PixelsOf,
): Promise<void> {
  const action = request.action
  /*
   * A clip with no soundtrack is refused here rather than in the graph, where
   * it would have failed after a queue wait.
   */
  if (action === 'voice' && sourceKind === 'video' && sourcePath !== undefined && !(await probeMedia(sourcePath)).hasAudio) {
    throw new Error(message('job.noAudio'))
  }
  if (action === 'upscale' && request.upscaleTo !== undefined) {
    const steps: readonly number[] = sourceKind === 'video' ? UPSCALE_VIDEO_STEPS : UPSCALE_IMAGE_STEPS
    if (!steps.includes(request.upscaleTo)) {
      throw new Error(message('job.upscaleTarget', { value: request.upscaleTo, steps: steps.join(', ') }))
    }
  }
  if (action === 'upscale' && sourcePath !== undefined && sourceKind !== undefined) {
    const measured = await pixelsOf(sourcePath, sourceKind)
    if ('width' in measured && upscaleBlocked(sourceKind, measured.width, measured.height)) {
      throw new Error(sourceKind === 'video'
        ? message('job.already1080')
        : message('job.already4k'))
    }
  }
}

/** The files a request reads beside its source, checked and resolved. */
interface RequestFiles {
  /** The second file the run carries as `reference`, whichever action named it. */
  readonly reference?: string
  readonly objectMode?: ImagineObjectMode
  readonly objectPlacement?: ImaginePlacement
  /** A recreation's opening frame handed in. */
  readonly givenFrame?: string
}

/**
 * The second file of the actions that read two, and the recipe and box of an
 * object swap.
 * @param request - the studio request.
 * @returns the resolved files; throws when one is missing or of the wrong kind.
 */
function referencesOf(request: ImagineJobRequest): RequestFiles {
  const action = request.action
  /*
   * They stay apart rather than folding into one input — `source` remains the
   * clip for every path that already reads it, and the photo travels beside it.
   */
  /*
   * «Compose with references» reads TWO photos, and they are not
   * interchangeable: the source is the person, the reference is the costume
   * or setting to take. The reference travels beside the source and reaches
   * the graph as `image_2`.
   */
  const composeReference = action === 'compose' && request.reference !== undefined ? safeBasename(request.reference) : undefined
  if (action === 'compose' && (composeReference === undefined || kindOf(composeReference) !== 'image')) {
    throw new Error(message('job.referencePhotoRequired'))
  }
  /*
   * «Object swap»: four recipes, and the photo is needed by ONE only.
   *
   * `change` puts the photo's object into the take: without that photo the
   * run has nothing to put in, and the refusal comes here — with the message
   * saying which file is missing — instead of starting a render with the
   * graph's placeholder.
   *
   * The other modes have no image branch in their graph, so a photo is not
   * «one more reference»: it does not reach the render and the client would
   * believe it had used it. It is refused with the message naming the mode
   * (2026-11-06: the case of background, whose graph has no `ref_images`, and
   * of the «remove» mode, which never had one). When a graph gains the image
   * branch, the mode is added in `objectSwapUsesPhoto`.
   */
  const objectMode: ImagineObjectMode | undefined = action === 'objectSwap'
    ? request.objectMode ?? 'change'
    : undefined
  const objectReference = action === 'objectSwap' && request.reference !== undefined
    ? safeBasename(request.reference)
    : undefined
  if (objectMode !== undefined && !objectSwapUsesPhoto(objectMode) && request.reference !== undefined) {
    // A client that sends a photo believing it is needed: tell it so, instead
    // of silently dropping it and rendering a video that does not use that
    // file. «Add» does use it: it is the new object's look, and its graph
    // has the branch.
    throw new Error(message('job.objectPhotoNotAllowed', { mode: objectMode }))
  }
  if (action === 'objectSwap' && objectMode === 'change'
    && (objectReference === undefined || kindOf(objectReference) !== 'image')) {
    throw new Error(message('job.objectReferenceRequired'))
  }
  // A name that is not a gallery file is refused like a file of the wrong kind:
  // dropped in silence, it would leave «add» on the graph with the photo
  // branch and no photo.
  if (action === 'objectSwap' && request.reference !== undefined
    && (objectReference === undefined || kindOf(objectReference) !== 'image')) {
    throw new Error(message('job.referenceNotGallery'))
  }
  /*
   * «Add an object»: the box is the mask the graph regenerates. A
   * request that does not name one gets the one in the centre of the frame, so
   * the chat adds an object without anybody drawing on the video.
   */
  const objectPlacement: ImaginePlacement | undefined = action === 'objectSwap' && objectMode === 'add'
    ? placementOf(request.placement) ?? DEFAULT_OBJECT_PLACEMENT
    : undefined
  /*
   * A frame already in the gallery may be handed back to a recreation (a
   * retry that wants the same picture without paying the render twice).
   */
  const recreate = action === 'recreate'
  const givenFrame = recreate && request.frame !== undefined ? safeBasename(request.frame) : undefined
  if (recreate && givenFrame !== undefined && kindOf(givenFrame) !== 'image') {
    throw new Error(message('job.frameNotGallery'))
  }
  /*
   * An edit with a reference photo, as Grok's «+» beside an edit
   * (2026-11-15): the photo Krea 2 reads as its second image.
   */
  const remixReference = action === 'remix' && request.reference !== undefined ? safeBasename(request.reference) : undefined
  if (action === 'remix' && request.reference !== undefined && (remixReference === undefined || kindOf(remixReference) !== 'image')) {
    throw new Error(message('job.referenceNotGallery'))
  }
  /*
   * «Character swap» is nothing without the new character: the photo is
   * required, and it is the graph's picture of who plays the part.
   */
  const swapReference = action === 'swapPerson' && request.reference !== undefined ? safeBasename(request.reference) : undefined
  if (action === 'swapPerson' && (swapReference === undefined || kindOf(swapReference) !== 'image')) {
    throw new Error(message('job.characterPhotoRequired'))
  }
  const reference = composeReference ?? objectReference ?? remixReference ?? swapReference
  return {
    ...reference === undefined ? {} : { reference },
    ...objectMode === undefined ? {} : { objectMode },
    ...objectPlacement === undefined ? {} : { objectPlacement },
    ...givenFrame === undefined ? {} : { givenFrame },
  }
}

/**
 * The canvas a recreation renders on, measured on its clip, and its length;
 * an object swap carries no canvas, and every other action keeps the
 * composer's size.
 */
async function canvasOf(
  request: ImagineJobRequest,
  sourcePath: string | undefined,
): Promise<{ size: string | undefined; recreateSeconds: number | undefined }> {
  const action = request.action
  /*
   * «Object swap»: the graph plans its own clips and takes its size from
   * `planResolution` (the composer's step, imagine-jobs.ts), never from a
   * `size` — none of its graphs has a node the size is written into. A size
   * here would only reach the file's note as a resolution that was not
   * rendered.
   */
  let size = action === 'objectSwap' ? undefined : request.size
  /*
   * A recreation keeps the reference clip's own canvas and length: the scene
   * is the one being recreated, and the composer's aspect describes the next
   * thing the user might make, not this run. The canvas goes through H3's own
   * ceiling, so a 1080p reference is rendered at the size the model takes.
   */
  let recreateSeconds: number | undefined
  if (action === 'recreate' && sourcePath !== undefined) {
    size = undefined
    // One ffprobe for the canvas and the length.
    const measured = await probeMedia(sourcePath)
    if (measured.width !== undefined && measured.height !== undefined) {
      /*
       * The composer's resolution step, when it sent one, as a canvas area
       * (480p halves it, 720p is about the model's own 0,98 MP),
       * but never larger than the clip being recreated — a recreation of a
       * 480p clip at 720p would only spend time inventing detail the source
       * does not have. Without a step it is the clip's own size, capped by H3.
       */
      const own = (measured.width * measured.height) / (1024 * 1024)
      const area = Math.min(request.megapixels ?? H3_NATIVE_MEGAPIXELS, own)
      // Never undefined here: both sides were measured, and are positive.
      const canvas = h3AreaCanvas(measured.width, measured.height, area)
      size = canvas === undefined ? undefined : formatSize(canvas)
    }
    /*
     * A length the caller asked for (the chat can) is honoured only inside the
     * clip and the ceiling: spread after this one, it used to override the
     * cap and ask the graph for more than ten seconds.
     */
    const duration = measured.duration
    recreateSeconds = recreateSecondsFor(request.seconds === undefined ? duration : Math.min(duration > 0 ? duration : Infinity, request.seconds))
  }
  return { size, recreateSeconds }
}

/** A clip's arrival photo and an edit's zone, checked. */
interface EditInputs {
  readonly lastSource?: string
  readonly region?: ImagineRegion
  /** The thing the zone was grounded on, when it was found by name. */
  readonly target?: string
  readonly painted?: Uint8Array
}

/**
 * The arrival photo of a clip and the zone of an edit, drawn or painted.
 * @param workflows - the loaded graphs, for the zone edit's own graph.
 * @param request - the studio request.
 * @returns what the request carried; throws when one of them is unreadable.
 */
function editInputsOf(workflows: WorkflowGraphs, request: ImagineJobRequest): EditInputs {
  const action = request.action
  /*
   * A clip between two photos: the graph interpolates from the source to this
   * one. Only a plain `video` takes it; a story plans its own pairs.
   */
  const lastSource = action === 'video' && request.lastSource !== undefined
    ? safeBasename(request.lastSource)
    : undefined
  if (action === 'video' && request.lastSource !== undefined
    && (lastSource === undefined || kindOf(lastSource) !== 'image')) {
    throw new Error(message('job.lastFrameNotGallery'))
  }
  const region = action === 'remix' ? regionOf(request.region) : undefined
  if (action === 'remix' && request.region !== undefined && region === undefined) {
    throw new Error(message('job.regionInvalid'))
  }
  const painted = action === 'remix' ? paintedMaskOf(request.mask) : undefined
  if (action === 'remix' && request.mask !== undefined && painted === undefined) {
    throw new Error(message('job.maskUnreadable'))
  }
  if ((region !== undefined || painted !== undefined) && workflows.editRegion === undefined) {
    throw new Error(message('job.preciseEditNotConfigured'))
  }
  /*
   * The name only means something with a zone that grounding filled in, and
   * a painted mask is the user's own shape: neither a whole-photo edit nor a
   * painted zone is cut out by name.
   */
  const named = action === 'remix' && region !== undefined && painted === undefined
    && typeof request.target === 'string' ? request.target.trim().slice(0, MAX_EDIT_TARGET) : ''
  const target = named.length > 0 ? named : undefined
  return {
    ...lastSource === undefined ? {} : { lastSource },
    ...region === undefined ? {} : { region },
    ...target === undefined ? {} : { target },
    ...painted === undefined ? {} : { painted },
  }
}

/**
 * The graph the request runs on.
 * @returns the graph; throws, naming the action or the mode, when there is none.
 */
async function workflowOf(
  workflows: WorkflowGraphs,
  request: ImagineJobRequest,
  edit: EditInputs,
  sourceKind: MediaKind | undefined,
  sourcePath: string | undefined,
  pixelsOf: PixelsOf,
): Promise<LoadedWorkflow> {
  const action = request.action
  /*
   * An uploaded workflow is not one of the built-in actions: its graph is
   * looked up by id in the same map, and the pins come from its own meta.
   */
  const isCustom = action === 'custom'
  const runs = isCustom ? undefined : ACTION_RUNS[action]
  const workflow = action === 'remix'
    ? edit.region === undefined && edit.painted === undefined ? workflows.edit : workflows.editRegion
    : action === 'upscale'
      ? sourceKind === 'video'
        ? upscaleWorkflowFor(workflows, await clipSeconds(pixelsOf, sourcePath), workflows.upscaleVideo)
        : workflows.upscaleImage
      : isCustom ? customGraph(workflows, request.customWorkflowId)
      /*
       * «Speed: Fast» and «Quality: High» pick the GRAPH, when the entry
       * declares a second one (`pathHigh`, or `highInputs` on the same graph),
       * instead of
       * raising the steps of the same one: on distilled weights steps buy no
       * detail (measured 05/11/2026: Pika 6 and 8 steps indistinguishable, +72%
       * time; FastH3 8 -> 16 steps worse). Covers every video, which are the
       * entries with two recipes.
       */
      : runs === undefined ? undefined
      /*
       * A clip past six seconds, with no last frame to land on, is a chain of
       * scenes of at most six seconds (Openjutsu's way), when the deployment
       * has the chain graph; up to six it stays one render.
       */
      : action === 'video' && (request.seconds ?? 5) > CHAIN_SCENE_SECONDS && request.lastSource === undefined
        && workflows.videoChain !== undefined
        ? workflows.videoChain
      // The same for a continuation: past six seconds, a chain of scenes.
      : action === 'extend' && (request.seconds ?? 5) > CHAIN_SCENE_SECONDS && workflows.extendChain !== undefined
        ? workflows.extendChain
      : action === 'loop' && (request.seconds ?? 5) > CHAIN_SCENE_SECONDS && workflows.loopChain !== undefined
        ? workflows.loopChain
      : (request.quality === 'high' || request.speed === 'slow')
        && workflows.high?.[runs.workflow] !== undefined
        ? workflows.high[runs.workflow]
        : workflows[runs.workflow]
        // A recreation is image-to-video: without a graph of its own it renders
        // on the clip workflow the deployment already has.
        ?? (action === 'recreate' ? workflows.video : undefined)
  // An object swap never comes here: its mode was checked, and its graph
  // chosen, at the top of `readJobRequest`.
  if (workflow === undefined) throw new Error(message('job.actionNotConfigured', { action }))
  return workflow
}

/** A clip's length from its header, when the header carries one. */
async function clipSeconds(
  pixelsOf: PixelsOf,
  path: string | undefined,
): Promise<number | undefined> {
  if (path === undefined) return undefined
  const measured = await pixelsOf(path, 'video')
  return 'duration' in measured ? measured.duration : undefined
}
