/**
 * Imagine's ComfyUI plugin: loads the configured API workflows, runs them
 * through `ctx.comfy` (prompt text, seed, input image/video, size and the
 * workflow-specific extras), saves every produced file under the output
 * directory, and registers the studio's routes.
 *
 * This file keeps the configuration (types and boot check), the run helpers
 * the job modules import (`runWorkflow`, `writeWorkflowPrompt`, …) and
 * `apply`. The rest lives beside it: `workflow-load.ts` reads the graphs,
 * `workflow-inventory.ts` is what the studio may read and change of them,
 * `custom-workflow-routes.ts` serves the personal workflows and
 * `media-routes.ts` the gallery (`/comfy-media`, `/comfy-zip`); the studio's
 * own API (`/comfy-imagine`) is `imagine-routes.ts`.
 *
 * The DSH agent tools (`generate_image`, `edit_image`, …) were removed on
 * 2026-10-20: this app registers no tool registry, so they were built at
 * every boot and thrown away. Product copy is Italian.
 * @module tool-comfy
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { ImagineHost } from '../../src/host.ts'
import { message } from '../../src/messages.ts'
import { ComfyError, newMetaBatchId, type ComfyGraph } from '../comfyui/index.ts'
import { imageInputNode, promptNode, seedNode, sizeNode, videoInputNode } from '../comfyui/graph.ts'
import { dataPath } from '../home-paths/index.ts'
import { programDirFrom } from '../../src/boot-env.ts'
import { list, number, object, oneOf, string, type Check } from '../../src/config-schema.ts'
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, kindOf, pixelsOfVideoBytes } from './gallery.ts'
import { resumeUnfinishedStories } from './imagine-jobs.ts'
import type { ImagineQuality, ImagineSpeed, MediaKind } from '../../../shared/imagine-types.ts'
import { h3Frame } from '../../../shared/imagine-sizing.ts'
import { GUIDE_FRAMES } from './extend-video.ts'
import { FPS } from './media-tools.ts'
import { loadImagineOverrides, mergeWorkflowMaps, type WorkflowMap } from './imagine-settings.ts'
import { loadPersona, setPersona } from './persona.ts'
import { customGraphFile, customKey, listCustomWorkflowsSync, loadCustomWorkflow, loadCustomWorkflowsSync } from './custom-workflows.ts'
import type { CustomWorkflowMeta } from '../../../shared/custom-workflows.ts'
import { imagineHandler, type ImagineSettingsSurface } from './imagine-routes.ts'
import { parseSize } from './snap-size.ts'
import { applyHighInputs, type HighInput } from './high-inputs.ts'
import { ensureComfyReady, type SetupHooks } from './comfy-setup.ts'
import {
  BASE_FIELDS, OPTION_PINS, WORKFLOW_ROWS, type FieldSpec, type WorkflowEntries, type WorkflowGraphs,
} from './workflow-fields.ts'
import { loadWorkflows, type GraphHolder } from './workflow-load.ts'
import { dropRefBranch } from './ref-branch.ts'
import { graphEditor, workflowInventory } from './workflow-inventory.ts'
import { createWorkflowOverlay } from './workflow-overlay.ts'
import { customCoverHandler, customWorkflowsHandler } from './custom-workflow-routes.ts'
import { mediaHandler, zipHandler } from './media-routes.ts'

/** One extra workflow input a run writes into. */
export interface ComfyExtraInput {
  /** Which node carries the input. */
  nodeId: string
  /** The node's input key. */
  field: string
}

/**
 * The two H3 Motion Context nodes that chain shots through a saved latent.
 *
 * `loadNodeId` is `MiniMaxH3MotionContextLoadLatent` (its `latent_path` and
 * `clip_index` are written), `saveNodeId` is `MiniMaxH3MotionContextSaveLatent`
 * (`filename_prefix` and `clip_index`). A run that chains nothing leaves the
 * loader at index 0, which reads no file and pins nothing, and drops the
 * saver so the output folder is not filled with latents nobody continues.
 */
interface ComfyChainNodes {
  /** Id of the node that loads the saved latent, pinned to the previous run. */
  loadNodeId: string
  /** Id of the node that writes the latent the next run continues from. */
  saveNodeId: string
}

/**
 * Pin for a realism LoRA the vision pass switches on per clip.
 *
 * The node stays in the graph and its strength carries the decision: the
 * configured value for a still judged photographic, zero otherwise, which
 * leaves the model untouched. The strength and the trigger word belong to the
 * LoRA the deployment installed, so both are configured beside its pin rather
 * than written here.
 */
interface ComfyRealismInput extends ComfyExtraInput {
  /** LoRA strength for a realistic clip; a clip judged otherwise gets zero. */
  strength: number
  /** The LoRA's trigger word, placed in the prompt's style slot. */
  token: string
}

/** One workflow's file and optional node/field pins. */
export interface WorkflowConfig {
  /** Absolute path of the API-format workflow JSON, or `custom:<id>` for a card. */
  path: string
  /**
   * When to use this workflow, in one short line.
   *
   * The label says what the graph is; this says what it is for. The settings
   * page shows it, and the written lane is given it: a reading choosing a
   * graph from a list of titles picks by name, which is not the same thing.
   */
  description?: string
  /**
   * The graph of the «Quality: High» recipe, with the same pins as `path`.
   * When present, Veloce and Qualita pick the graph instead of raising the steps.
   * A graph that carries both recipes declares `highInputs` instead.
   */
  pathHigh?: string
  /**
   * Pin the prompt node; the field defaults to the first of `value`, `text`,
   * `prompt`, `caption` the node carries. Auto-discovery (`CLIPTextEncode`) is
   * the fallback — some generators (conditional-LoRA switches) must NOT be fed
   * through the CLIP encode, which is what this pin exists for.
   */
  promptNodeId?: string
  /** Pin the prompt input key; absent = `value`/`text`/`prompt`/`caption` (first present). */
  promptField?: string
  /** Pin the seed node; absent = auto-discovery (`KSampler`). */
  seedNodeId?: string
  /** Pin the seed input key; absent = `seed` (MiniMax noise nodes use `noise_seed`). */
  seedField?: string
  /** Pin the input-image node; absent = auto-discovery (`LoadImage`). */
  imageNodeId?: string
  /** Pin the input-image key; absent = `image`. */
  imageField?: string
  /**
   * Pin the node holding the frame the shot must arrive at (or, for the zone
   * edit, the mask).
   *
   * `MiniMaxH3ImageToVideo` takes a `last_frame` as well as a `first_frame`,
   * and a montage that gives shot n the photo of shot n+1 as its far end ends
   * exactly where the next shot begins: the join is seamless because the
   * frames match, not because a dissolve hides the cut. Absent, or with no
   * far photo to give it, the graph's `last_frame` link is removed and the
   * shot is an ordinary take from one still.
   */
  lastImageNodeId?: string
  /** Pin the sampler that reads `last_frame`, so the link can be removed. */
  lastFrameNodeId?: string
  /**
   * An edit's reference photo, as Grok's «+» beside an edit (2026-11-15): the
   * loader of Krea 2's second image (`image_b`, `source_latent_b`). Without a
   * reference this node and `refEncodeNodeId` are taken out of the graph, with
   * every link to them, and the edit runs as it always did.
   */
  refImageNodeId?: string
  /** The encoder of the reference photo, taken out with its loader. */
  refEncodeNodeId?: string
  /** Pin the input-video node; absent = auto-discovery (`LoadVideo`). */
  videoNodeId?: string
  /** Pin the input-video key; absent = `file`. */
  videoField?: string
  /** Pin the input-audio node (`LoadAudio`); a workflow given a track needs it. */
  audioNodeId?: string
  /** Pin the input-audio key; absent = `audio`. */
  audioField?: string
  /** Pin the size node; absent = auto-discovery (`EmptyLatentImage`). */
  sizeNodeId?: string
  /**
   * The node that receives the same size asked of `sizeNodeId`, with the keys
   * of its dynamic combo.
   *
   * Needed by the Open-H3 refiner: `MinimaxH3LatentUpscaler3D` has no `width`
   * and `height`, but a `mode` (`COMFY_DYNAMICCOMBO_V3`) whose sub-inputs in
   * API format are called `mode.width`/`mode.height`. The size is the same as
   * the sampler's canvas, and is written here because the job already knows it.
   */
  upscaleNodeId?: string
  /**
   * Extension of the first produced file. The output name is declared before
   * the run (see {@link declaredOutputPath}), so it has to be known up front;
   * the job runner defaults it per action (`png` for stills, `mp4` for clips).
   */
  outputExt?: string
}

/**
 * Every extra a workflow entry may carry beyond {@link WorkflowConfig}.
 *
 * Which entry accepts which is the table in `workflow-fields.ts`, which the
 * boot schema, the loader and the settings page all read; this interface only
 * types and documents the fields.
 */
export interface WorkflowExtras {
  /**
   * Where the sampler steps sit, and the count the high recipe asks for.
   *
   * `quality: 'high'` (a photo) or `speed: 'slow'` (a clip) writes `high` into
   * that node's `field`; «Standard» and «Fast» leave the graph at the count
   * it was saved with, so a deployment can tune the base recipe in the file
   * itself. A workflow without this pin ignores both settings.
   */
  steps?: { readonly nodeId: string; readonly field: string; readonly high: number }
  /**
   * The high recipe as input overrides on the same graph (2026-11-15), for a
   * graph that carries both recipes: `quality: 'high'` or `speed: 'slow'`
   * writes each `value` into `nodeId.field`, and a value that is a link
   * (`["pika:sigmas", 0]`) rewires the input. Whatever the overrides leave
   * unread is dropped from the run, and on the base recipe the nodes only the
   * overrides link to are dropped too ({@link applyHighInputs}). Ignored on
   * the `pathHigh` graph, which already is the high recipe.
   */
  highInputs?: readonly HighInput[]
  /**
   * Aspect label → the graph's format input. For an H3 clip it is the canvas
   * label; the lookbook takes it on its `ResolutionSelector`.
   */
  aspectRatio?: ComfyExtraInput
  /** Length in seconds → the graph's length input: one clip or the whole animated background. */
  seconds?: ComfyExtraInput
  /** Realism LoRA strength, switched by the vision pass's verdict. */
  realism?: ComfyRealismInput
  /** Phrase the tracker is given for the object in the clip (object swap). */
  subjectText?: ComfyExtraInput
  /**
   * What the tracked object becomes in an object swap (the Openjutsu plan's
   * `change_to`): the replacement, what shows instead, the new setting, or
   * the object to add, as a short phrase.
   */
  referenceText?: ComfyExtraInput
  /** The placement keyframes of «add an object», as JSON. */
  placementText?: ComfyExtraInput
  /** A character swap's «no lip-sync» switch: true when the people do not sing or talk along. */
  noLipSync?: ComfyExtraInput
  /** The resolution label of a graph that plans its own clips (Openjutsu's Swap Plan: 480p, 736p…). */
  planResolution?: ComfyExtraInput
  /** A chained clip's production plan (the Context Loop's `plan_json`). */
  planJson?: ComfyExtraInput
  /** A chained clip's run name: its checkpoints are saved, and resumed, under it. */
  runName?: ComfyExtraInput
  /** The uploaded track's name → the guide's `LoadAudio` input. */
  songAudio?: ComfyExtraInput
  /** Where this clip starts in the track, in seconds. */
  songStart?: ComfyExtraInput
  /** How much of the track this clip is given, in seconds. */
  songDuration?: ComfyExtraInput
  /**
   * The `frame_idx` of a `MiniMaxH3AddGuide` node that anchors the same
   * slice on the clip's timeline.
   *
   * A `ref_audio` on its own is a reference: the model imitates the
   * recording, and the mouth drifts up to a second either side of the
   * voice inside a shot (measured 2026-09-10 on the 2c6807 videoclip,
   * mouth-aperture against the vocal envelope: 0.20 in step, best fit
   * 1.12 s late). Anchored as a guide too, the audio latent sits at its
   * frames and the lips follow it: 0.47 in step, best fit 0.08 s, mouth
   * shut through a pause and open on the attack — same seed, same shot.
   * A chained shot's guide starts at frame {@link GUIDE_FRAMES}, past the
   * pinned head the Motion Context node would otherwise drop it with.
   */
  songFrame?: ComfyExtraInput
  /** Where the audio written into the LATENT starts: the shot's second minus the preroll. */
  songPrerollStart?: ComfyExtraInput
  /** How much audio that latent is given, preroll included. */
  songPrerollDuration?: ComfyExtraInput
  /**
   * The lipsync probe run over every sung shot once it is rendered.
   *
   * `probe` is an executable that takes the clip, the voice it sang and
   * the second of the voice the clip starts at, and prints a JSON line
   * with `corr0`. A shot scoring under `min` (default LIPSYNC_MIN in
   * story.ts) is rendered again with a new seed, up to `retries` times
   * (default 1), and the last render is the one delivered: a chained shot's
   * latent slot is written by whichever render was last, so the shot after
   * it continues from the clip that is actually there.
   */
  lipsync?: ComfyLipsyncCheck
  /**
   * The H3 Motion Context pair that carries one shot into the next.
   *
   * With these two nodes in the graph a montage's shots are not cut
   * together, they continue each other: shot n is sampled with the last 22
   * frames of shot n-1 pinned at its head, sliced from the latent shot n-1
   * saved, and delivered without them. The join is inside the model, so
   * there is nothing for a dissolve to hide. Measured 2026-09-08: the
   * interframe difference at the join was 12.7 against a clip mean of 8.9,
   * the same as any other frame.
   */
  chain?: ComfyChainNodes
  /**
   * Longest shot a chained montage asks for, in seconds.
   *
   * The chain context rides on top of the shot's own frames: measured on
   * the 16 GB card, a ten-second chained shot peaks at 15.6-15.8 GB and
   * fails whenever anything else is resident, a nine-second one at 14.9 GB.
   * Merging the turbo LoRA instead saves 3.5 GB but costs a third of the
   * sharpness. Default 9; set 10 to take the risk for the extra second.
   */
  chainShotSeconds?: number
  /**
   * Longest clip the single-pass video upscale is used for, in seconds;
   * longer clips take `upscaleVideoLong`. Two graphs and not one because a
   * card with room for the whole clip does better in one pass (no seam),
   * while a small card needs the VHS meta-batch chain.
   */
  shortSeconds?: number
  /** The `VHS_BatchManager` node a meta-batch graph needs an id written into. */
  metaBatchNodeId?: string
  /** Lyrics → MiniMax Music `lyrics` input. */
  lyrics?: ComfyExtraInput
  /** Seconds → MiniMax Music `max_duration` input. */
  duration?: ComfyExtraInput
  /** The RVC model to sing with → `LoadRVCModelNode.model`. */
  voice?: ComfyExtraInput
  /** Semitones to shift → `RVCEngineNode.pitch`: -12 for a woman to a man. */
  pitch?: ComfyExtraInput
  /** The voices this deployment installed, as the node spells them. */
  voices?: readonly string[]
}

/** Plugin config: the workflows, the speech service and the media output directory. */
export interface Config {
  /**
   * One entry per workflow (the rows of `workflow-fields.ts`, where each is
   * described); an absent entry leaves its action unconfigured.
   */
  workflows?: WorkflowEntries
  /**
   * Where a `speak` job reads its text out loud. Absent when the deployment
   * has no speech service, in which case the action reports that it is not
   * configured instead of queueing work that cannot run.
   */
  tts?: {
    /** Base of the OpenAI-shaped speech API; `/audio/speech` is appended. */
    baseURL: string
    /** The service's model id. */
    model: string
    /** The speaker the service was built with. */
    voice: string
    /** Container asked for, one of `mp3`, `wav`, `flac`, `opus`, `aac`. */
    format: 'mp3' | 'wav' | 'flac' | 'opus' | 'aac'
    /**
     * The ASR model a `voice` job transcribes its track with; absent, the
     * service's own default Whisper.
     */
    asrModel?: string
    /**
     * `tts` sends the whole `voice` action through this service instead of the
     * ComfyUI RVC graph: the track is transcribed and read back out. Absent
     * (or `rvc`), the graph stays the voice changer.
     */
    voiceChange?: 'tts' | 'rvc'
  }
  /**
   * The person the studio draws, as a JSON file: the identity paragraph the
   * prompts start with. Absent, the studio uses a neutral default and every
   * action still runs.
   */
  persona?: {
    /** Absolute path of the persona JSON. */
    path: string
  }
  /** Where produced media is saved; defaults to `<data>/comfy/outputs`. */
  outputDir?: string
}

/**
 * The boot check of one field. Nothing is required: a declared sub-object is
 * checked even for an entry the deployment omitted (as `{}`), and a required
 * field would then fail the boot. An entry without a path is one the
 * deployment did not configure, and a pin missing either half is treated as
 * absent at load.
 */
function checkOf(spec: FieldSpec): Check {
  switch (spec.kind) {
    case 'text':
      return string({ min: 1 })
    case 'string':
      return string()
    case 'number':
      return number({ min: spec.min, max: spec.max })
    case 'list':
      return list(string())
    case 'object':
      return object(Object.fromEntries(Object.entries(spec.members).map(([name, member]) => [name, checkOf(member)])))
    case 'inputs':
      // The value is any input value; its shape is checked by the loader.
      return list(object({ nodeId: string({ min: 1 }), field: string({ min: 1 }) }))
  }
}

/** One workflow entry's check: the shared fields plus the row's extras. */
function workflowCheck(fields: Readonly<Record<string, FieldSpec>>): Check {
  return object(Object.fromEntries(
    Object.entries({ ...BASE_FIELDS, ...fields }).map(([name, spec]) => [name, checkOf(spec)]),
  ))
}

const configCheck = object({
  workflows: object(Object.fromEntries(WORKFLOW_ROWS.map(row => [row.config, workflowCheck(row.fields)]))),
  /*
   * Where a `speak` job reads its text out loud. The service offers one voice
   * and takes the OpenAI speech fields; `format` is asked for explicitly
   * because the same request without it answers with a WAV several times the
   * size of the mp3. Optional: absent, the action says it is not configured.
   */
  tts: object({
    baseURL: string({ min: 1 }),
    model: string({ min: 1 }),
    voice: string({ min: 1 }),
    format: oneOf(['mp3', 'wav', 'flac', 'opus', 'aac']),
    asrModel: string({ min: 1 }),
    voiceChange: oneOf(['tts', 'rvc']),
  }, { optional: true }),
  persona: object({ path: string({ min: 1 }) }, { optional: true }),
  outputDir: string({ min: 1 }),
})

/**
 * Check the plugin config at boot.
 * @param raw - the `toolComfy` section of `config.yaml`.
 * @returns the same config, checked.
 * @throws {ConfigError} naming the first field that does not fit.
 */
export const Config = (raw: unknown): Config => configCheck(raw, 'toolComfy') as Config

/** A loaded workflow: graph, pins, output extension, and the extras. */
export type LoadedWorkflow = Omit<WorkflowConfig, 'path'> & WorkflowExtras & { graph: ComfyGraph }

/** One produced file the run reports back. */
export interface ComfyProducedFile {
  readonly path: string
  readonly kind: MediaKind
}

/** The files a workflow produced plus the ComfyUI prompt id that made them. */
interface ComfyRunReport {
  readonly files: ComfyProducedFile[]
  readonly promptId: string
}

/** The first text-ish input key a pinned prompt node carries. */
function promptKeyOf(node: { inputs?: Record<string, unknown> | null }): string | undefined {
  for (const key of ['value', 'text', 'prompt', 'caption'] as const) {
    // `inputs` may be null in a hand-authored workflow: `key in null` throws.
    if (node.inputs !== undefined && node.inputs !== null && key in node.inputs) return key
  }
  return undefined
}

/** A file handed to a run: its bytes and the name ComfyUI sees. */
interface MediaBytes {
  bytes: Uint8Array
  name: string
}

/** What a run is handed beside its values: the files, the declared name and the job's hooks. */
export interface RunInputs {
  /** The declared first-output path, when one exists. */
  readonly declared?: string | undefined
  /** The input still, when the graph takes one. */
  readonly inputImage?: MediaBytes | undefined
  /** The input clip, when the graph takes one. */
  readonly inputVideo?: MediaBytes | undefined
  /** The input track, when the graph takes one. */
  readonly inputAudio?: MediaBytes | undefined
  /** The frame the shot arrives at, or the zone edit's mask. */
  readonly lastImage?: MediaBytes | undefined
  /** An edit's reference photo (`refImageNodeId`). */
  readonly refImage?: MediaBytes | undefined
  /**
   * The file slots of an uploaded card: the node that receives them, the kind
   * and the bytes. Written by `parameterize` after uploading them to ComfyUI.
   */
  readonly customFiles?: readonly { readonly node: string; readonly kind: 'image' | 'video' | 'audio'; readonly name: string; readonly bytes: Uint8Array }[] | undefined
  /** Fired as soon as the prompt id is known. */
  readonly onPrompt?: ((promptId: string) => void) | undefined
  /** Fired when the host restarts ComfyUI mid-run. */
  readonly onRestart?: (() => void) | undefined
  /** Caller cancellation, which ends the history wait. */
  readonly signal?: AbortSignal | undefined
  /** A longer deadline for this run than ComfyUI's own (`comfy.timeoutMs`), never a shorter one. */
  readonly timeoutMs?: number | undefined
  /**
   * How the job asks the user and shows progress when ComfyUI first has to
   * install what the graph needs (`comfy-setup.ts`). Absent, a missing piece
   * is reported unless «Install automatically» is on.
   */
  readonly setup?: SetupHooks | undefined
}

/**
 * Write the prompt into the workflow's prompt node.
 *
 * The node is the pinned one, or the first text node; the key is the pinned
 * `promptField`, or the first of `value`/`text`/`prompt`/`caption` the node
 * carries. A card whose graph keeps its prompt on an unusual key says so in
 * `meta.json` (`promptField`), and without that pin it could never run.
 * @param graph - the cloned graph about to be sent.
 * @param workflow - the loaded workflow, with its pins.
 * @param prompt - the text the run was asked for.
 * @throws {ComfyError} when the node is missing or carries no text input.
 */
export function writeWorkflowPrompt(graph: ComfyGraph, workflow: LoadedWorkflow, prompt: string): void {
  const promptId = workflow.promptNodeId ?? promptNode(graph)?.id
  if (promptId === undefined) return
  const node = graph[promptId]
  if (node === undefined) {
    throw new ComfyError(`workflow has no prompt node at ${promptId}`, 'COMFY_GRAPH_REJECTED')
  }
  const key = workflow.promptField ?? promptKeyOf(node)
  if (key === undefined) {
    throw new ComfyError(
      `prompt node ${promptId} carries no value/text/prompt/caption input`,
      'COMFY_GRAPH_REJECTED',
    )
  }
  ;(node.inputs)[key] = prompt
}

/**
 * The input names a sampler's seed goes by, in the order they are tried: the
 * classic `KSampler`, then the noise nodes of the MiniMax graphs.
 */
const KNOWN_SEED_FIELDS = ['seed', 'noise_seed'] as const

/**
 * Write the seed into the node the workflow pins, or the discovered sampler.
 *
 * The key is the pinned `seedField`, or the first of the names a sampler's seed
 * goes by; a node with none of them is left alone rather than invented, which
 * is the behaviour a graph saved with a different sampler has always had.
 *
 * Two names, because the two recipes of one configuration entry are two
 * GRAPHS: `path` and `pathHigh` are written by different nodes, and `KSampler`
 * takes `seed` while the noise nodes (`RandomNoise`) take `noise_seed`. With
 * one pinned name and no fallback, the «Quality» graph of an H3 clip
 * silently received no seed at all and its renders were not reproducible
 * (measured 2026-11-06, from the mannequin A/B). So the pinned name comes
 * first and the other of the two is tried after it; a pinned name that is
 * neither of them is used as it is, and never guessed at.
 * @param graph - the cloned graph about to be sent.
 * @param workflow - the loaded workflow, with its pins.
 * @param seed - the run's seed; absent, one is drawn.
 */
export function writeWorkflowSeed(graph: ComfyGraph, workflow: LoadedWorkflow, seed: number | undefined): void {
  const seedId = workflow.seedNodeId ?? seedNode(graph)?.id
  if (seedId === undefined) return
  const node = graph[seedId]
  if (node === undefined) return
  const declared = workflow.seedField === undefined || workflow.seedField === '' ? undefined : workflow.seedField
  const names: readonly string[] = declared === undefined
    ? KNOWN_SEED_FIELDS
    : declared === 'seed'
      ? ['seed', 'noise_seed']
      : declared === 'noise_seed'
        ? ['noise_seed', 'seed']
        : [declared]
  const key = names.find(name => name in node.inputs)
  if (key === undefined) return
  ;(node.inputs)[key] = seed ?? Math.floor(Math.random() * 0xffffffff)
}

/** The values a run sets on a workflow before it runs. */
export interface RunOpts {
  prompt?: string | undefined
  seed?: number | undefined
  /** The high-quality photo recipe: the workflow's `steps.high`. */
  quality?: ImagineQuality | undefined
  /**
   * Values written into the graph for this run only, keyed `<node>.<field>`.
   *
   * Used by an uploaded workflow's exposed inputs: they are not settings of the
   * studio, they are controls of that card, and they apply to the clone
   * `parameterize` makes, never to the loaded graph.
   */
  fields?: Readonly<Record<string, unknown>>
  /** The slow clip recipe: the `pathHigh` graph, else `highInputs` and `steps.high` on the same graph. */
  speed?: ImagineSpeed | undefined
  size?: string | undefined
  /**
   * True when the size came from a ratio the user named.
   *
   * A graph that measures the photo it is given (the Krea 2 edit) keeps that
   * photo's shape; writing the size on it anyway is what cropped a 4:5 photo
   * to a studio ratio. A size nobody asked for therefore leaves the
   * measurement alone, and only a named ratio overrides it.
   */
  canvasAsked?: boolean | undefined
  aspectRatio?: string | undefined
  seconds?: number | undefined
  megapixels?: number | undefined
  lyrics?: string | undefined
  /** Phrase the tracker reads to find the object in the clip; `objectSwap` only. */
  subjectText?: string | undefined
  /** What the tracked object becomes in an object swap, as a short phrase. */
  referenceText?: string | undefined
  /** The placement box of «add an object», already serialised as JSON. */
  placementText?: string | undefined
  /** A character swap without lip-sync: H3 hears silence and is told nobody sings. */
  noLipSync?: boolean | undefined
  /** The plan's resolution label, from the composer's step (480p, else the graph's 736p). */
  planResolution?: string | undefined
  /** A chained clip's production plan, as JSON. */
  planJson?: string | undefined
  /** A chained clip's run name. */
  runName?: string | undefined
  resolutionMax?: number | undefined
  realistic?: boolean | undefined
  songStart?: number | undefined
  songDuration?: number | undefined
  voice?: string | undefined
  pitch?: number | undefined
  chain?: ComfyChainLink | undefined
}

/**
 * How much audio before the shot is written into the latent as context.
 *
 * The audio VAE is a causal DAC: a slice that begins on the shot's first frame
 * leaves that frame's token wrong in most takes. One second of preroll is what
 * the community's masked-audio workflows use; the sampler never sees it as
 * content because the two latents are aligned at their ends.
 */
const SONG_PREROLL_SECONDS = 1

/**
 * The class of the image upscaler whose size inputs an upscale run writes.
 * The clip graphs have none and resize their frames instead (see below).
 */
const SEEDVR2_UPSCALER = 'SeedVR2VideoUpscaler'

/**
 * Put every H3 node's explicit frame on the 32px grid the node accepts.
 *
 * The graphs that plan and chain their own clips carry `width`/`height` as
 * plain values (the Production Plan, the refiner's Image to Video), unlike the
 * sampler graphs that take a ResolutionSelector's label and megapixels and
 * round inside the node. A file saved with 720x1280 at 9:16 — the composer's
 * 720p frame — therefore reached the plan node as it was, and the node
 * refused the run before rendering: "H3 chain width and height must be
 * positive multiples of 32". The same write also catches a size a request
 * carries, so both the saved value and the requested one end up on the grid.
 * @param graph - the graph about to be sent.
 * @throws {ComfyError} `COMFY_GRAPH_REJECTED` when a frame is not positive.
 */
function enforceH3Frames(graph: ComfyGraph): void {
  for (const node of Object.values(graph)) {
    // The H3 nodes are the ones with this constraint; the still graphs round
    // on their own and must keep the size the composer asked for.
    if (!node.class_type.startsWith('MiniMaxH3')) continue
    const width = node.inputs.width
    const height = node.inputs.height
    if (typeof width !== 'number' || typeof height !== 'number') continue
    const frame = h3Frame(width, height)
    if (frame === undefined) {
      throw new ComfyError(
        message('graph.frameInvalid', { width: String(width), height: String(height) }),
        'COMFY_GRAPH_REJECTED',
      )
    }
    node.inputs.width = frame.width
    node.inputs.height = frame.height
  }
}

/**
 * One input file the graph takes: the bytes to upload and where the name
 * ComfyUI gives back is written.
 */
interface UploadSlot {
  readonly file: MediaBytes
  /** Every kind goes through the same ComfyUI endpoint; the video one is named for clarity. */
  readonly kind: 'image' | 'video'
  readonly write: (uploaded: string) => void
}

/**
 * Parameterize a loaded workflow: inject prompt/seed/size and the video extras
 * where the nodes exist and the caller provided a value, randomize an unpinned
 * seed, and list the input files with the loader node each one goes into.
 *
 * Nothing is uploaded here (2026-11-15): the setup check reads only the class
 * types and the model file names, never the input names, so the graph is
 * asked about before a clip of hundreds of megabytes crosses the network for
 * a run that then needs an install or is refused. Every pin a file goes into
 * is checked here too, so a broken pin still fails before any upload.
 * @param workflow - the loaded workflow.
 * @param opts - the run's values.
 * @param inputs - the files the graph takes.
 * @returns the graph, complete but for the uploaded names, and the uploads
 *   that fill them in ({@link uploadInputs}).
 */
function parameterize(
  workflow: LoadedWorkflow,
  opts: RunOpts,
  inputs: RunInputs,
): { readonly graph: ComfyGraph; readonly uploads: readonly UploadSlot[] } {
  const { inputImage, inputVideo, inputAudio, lastImage, refImage } = inputs
  /*
   * In the order the names used to be written in: the card's own file slots
   * first, then the image, the last frame, the reference, the clip and the
   * track, so a later slot aimed at the same input still wins.
   */
  const uploads: UploadSlot[] = []
  const graph = structuredClone(workflow.graph)
  if (workflow.refImageNodeId !== undefined && refImage === undefined) {
    // No reference: the branch leaves, and the links that pointed into it.
    dropRefBranch(graph, workflow.refImageNodeId, workflow.refEncodeNodeId)
  }
  /*
   * The card's own controls, written before anything else parameterizes the
   * graph: a value the user set must win over the file's, and the prompt and
   * the seed are written by the studio below.
   */
  for (const [key, value] of Object.entries(opts.fields ?? {})) {
    const dot = key.indexOf('.')
    if (dot < 0) throw new ComfyError(message('graph.fieldWithoutNode', { field: key }), 'COMFY_GRAPH_REJECTED')
    const node = graph[key.slice(0, dot)]
    if (node === undefined) throw new ComfyError(message('graph.noNodeForField', { node: key.slice(0, dot), field: key }), 'COMFY_GRAPH_REJECTED')
    const field = key.slice(dot + 1)
    if (!Object.hasOwn(node.inputs, field)) throw new ComfyError(message('graph.noField', { node: key.slice(0, dot), field }), 'COMFY_GRAPH_REJECTED')
    ;(node.inputs as Record<string, unknown>)[field] = value
  }

  /*
   * The file slots of uploaded cards: each file goes up to ComfyUI and the name
   * that comes back is written on the node's right input (image on `image`,
   * video on `file`, audio on `audio`). The field is recognised by the kind.
   */
  for (const file of inputs.customFiles ?? []) {
    const node = graph[file.node]
    if (node === undefined) throw new ComfyError(`no node at ${file.node} for the card's file`, 'COMFY_GRAPH_REJECTED')
    const field = file.kind === 'video'
      ? ['file', 'video', 'video_path', 'filename'].find(candidate => candidate in (node.inputs ?? {})) ?? 'file'
      : file.kind === 'audio'
        ? 'audio'
        : 'image'
    uploads.push({
      file,
      kind: file.kind === 'video' ? 'video' : 'image',
      write: (uploaded) => { (node.inputs as Record<string, unknown>)[field] = uploaded },
    })
  }

  /*
   * A VHS meta-batch graph needs an id of its own before it is sent:
   * `VHS_BatchManager` finds the run it belongs to through it, and every block
   * ComfyUI requeues carries the same one. It also lets the client tell this
   * chain's blocks from a chain someone else queued.
   */
  if (workflow.metaBatchNodeId !== undefined) {
    const node = graph[workflow.metaBatchNodeId]
    if (node === undefined) {
      throw new ComfyError(`no node at ${workflow.metaBatchNodeId}`, 'COMFY_GRAPH_REJECTED')
    }
    node.inputs['meta_batch_id'] = newMetaBatchId()
  }

  /*
   * The high recipe of 2026-11-03: «Quality: High» on a photo and «Speed:
   * Slow» on a clip both mean "more steps on the graph that would run
   * anyway". The count is the workflow's own pin, so the base recipe stays
   * whatever the file was saved with and a deployment tunes it there.
   */
  const highRecipe = opts.quality === 'high' || opts.speed === 'slow'
  /*
   * A graph that carries both recipes (the Pika clips since 2026-11-15): the
   * high one is a list of input overrides, and each run drops the nodes the
   * other recipe alone reads, so what is submitted is the graph of that
   * recipe and nothing more.
   */
  applyHighInputs(graph, workflow.highInputs, highRecipe)
  if (workflow.steps !== undefined && highRecipe) {
    /*
     * A high-quality graph does not necessarily have a steps node — Pika's
     * 6-step recipe keeps them in the sigma list — and when `pathHigh` is
     * present the graph is already the right one: here the count is raised
     * only if the node really exists, instead of refusing the run.
     */
    const node = graph[workflow.steps.nodeId]
    if (node !== undefined) node.inputs[workflow.steps.field] = workflow.steps.high
  }

  if (opts.resolutionMax !== undefined) {
    const upscaler = Object.values(graph).find(node => node.class_type === SEEDVR2_UPSCALER)
    if (upscaler !== undefined) {
      if ('resolution' in upscaler.inputs) upscaler.inputs.resolution = opts.resolutionMax
      if ('max_resolution' in upscaler.inputs) upscaler.inputs.max_resolution = opts.resolutionMax
    }
    /*
     * The clip graphs have no SeedVR2VideoUpscaler: they resize the frames
     * first (`ResizeImageMaskNode`, "scale shorter dimension") and SeedVR2
     * restores at that size. `resolutionMax` is the LONG side the job asked
     * for, so the short side is read off the clip itself — the whole file is
     * in memory here, so a `moov` past the media data is found too. Until
     * 2026-10-21 the node always kept the 1080 it was saved with, and the
     * tile's 720p choice did nothing.
     */
    // The native photo graph resizes the photo's long side before SeedVR2
    // restores it: that side is the size asked for.
    const longSide = Object.values(graph).find(node => node.class_type === 'ResizeImageMaskNode'
      && 'resize_type.longer_size' in node.inputs)
    if (longSide !== undefined) longSide.inputs['resize_type.longer_size'] = opts.resolutionMax
    const resize = Object.values(graph).find(node => node.class_type === 'ResizeImageMaskNode'
      && 'resize_type.shorter_size' in node.inputs)
    const clip = resize === undefined || inputVideo === undefined ? undefined : pixelsOfVideoBytes(inputVideo.bytes)
    if (resize !== undefined && clip !== undefined) {
      const short = opts.resolutionMax * Math.min(clip.width, clip.height) / Math.max(clip.width, clip.height)
      // The size the graph was saved with stays the ceiling: 1080 is what the
      // card renders a clip at, and what the upscale menu calls 1080p.
      const saved = resize.inputs['resize_type.shorter_size']
      const ceiling = typeof saved === 'number' && saved > 0 ? saved : Number.POSITIVE_INFINITY
      resize.inputs['resize_type.shorter_size'] = Math.min(ceiling, Math.max(2, Math.round(short / 2) * 2))
    }
  }

  if (opts.prompt !== undefined) writeWorkflowPrompt(graph, workflow, opts.prompt)
  writeWorkflowSeed(graph, workflow, opts.seed)

  const sizeId = workflow.sizeNodeId ?? sizeNode(graph)?.id
  if (opts.size !== undefined && (sizeId !== undefined || workflow.upscaleNodeId !== undefined)) {
    const size = parseSize(opts.size)
    if (size === undefined) throw new ComfyError(`invalid size "${opts.size}"; expected WxH`, 'COMFY_GRAPH_REJECTED')
    const node = sizeId === undefined ? undefined : graph[sizeId]
    /*
     * A latent whose sides are links is measured from the picture the graph is
     * given (`GetImageSize`): writing a number there replaces the measurement
     * with a canvas nobody asked for. An entry that pins the node itself
     * (`sizeNodeId`) still gets the size it asked for, and so does a run whose
     * ratio the user named.
     */
    const measured = node !== undefined && (Array.isArray(node.inputs.width) || Array.isArray(node.inputs.height))
    if (node !== undefined && (!measured || workflow.sizeNodeId !== undefined || opts.canvasAsked === true)) {
      ;(node.inputs).width = size.width
      ;(node.inputs).height = size.height
    }
    /*
     * The same size on the refiner's upscale node, when the entry declares it:
     * `MinimaxH3LatentUpscaler3D` carries a COMBO_DYNAMIC `mode` and in API
     * format its sub-inputs are `mode.width`/`mode.height` next to
     * `"mode": "target dimensions"`. Writing `width`/`height` the server
     * answers `required_input_missing` and the run does not start (measured
     * on 31/10/2026 on the Open-H3 graph).
     */
    const upscaler = workflow.upscaleNodeId === undefined ? undefined : graph[workflow.upscaleNodeId]
    if (upscaler !== undefined) {
      ;(upscaler.inputs)['mode.width'] = size.width
      ;(upscaler.inputs)['mode.height'] = size.height
    }
  }

  // The values that go into their pin as they are: the table in
  // workflow-fields.ts, where each is described.
  for (const { option, pin } of OPTION_PINS) {
    const value = opts[option]
    const target = workflow[pin]
    if (value !== undefined && target !== undefined) setInput(graph, target, value)
  }
  if (workflow.realism !== undefined) {
    // Always written, both ways: the node stays in the graph, so leaving the
    // strength as the file has it would carry one clip's verdict into the next.
    setInput(graph, workflow.realism, opts.realistic === true ? workflow.realism.strength : 0)
  }
  /*
   * The voice is a closed list on the RVC loader: a name the node does not
   * have fails the whole graph in validation, so only one it published is
   * sent and anything else leaves the workflow's own.
   */
  if (opts.voice !== undefined && workflow.voice !== undefined
    && (workflow.voices === undefined || workflow.voices.includes(opts.voice))) {
    setInput(graph, workflow.voice, opts.voice)
  }
  if (opts.pitch !== undefined && workflow.pitch !== undefined) {
    setInput(graph, workflow.pitch, Math.round(opts.pitch))
  }
  // Always written, empty when the run has none: the lyrics saved in the
  // graph are never sung by a run that did not ask for them.
  if (workflow.lyrics !== undefined) {
    setInput(graph, workflow.lyrics, opts.lyrics ?? '')
  }
  if (opts.megapixels !== undefined && workflow.aspectRatio !== undefined) {
    const node = graph[workflow.aspectRatio.nodeId]
    if (node !== undefined && 'megapixels' in node.inputs) {
      ;(node.inputs).megapixels = opts.megapixels
    }
  }

  if (inputImage !== undefined) {
    const imageId = workflow.imageNodeId ?? imageInputNode(graph)?.id
    if (imageId === undefined) {
      throw new ComfyError('workflow has no LoadImage node for the input image', 'COMFY_GRAPH_REJECTED')
    }
    const node = graph[imageId]
    if (node === undefined) throw new ComfyError(`no node at ${imageId}`, 'COMFY_GRAPH_REJECTED')
    uploads.push({ file: inputImage, kind: 'image', write: (uploaded) => { (node.inputs)[workflow.imageField ?? 'image'] = uploaded } })
  }

  /*
   * The frame the shot has to arrive at. Given one, the sampler interpolates
   * from the first photo to this one, so the shot ends exactly where the next
   * begins; given none, the `last_frame` link is removed and the sampler is
   * back to animating a single still. The link cannot simply be left pointing
   * at whatever the graph was saved with: that would silently drive every
   * shot towards a photo nobody chose.
   */
  if (workflow.lastFrameNodeId !== undefined) {
    const sampler = graph[workflow.lastFrameNodeId]
    if (sampler !== undefined && lastImage === undefined) {
      delete sampler.inputs['last_frame']
    }
  }
  if (lastImage !== undefined && workflow.lastImageNodeId !== undefined) {
    const node = graph[workflow.lastImageNodeId]
    if (node === undefined) throw new ComfyError(`no node at ${workflow.lastImageNodeId}`, 'COMFY_GRAPH_REJECTED')
    uploads.push({ file: lastImage, kind: 'image', write: (uploaded) => { (node.inputs)[workflow.imageField ?? 'image'] = uploaded } })
  }

  if (refImage !== undefined && workflow.refImageNodeId !== undefined) {
    const node = graph[workflow.refImageNodeId]
    if (node === undefined) throw new ComfyError(`no node at ${workflow.refImageNodeId}`, 'COMFY_GRAPH_REJECTED')
    uploads.push({ file: refImage, kind: 'image', write: (uploaded) => { (node.inputs)['image'] = uploaded } })
  }

  if (inputVideo !== undefined) {
    const videoId = workflow.videoNodeId ?? videoInputNode(graph)?.id
    if (videoId === undefined) {
      throw new ComfyError(message('graph.noVideoLoader'), 'COMFY_GRAPH_REJECTED')
    }
    const node = graph[videoId]
    if (node === undefined) throw new ComfyError(`no node at ${videoId}`, 'COMFY_GRAPH_REJECTED')
    uploads.push({ file: inputVideo, kind: 'video', write: (uploaded) => { (node.inputs)[workflow.videoField ?? 'file'] = uploaded } })
  }

  /*
   * The track the clip sings. Uploaded through the same endpoint as an image
   * or a video — ComfyUI keys its input folder by the name it returns — and
   * the two numbers say which part of the song this clip is given, so a
   * montage's shots each sing their own seconds of it.
   */
  const audioPin = workflow.songAudio
    ?? (workflow.audioNodeId === undefined ? undefined : { nodeId: workflow.audioNodeId, field: workflow.audioField ?? 'audio' })
  if (inputAudio !== undefined && audioPin !== undefined) {
    // Checked now, as the write after the upload would: a missing node fails before anything is sent.
    if (graph[audioPin.nodeId] === undefined) throw new ComfyError(`no node at ${audioPin.nodeId}`, 'COMFY_GRAPH_REJECTED')
    uploads.push({ file: inputAudio, kind: 'image', write: (uploaded) => { setInput(graph, audioPin, uploaded) } })
    /*
     * Where on the clip's timeline the slice is anchored. A shot continued
     * from the one before it carries that shot's last GUIDE_FRAMES frames as
     * its pinned head, and the Motion Context node drops any anchor inside
     * the head — so the guide starts right after it, and the slice moves
     * forward by the same frames: frame GUIDE_FRAMES of this clip is the
     * second the head ends on. The head's own audio comes with the head. A
     * first shot, and a fresh one whose head is cut off afterwards, anchor
     * at the same frame with the same shift, which is where their delivered
     * frames begin; only a clip outside any chain starts at frame 0.
     */
    const headFrames = opts.chain !== undefined && opts.chain.index > 0 ? GUIDE_FRAMES : 0
    if (workflow.songFrame !== undefined) setInput(graph, workflow.songFrame, headFrames)
    if (opts.songStart !== undefined && workflow.songStart !== undefined) {
      setInput(graph, workflow.songStart, opts.songStart + (workflow.songFrame === undefined ? 0 : headFrames / FPS))
    }
    if (opts.songDuration !== undefined && workflow.songDuration !== undefined) {
      setInput(graph, workflow.songDuration, opts.songDuration)
    }
    /*
     * The audio written into the LATENT starts a second before the clip does.
     * The audio VAE is a causal DAC: a slice cut at the shot's first frame gets
     * that frame's token wrong about six times in ten, and a second of preroll
     * brings it near one in a hundred (measured by the community). The extra
     * second is context, not content — LipSyncSetup aligns the two latents at
     * their END — so the shot still sings from its own second.
     */
    if (workflow.songPrerollStart !== undefined || workflow.songPrerollDuration !== undefined) {
      const shift = workflow.songFrame === undefined ? 0 : headFrames / FPS
      const wanted = (opts.songStart ?? 0) + shift
      const from = Math.max(0, wanted - SONG_PREROLL_SECONDS)
      if (workflow.songPrerollStart !== undefined) setInput(graph, workflow.songPrerollStart, from)
      if (workflow.songPrerollDuration !== undefined) {
        setInput(graph, workflow.songPrerollDuration, (opts.songDuration ?? 0) + (wanted - from))
      }
    }
  }

  /*
   * Which shot of a chain this is. The loader reads slot `index` of the
   * chain's folder — slot 0 is no file, and the Motion Context node then
   * passes the conditioning through untouched — and the saver writes slot
   * `index + 1` for the shot after this one. A run that is not part of a chain
   * loads nothing and saves nothing.
   */
  if (workflow.chain !== undefined) {
    const link = opts.chain
    if (link === undefined) {
      setInput(graph, { nodeId: workflow.chain.loadNodeId, field: 'clip_index' }, 0)
      Reflect.deleteProperty(graph, workflow.chain.saveNodeId)
    } else {
      setInput(graph, { nodeId: workflow.chain.loadNodeId, field: 'latent_path' }, link.folder)
      setInput(graph, { nodeId: workflow.chain.loadNodeId, field: 'clip_index' }, link.fresh === true ? 0 : link.index)
      setInput(graph, { nodeId: workflow.chain.saveNodeId, field: 'filename_prefix' }, `${link.folder}/clip`)
      setInput(graph, { nodeId: workflow.chain.saveNodeId, field: 'clip_index' }, link.index + 1)
    }
  }

  /*
   * Last, after every value has been written: the frame an H3 node ends up
   * with is the one the file and the request left there, so the grid is
   * enforced once on the finished graph rather than at each write.
   */
  enforceH3Frames(graph)

  return { graph, uploads }
}

/**
 * Upload a run's input files side by side and write the names ComfyUI gave
 * back into the graph.
 *
 * The uploads do not depend on each other, so they start together: a clip
 * and its photo used to cross the network one after the other, and a card's
 * own file slots one by one before everything else. The names are written
 * only once all are in, in the slots' order, so the outcome does not depend
 * on which upload finishes first.
 * @param ctx - plugin context (for the ComfyUI client).
 * @param uploads - the slots {@link parameterize} listed.
 * @param signal - the job's cancellation, which stops an upload in flight.
 */
async function uploadInputs(ctx: ImagineHost, uploads: readonly UploadSlot[], signal: AbortSignal | undefined): Promise<void> {
  const names = await Promise.all(uploads.map(async ({ file, kind }) => {
    const uploaded = kind === 'video'
      ? await ctx.comfy.uploadVideo(file.name, file.bytes, signal)
      : await ctx.comfy.uploadImage(file.name, file.bytes, signal)
    return uploaded.name
  }))
  uploads.forEach((slot, index) => { slot.write(names[index] as string) })
}

/** The lipsync probe over a sung shot, and what to do with its number. */
interface ComfyLipsyncCheck {
  /** Executable: `probe <clip> <voice> <second the clip starts at>` → JSON with `corr0`. */
  readonly probe: string
  /** Under this the shot is rendered again; default LIPSYNC_MIN in story.ts. */
  readonly min?: number
  /** How many new seeds a weak shot gets; default 1. */
  readonly retries?: number
  /**
   * Executable: `faceCrop <photo> <out.png>` → JSON with `ok`. Writes a
   * close-up of the one face in a photo at the photo's ratio; a take sung on
   * one photo arrives at it in every shot after the first, so the mouth stays
   * large enough to follow the voice. Without it the photo itself is used.
   */
  readonly faceCrop?: string
}

/** One shot's place in a chain of continued shots. */
export interface ComfyChainLink {
  /** The folder under ComfyUI's output directory the chain's latents live in. */
  folder: string
  /** This shot's index in the chain, from 0; the slot it continues from. */
  index: number
  /**
   * Continue from nothing but still save for the next shot.
   *
   * Set when the previous shot's latent was never written: the shot starts
   * fresh from its photo, and the one after it can still continue from this
   * one. Forcing the index to 0 instead made it save into slot 1 — the first
   * shot's — and every second shot of the chain then found no latent.
   */
  fresh?: boolean
}

/** Write one extra input into its node. */
function setInput(graph: ComfyGraph, input: { nodeId: string; field: string }, value: unknown): void {
  const node = graph[input.nodeId]
  if (node === undefined) throw new ComfyError(`no node at ${input.nodeId}`, 'COMFY_GRAPH_REJECTED')
  ;(node.inputs)[input.field] = value
}

/**
 * The output path a run declares before it starts: `<tool>-<hash of the
 * values>.<ext>`, so the gallery can tell what a file came from by its name.
 * The write goes through {@link freeOutputPath}, because the same values run
 * twice declare the same name.
 * @param outputDir - validated media output directory.
 * @param tool - the action's file prefix (`generate_image`, …).
 * @param ext - the declared output extension.
 * @param args - the run's values.
 * @returns the absolute output path this run declares.
 */
export function declaredOutputPath(outputDir: string, tool: string, ext: string, args: object): string {
  const digest = createHash('sha1').update(JSON.stringify(args)).digest('hex').slice(0, 8)
  return join(outputDir, `${tool}-${digest}.${ext}`)
}

/**
 * The declared path, or a numbered neighbour when a file already occupies it.
 *
 * The declared name is a hash of the call values, so the same call run twice
 * — a retry, a "fallo di nuovo" — declares the same file. Writing there
 * unconditionally cost the earlier picture silently: the second run replaced
 * the first and only one of the two was left on the board. The caller keeps
 * the declared name whenever it is free, which is the ordinary case, and the
 * numbering only ever appears where a collision actually happened.
 * @param declared - the absolute path the call declared.
 * @returns a path that no file occupies.
 */
export function freeOutputPath(declared: string): string {
  if (!existsSync(declared)) return declared
  const ext = extname(declared)
  const stem = declared.slice(0, declared.length - ext.length)
  // Bounded: the caller writes once, and a directory with hundreds of
  // same-stem files means something else is filling it, not this loop.
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem}-${String(n)}${ext}`
    if (!existsSync(candidate)) return candidate
  }
  throw new Error(message('file.noFreeName', { name: declared }))
}

/**
 * Run one parameterized workflow and persist every produced file: the first
 * media lands at the declared path (a free neighbour when it is taken), every
 * further media keeps a `${promptId}-<index>.<ext>` name.
 * @param ctx - plugin context.
 * @param workflow - the loaded workflow.
 * @param outputDir - validated media output directory.
 * @param opts - the run's values.
 * @param inputs - the declared first-output path, the input files and the
 *   job's hooks (`onPrompt`, `onRestart`, `signal`).
 * @returns the produced-file report with the prompt id.
 */
export async function runWorkflow(
  ctx: ImagineHost,
  workflow: LoadedWorkflow,
  outputDir: string,
  opts: RunOpts,
  inputs: RunInputs = {},
): Promise<ComfyRunReport> {
  const { graph, uploads } = parameterize(workflow, opts, inputs)
  const { declared, onPrompt, onRestart, signal, timeoutMs } = inputs
  /*
   * ComfyUI gets what this graph needs first (comfyui-imagine's setup), or is
   * left as it is — and before the uploads: the check reads class types and
   * model file names, which the uploaded names never are, and a run that
   * needs an install or is refused has not pushed its clip for nothing.
   * The model names it substitutes are not touched by the uploads either.
   */
  await ensureComfyReady(ctx, graph, { ...inputs.setup, ...signal === undefined ? {} : { signal } })
  await uploadInputs(ctx, uploads, signal)
  /*
   * A cancelled run has to end here, not at the deadline. Deleting the prompt
   * from ComfyUI's queue means no history record is ever written for it, so
   * the wait polls a run that will never settle: the scratch files stayed on
   * disk and the next job in the queue waited out the whole timeout.
   */
  // A VHS meta-batch chain (the id `parameterize` wrote into its batch
  // manager) is followed through the queue by the client itself.
  const run = await ctx.comfy.run(graph, { signal, onPrompt, onRestart, timeoutMs })
  await mkdir(outputDir, { recursive: true })
  const files: ComfyProducedFile[] = []
  let index = 0
  for (const media of run.media) {
    const ext = (media.format ?? media.filename.split('.').pop() ?? 'bin').toLowerCase()
    // A first output goes to the declared name; when that name is occupied
    // the run moves aside and the report says where the file landed.
    /*
     * The declared name takes the extension the file really has: a graph
     * changed to PNG under a config.yaml still saying `outputExt: webp` (the
     * repository's graphs switched on 2026-11-15) stored PNG bytes under a
     * .webp name.
     */
    const target = index === 0 && declared !== undefined
      ? freeOutputPath(extname(declared).slice(1).toLowerCase() === ext ? declared : `${declared.slice(0, declared.length - extname(declared).length)}.${ext}`)
      : join(outputDir, `${run.promptId}-${index}.${ext}`)
    // Streamed: a clip can run to hundreds of megabytes.
    await ctx.comfy.fetchMediaTo(media, target)
    index += 1
    const kind = IMAGE_EXTENSIONS.has(ext) ? 'image' : kindOf(target) ?? (AUDIO_EXTENSIONS.has(ext) ? 'audio' : 'video')
    files.push({ path: target, kind })
  }
  return { files, promptId: run.promptId }
}

/**
 * How long boot waits before continuing videos a restart interrupted.
 *
 * Long enough for the ComfyUI host to have answered its first status probe, so
 * the resumed shots do not queue against a socket that is not up yet; short
 * enough that a user watching the studio sees the video pick itself back up.
 */
const RESUME_SWEEP_DELAY_MS = 8000

/** The host's switches, read at the moment they act. */
interface ApplyOptions {
  /**
   * Whether this process resumes interrupted music videos at boot (the
   * settings page, else IMAGINE_RESUME_SWEEP=1): only one process may resume
   * stories and drop orphans against a given ComfyUI.
   */
  readonly resumeSweep?: () => boolean
  /**
   * The workflow entries of `config.example.yaml`, when the file ships beside
   * the app: the defaults of the included graphs, and the keys an old config
   * is reported as missing.
   */
  readonly exampleWorkflows?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

/**
 * Boot the plugin: settings overrides, workflows, routes, resume sweep.
 * @param ctx - the host context.
 * @param config - the plugin's composed config.
 * @param host - the host's switches.
 * @returns the media directory in force (settings page first, then config),
 *   so the host's own routes serve the same folder without reading the
 *   settings file a second time.
 */
export function apply(ctx: ImagineHost, config: Config, host: ApplyOptions = {}): { readonly outputDir: string } {
  /*
   * The Imagine settings page keeps its changes outside `config.yaml` and
   * hands them here at boot: the connection first, so every later call already
   * talks to the server the user chose, then the media directory and the
   * workflow entries. A file that does not parse is reported and ignored — a
   * settings mistake must not stop the studio from generating. (Imagine's
   * models are set by the host from its own settings page, not here.)
   */
  const settings = loadImagineOverrides()
  if (settings.problem !== undefined) {
    console.warn(`[imagine] imagine-settings.json ignored: ${settings.problem}`)
  }
  ctx.comfy.applyOverrides(settings.overrides.server ?? {})
  const composedOutputDir = config.outputDir ?? dataPath('comfy', 'outputs')
  const outputDir = settings.overrides.outputDir ?? composedOutputDir
  /*
   * The persona the prompts are written from. A file that does not fit is
   * reported and ignored, like the settings file: a typo in a prompt must not
   * stop the studio from generating.
   */
  try {
    setPersona(loadPersona(config.persona?.path))
  } catch (error: unknown) {
    console.warn(`[imagine] persona ignorata: ${String(error)}`)
    setPersona(undefined)
  }
  const composedWorkflows = config.workflows ?? {}
  /*
   * Where the graphs are read from and written to. A service, a container and
   * the portable packages write the files `config.yaml` names; a packaged app
   * has a read-only program, so a graph that ships with it is copied into the
   * data folder at the first edit and the copy wins until «Restore default»
   * (`workflow-overlay.ts`).
   */
  const overlay = createWorkflowOverlay({ programDir: programDirFrom() })
  const { rows, byRun: configuredWorkflows, holders, gaps } = loadWorkflows(
    mergeWorkflowMaps(composedWorkflows, settings.overrides.workflows ?? {}), overlay,
    host.exampleWorkflows as unknown as WorkflowMap | undefined,
  )
  /*
   * An old `config.yaml` boots, but the features added since it was copied are
   * off without a word (`refImageNodeId`, a second high-recipe graph, a LoRA
   * pin). Say which keys the example has and this file does not: the settings
   * page shows the same list on the workflow.
   */
  for (const gap of gaps) {
    console.warn(`[imagine] workflows.${gap.configKey}: config.yaml is missing ${gap.fields.join(', ')} (present in config.example.yaml); update the entry from the example`)
  }
  const configGaps = new Map(gaps.map(gap => [gap.configKey, gap.fields] as const))
  /*
   * The uploaded graphs join the configured ones under `custom:<id>`. The map
   * is mutable on purpose: a workflow saved from the page has to run without a
   * restart, and the runner holds this very object.
   */
  const imagineWorkflows: WorkflowGraphs = { ...configuredWorkflows } as WorkflowGraphs
  const refreshCustomWorkflows = async (id: string): Promise<LoadedWorkflow | undefined> => {
    /*
     * Read first, swap after, with no await in between: the old keys used to
     * be deleted before the load, and a job starting while the files were
     * being read found its card gone (`actionNotConfigured`). Only the card
     * a save or a removal touched is read: the others did not change.
     */
    const fresh = await loadCustomWorkflow(id)
    const live = imagineWorkflows as Record<string, unknown>
    const key = customKey(id)
    if (fresh === undefined) delete live[key]
    else live[key] = fresh
    return fresh
  }
  Object.assign(imagineWorkflows as Record<string, unknown>, loadCustomWorkflowsSync())
  const { videoOnSong } = imagineWorkflows
  /*
   * Every loaded copy of a graph, found by its file when an edit lands: the
   * configured rows and their high-recipe graphs, read once here, and the
   * personal cards as the live map holds them now (a save replaces them).
   */
  const editor = graphEditor(function* (): Generator<GraphHolder> {
    yield* holders
    for (const [key, loaded] of Object.entries(imagineWorkflows as Record<string, unknown>)) {
      const file = customGraphFile(key)
      if (file !== undefined && loaded !== undefined) yield { file, loaded: loaded as LoadedWorkflow }
    }
  }, overlay)
  /*
   * The cards the written lane may run as `action: custom`, read from disk at
   * each turn so one uploaded while the studio is open is offered without a
   * restart. Only the ones whose graph loaded: a folder with a broken
   * `graph.json` is not something a sentence can run.
   */
  const cardsOf = (): readonly CustomWorkflowMeta[] => listCustomWorkflowsSync()
    .filter(meta => (imagineWorkflows as Record<string, unknown>)[customKey(meta.id)] !== undefined)
  const {
    inventory, applyKeyed, addLora, removeLora: removeLoraOf, lorasOf, tuneLora, restoreDefault,
  } = workflowInventory(ctx, rows, editor, overlay, cardsOf, configGaps)
  /*
   * What the settings page reads of the layers this entry booted with. The
   * composed values come from `config.yaml`, the applied ones from the settings
   * file, and the file's own text is kept so a later read can tell whether
   * what is on disk has reached this process yet.
   */
  const settingsSurface: ImagineSettingsSurface = {
    outputDir: { composed: composedOutputDir, running: outputDir },
    composedWorkflows,
    appliedRaw: settings.raw,
    bootProblem: settings.problem,
  }

  // POST /comfy-zip streams several gallery files as one archive. Its own
  // prefix, not a name under /comfy-media, so no request can be read as either.
  ctx.webServer.register({ kind: 'prefix', path: '/comfy-zip', handler: zipHandler(outputDir) })
  // The workflows the user added: listed, saved, removed, and their covers.
  ctx.webServer.register({
    kind: 'prefix',
    path: '/comfy-custom-workflows',
    handler: customWorkflowsHandler(ctx, refreshCustomWorkflows, editor),
  })
  ctx.webServer.register({ kind: 'prefix', path: '/comfy-custom-cover', handler: customCoverHandler() })

  // Serve the produced media and the Imagine inventory over the GUI's own
  // origin: the server is headless, so a native file open cannot reach the
  // user. GET /comfy-media lists the gallery; GET /comfy-media/<name> streams
  // one file (range-capable); DELETE /comfy-media/<name> removes it. An
  // uploaded still or clip is looked at on arrival, which is why the context
  // comes along.
  ctx.webServer.register({
    kind: 'prefix',
    path: '/comfy-media',
    handler: mediaHandler(outputDir, ctx),
  })
  ctx.webServer.register({
    kind: 'prefix',
    path: '/comfy-imagine',
    handler: imagineHandler({
      ctx, inventory, applyWorkflow: applyKeyed, addLora, removeLora: removeLoraOf, lorasOf, tuneLora,
      restoreWorkflow: async key => ({ restored: (await restoreDefault(key)).restored }),
      workflows: imagineWorkflows, outputDir, settings: settingsSurface, speak: config.tts,
    }),
  })

  /*
   * Pick up a music video a restart left half-made. The job queue lives in
   * memory, so a crash, an update or an out-of-memory kill during a long video
   * loses every shot still to render; the record on disk is what survives. The
   * sweep continues each unfinished story from it — the user asked for exactly
   * this, "when it gets stuck it must resume from where it stopped" — unless
   * they threw it away, in which case there is no record to resume. Deferred a
   * few seconds so the ComfyUI host has answered before the first shot is
   * queued, and cancelled on dispose so a shutdown does not fire it.
   *
   * The host's `resumeSweep` setting (IMAGINE_RESUME_SWEEP=1 or the settings
   * page) switches it: only one process may resume stories and drop orphans
   * against a given ComfyUI.
   */
  if (videoOnSong !== undefined && host.resumeSweep?.() === true) {
    const timer = globalThis.setTimeout(() => {
      /*
       * The queue this process inherited comes first. A run the previous process
       * was waiting on is still executing on the host, with nobody left to
       * collect it: resuming on top of it queues the same shot twice and the
       * card does the work again behind a result that goes nowhere. Dropping
       * it is best effort — a host that will not answer is the resume's
       * problem to report, not this line's.
       */
      void ctx.comfy.dropOrphans().then((dropped) => {
        if (dropped > 0) console.log(`[imagine] removed ${String(dropped)} orphan runs from the ComfyUI queue`)
      }, () => undefined).then(() => resumeUnfinishedStories(ctx, imagineWorkflows, outputDir)).then((resumed) => {
        if (resumed.length > 0) console.log(`[imagine] resumed ${String(resumed.length)} interrupted music videos after the restart`)
      }, () => undefined)
    }, RESUME_SWEEP_DELAY_MS)
    ctx.effect(() => () => { globalThis.clearTimeout(timer) }, 'tool-comfy: resume sweep')
  }

  return { outputDir }
}
