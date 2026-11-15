/**
 * Every workflow the studio knows and every field an entry may carry, once.
 *
 * Before 2026-10-21 the same list was spelt in the config interface, the boot
 * schema, the loaded-workflow type, the loader and four sets of the settings
 * page, and the copies had drifted: the page refused `canvasMegapixels` and
 * `identity`, and had no row for the zone edit at all. The schema in
 * `index.ts`, the loader, the settings validation and the config and job
 * types are all read off this table. No imports beyond types, so both
 * `index.ts` and `imagine-settings.ts` can load it without a cycle.
 * @module tool-comfy/workflow-fields
 */

import type { LoadedWorkflow, RunOpts, WorkflowConfig, WorkflowExtras } from './index.ts'

/**
 * How one field, or one member of an object field, is written.
 *
 * Three readers walk this table, each with its own job: the boot schema
 * (`index.ts` `checkOf`) refuses only a value of the wrong type, so a
 * half-written `config.yaml` entry still boots; the loader (`workflow-load.ts`
 * `loadedField`) keeps what a run can use and drops the rest — a pin missing
 * one half, a list without a usable entry; the settings validation
 * (`imagine-settings.ts` `specProblem`) refuses, with a message, what the
 * page may not store. They agree on what a usable value is.
 */
export type FieldSpec =
  /** A non-empty string. */
  | { readonly kind: 'text' }
  /** Any string, the empty one included (a LoRA trigger word may be blank). */
  | { readonly kind: 'string' }
  | { readonly kind: 'number'; readonly min?: number; readonly max?: number }
  /** A list of non-empty strings. */
  | { readonly kind: 'list' }
  | { readonly kind: 'object'; readonly members: Readonly<Record<string, FieldSpec>> }

const TEXT = { kind: 'text' } as const satisfies FieldSpec

/** A `{ nodeId, field }` pin into the graph. */
const PIN = { kind: 'object', members: { nodeId: TEXT, field: TEXT } } as const satisfies FieldSpec

/** The fields every workflow entry accepts. */
export const BASE_FIELDS: Readonly<Record<string, FieldSpec>> = {
  ...Object.fromEntries([
    'path', 'pathHigh', 'promptNodeId', 'promptField', 'seedNodeId', 'seedField', 'imageNodeId', 'imageField',
    'lastImageNodeId', 'lastFrameNodeId', 'refImageNodeId', 'refEncodeNodeId', 'videoNodeId', 'videoField', 'audioNodeId', 'audioField',
    'sizeNodeId', 'upscaleNodeId', 'outputExt',
  ].map(name => [name, TEXT])),
  /**
   * Where the sampler steps sit in the graph, and the count the high recipe
   * asks for: `quality: 'high'` on a photo, `speed: 'slow'` on a clip
   * (2026-11-03). Without the pin the graph keeps the count it was saved with,
   * which is what «Standard» and «Veloce» mean.
   */
  steps: { kind: 'object', members: { nodeId: TEXT, field: TEXT, high: { kind: 'number', min: 1, max: 200 } } },
}

/** The fields a clip workflow adds: format, length and the realism LoRA. */
const CLIP_FIELDS = {
  aspectRatio: PIN,
  seconds: PIN,
  realism: { kind: 'object', members: { nodeId: TEXT, field: TEXT, strength: { kind: 'number' }, token: { kind: 'string' } } },
} as const satisfies Readonly<Record<string, FieldSpec>>

/**
 * The fields of a «Modifica oggetto» graph: what the tracker follows, what it
 * becomes, the placement box and the plan's resolution.
 *
 * In a single block because the five rows (change, remove, background, add,
 * add from a photo) want them identical: a divergence here would be a pin one
 * mode writes and another does not, i.e. a graph that renders with the file's
 * own texts. Every shipped graph is an Openjutsu chain that plans and cuts its
 * own windows, so the pins of the windowed design are gone (2026-11-15): the
 * window start, the shot document and the window area are retired and
 * ignored where an old entry still carries them ({@link RETIRED_WORKFLOW_FIELDS});
 * `aspectRatio` and `seconds` stay valid for the clip rows, so an old entry
 * that pins them still loads them.
 */
const OBJECT_SWAP_FIELDS = {
  subjectText: PIN,
  referenceText: PIN,
  /**
   * Only the «add an object» mode: the placement box, as a JSON string of
   * normalized keyframes, written into the input of the
   * `H3ObjectPlacementMask` node. It is a pin and not a fixed field because
   * the node that receives it belongs to the graph, not to the studio
   * (2026-11-06).
   */
  placementText: PIN,
  /** A graph that plans its own clips (Openjutsu's): its resolution label. */
  planResolution: PIN,
} as const satisfies Readonly<Record<string, FieldSpec>>

/**
 * One row per workflow, in the order the settings page lists them.
 *
 * `config` is the entry in the plugin configuration, `run` the name the job
 * runner knows the loaded graph by, and `key`/`label` how the chat and the
 * settings page address it; `extractVocals` is an internal step and has none.
 * The field names are checked against `WorkflowExtras` (where their types and
 * meaning are documented), and the config entry and loaded-workflow types are
 * read off this table (`WorkflowEntries`, `ImagineWorkflows`).
 */
export const WORKFLOW_ROWS = [
  /** Text-to-image: the "generate" action. */
  { config: 'generateImage', run: 'generate', key: 'generate', label: 'image generation', fields: {} },
  /**
   * The Krea 2 graph that redraws the opening frame of a `recreate` from the
   * paragraph the vision pass wrote about the reference clip.
   */
  {
    config: 'recreateFrame', run: 'recreateFrame', key: 'recreate-frame',
    label: 'opening frame to redraw (Krea 2)', fields: {},
  },
  /** Image-to-image: the "remix" action. */
  { config: 'editImage', run: 'edit', key: 'edit', label: 'image editing', fields: {} },
  /**
   * «Componi con riferimenti»: Qwen-Image 2.1 takes two photos — the person
   * and a reference (costume, setting) — and makes one of them. The graph
   * wants them in `image_1` and `image_2` of its encoder, which is also the
   * prompt node.
   */
  { config: 'composeRefs', run: 'compose', key: 'compose', label: 'compose with references (Qwen 2.1)', fields: {} },
  /**
   * The same edit confined to a zone the user marked: the graph crops it,
   * edits the crop and stitches it back, so the rest of the photo is the
   * source's own pixels. The mask rides in `lastImageNodeId`.
   */
  { config: 'editImageRegion', run: 'editRegion', key: 'edit-region', label: 'precise edit', fields: {} },
  /**
   * «Illumina la foto»: openjutsu's relight recipe, on a FLUX.3 Klein graph
   * that relights the photo. All the pins are the basic ones — the image, the
   * text (`promptNodeId`), the seed and the output prefix — and the text is
   * the sentence of the chosen look, written by `readJobRequest`.
   */
  { config: 'relight', run: 'relight', key: 'relight', label: 'relight a photo', fields: {} },
  /** Image-to-video: the "video" action. */
  { config: 'createVideo', run: 'video', key: 'video', label: 'image → video', fields: CLIP_FIELDS },
  /**
   * The same action past six seconds (2026-11-15): the Context Loop's I2V
   * chain, one scene of at most 6 s after the other, each carrying the last
   * frames of the one before, with a checkpoint per scene. The studio writes
   * the plan (`planJson`) and the run name its checkpoints go under.
   */
  {
    config: 'createVideoChain', run: 'videoChain', key: 'video-chain', label: 'image → video (long)',
    fields: { ...CLIP_FIELDS, planJson: PIN, runName: PIN },
  },
  /**
   * The clip graph a `recreate` renders from its redrawn opening frame.
   *
   * The same image-to-video shape as `createVideo`; a deployment that leaves
   * it out recreates on that graph instead, so the action is usable without
   * a second copy of the same file.
   */
  {
    config: 'recreateVideo', run: 'recreateVideo', key: 'recreate-video',
    label: 'recreate video', fields: CLIP_FIELDS,
  },
  /**
   * The "loop" action: an animated background. Its graph samples the latent
   * with its end wrapped onto its start (`MiniMaxH3Loop`) and decodes with the
   * same wrap, so the clip comes back periodic on its own and the host does not
   * close it again. The still rides along as `<Picture 1>`: a pinned first or
   * last frame fights the wrap, and the loop point became the largest jump of
   * the clip (measured 2026-10-29). A length the model cannot render in one go
   * is reached by chaining such segments.
   */
  { config: 'loopVideo', run: 'loopVideo', key: 'loop', label: 'animated loop', fields: CLIP_FIELDS },
  /**
   * A background past six seconds: the Context Loop's chain, whose last scene
   * takes the still as its last frame (a core switch on «last scene»), then
   * closed into a loop by the studio like the segment chain.
   */
  {
    config: 'loopVideoChain', run: 'loopChain', key: 'loop-chain', label: 'animated loop (long)',
    fields: { ...CLIP_FIELDS, planJson: PIN, runName: PIN },
  },
  /** The "extend" action: continues an existing clip. */
  { config: 'extendVideo', run: 'extendVideo', key: 'extend', label: 'video continuation', fields: CLIP_FIELDS },
  /**
   * The continuation past six seconds: the Context Loop's external-video
   * chain. The whole clip is the first scene's context and comes back in
   * front of the new scenes, so the studio joins nothing.
   */
  {
    config: 'extendVideoChain', run: 'extendChain', key: 'extend-chain', label: 'video continuation (long)',
    fields: { ...CLIP_FIELDS, planJson: PIN, runName: PIN },
  },
  /**
   * «Modifica oggetto»: the object tracked in the clip is changed, removed,
   * or its background replaced (2026-11-06), or an object added.
   *
   * The whole clip goes to an Openjutsu chain graph that plans and cuts its
   * own windows; the tracked subject is an OBJECT. The plan takes two short
   * texts written by `object-swap-texts.ts`: what the tracker follows and
   * what it becomes.
   *
   * ONE ROW PER MODE, each with its own `run`: the graph is a file, and the
   * three modes have different topologies. `byRun` is an object keyed by
   * `run`, so three rows with the same name would overwrite each other and
   * the `change` mode would end up with another mode's graph. The `add` mode
   * has no row here: until there is a graph, the job stops with
   * `job.objectSwapNotConfigured`.
   */
  { config: 'objectSwap', run: 'objectSwap', key: 'object-swap', label: 'object swap', fields: OBJECT_SWAP_FIELDS },
  {
    config: 'objectSwapRemove', run: 'objectSwapRemove', key: 'object-swap-remove',
    label: 'object swap (remove)', fields: OBJECT_SWAP_FIELDS,
  },
  {
    config: 'objectSwapBackground', run: 'objectSwapBackground', key: 'object-swap-background',
    label: 'object swap (background)', fields: OBJECT_SWAP_FIELDS,
  },
  {
    config: 'objectSwapAdd', run: 'objectSwapAdd', key: 'object-swap-add',
    label: 'object swap (add)', fields: OBJECT_SWAP_FIELDS,
  },
  {
    config: 'objectSwapAddPhoto', run: 'objectSwapAddPhoto', key: 'object-swap-add-photo',
    label: 'object swap (add from a photo)', fields: OBJECT_SWAP_FIELDS,
  },
  /**
   * «Cambio personaggio»: Openjutsu's one-click graph, sent once with the
   * whole clip (it cuts its own windows). The photo goes on `imageNodeId`.
   */
  { config: 'swapPerson', run: 'swapPerson', key: 'swap-person', label: 'character swap', fields: { noLipSync: PIN, planResolution: PIN } },
  /**
   * The same swap without lip-sync, a graph of its own as in Openjutsu: H3
   * hears silence, the mannequins show the faces and the plan says nobody
   * sings. The lip-sync graph has none of those nodes, so a switch alone
   * could not turn them on or off.
   */
  {
    config: 'swapPersonNoLipSync', run: 'swapPersonNoLipSync', key: 'swap-person-no-lip-sync',
    label: 'character swap (no lip-sync)', fields: { noLipSync: PIN, planResolution: PIN },
  },
  /**
   * The clip workflow that sings a track it is given.
   *
   * `MiniMaxH3AddGuide` anchors a soundtrack at a frame of the video, and H3
   * animates to it — the mouth follows the song rather than audio the model
   * invented. Measured on this deployment: the clip's own audio tracks the
   * guide slice at 0.906 envelope correlation against 0.134 for a different
   * slice of the same song.
   */
  {
    config: 'videoOnSong', run: 'videoOnSong', key: 'video-song', label: 'clip on a song',
    fields: {
      ...CLIP_FIELDS,
      songAudio: PIN,
      songStart: PIN,
      songDuration: PIN,
      songFrame: PIN,
      songPrerollStart: PIN,
      songPrerollDuration: PIN,
      lipsync: {
        kind: 'object',
        members: { probe: TEXT, min: { kind: 'number', min: 0, max: 1 }, retries: { kind: 'number', min: 0, max: 3 } },
      },
      chain: { kind: 'object', members: { loadNodeId: TEXT, saveNodeId: TEXT } },
      chainShotSeconds: { kind: 'number', min: 3, max: 15 },
    },
  },
  /** The "upscale" action on a still. */
  { config: 'upscaleImage', run: 'upscaleImage', key: 'upscale-image', label: 'image upscale', fields: {} },
  /** The "upscale" action on a clip at or below `shortSeconds`. */
  {
    config: 'upscaleVideo', run: 'upscaleVideo', key: 'upscale-video', label: 'video upscale',
    fields: { shortSeconds: { kind: 'number', min: 0 }, metaBatchNodeId: TEXT },
  },
  /**
   * The "upscale" action on a longer clip: a VHS meta-batch chain
   * (`VHS_BatchManager` + `VHS_LoadVideo` + `VHS_VideoCombine`) that ComfyUI
   * requeues once per block; only the last request writes the file.
   */
  { config: 'upscaleVideoLong', run: 'upscaleVideoLong', key: 'upscale-video-long', label: 'long video upscale', fields: {} },
  /**
   * «Rigenera dettaglio»: the Open-H3 refiner (NVlabs) on the source clip.
   *
   * The graph reads the clip with `LoadVideo`, raises its latent with a 3D
   * convolution (`MinimaxH3LatentUpscaler3D`) and redraws it in three Euler
   * steps: it is not an upscale, the model invents the detail. That is why
   * `sizeNodeId` is the node that declares the size to the sampler and
   * `upscaleNodeId` the one that must receive it as `mode.width`/`mode.height`
   * (the keys of its COMBO_DYNAMIC: with `width`/`height` the server answers
   * `required_input_missing`).
   */
  {
    config: 'regenerateDetail', run: 'regenerateDetail', key: 'regenerate-detail',
    label: 'regenerate detail', fields: {},
  },
  /** The "bg" action. */
  { config: 'removeBackground', run: 'removeBackground', key: 'background', label: 'background removal', fields: {} },
  /** Text-to-music: the "music" action. */
  {
    config: 'generateMusic', run: 'generateMusic', key: 'music', label: 'music generation',
    fields: { lyrics: PIN, duration: PIN },
  },
  /**
   * The voice changer behind the "voice" action: vocals out, RVC over them,
   * backing back in, all as nodes on the ComfyUI host. RVC on a whole mix
   * destroys the music, so the separation lives in the graph.
   */
  {
    config: 'changeVoice', run: 'changeVoice', key: 'voice', label: 'voice change',
    fields: { voice: PIN, pitch: PIN, voices: { kind: 'list' } },
  },
  /**
   * Isolates a track's vocal, which is what a singing clip listens to: a
   * full mix is mostly drums, bass and synths (measured on one segment: the
   * clip's own audio correlated -0.271 with its slice of the mix and +0.478
   * with the vocal alone). The mix is still what goes over the video.
   */
  { config: 'extractVocals', run: 'extractVocals', fields: {} },
] as const satisfies readonly {
  readonly config: string
  readonly run: string
  readonly key?: string
  readonly label?: string
  /** Only fields `WorkflowExtras` declares: a new one is typed there first. */
  readonly fields: { readonly [K in keyof WorkflowExtras]?: FieldSpec }
}[]

/** One row of {@link WORKFLOW_ROWS}. */
type WorkflowRow = typeof WORKFLOW_ROWS[number]

/**
 * The plugin configuration's `workflows`: per entry, the shared fields plus
 * the extras its row accepts, typed as `WorkflowExtras` documents them.
 */
export type WorkflowEntries = {
  readonly [R in WorkflowRow as R['config']]?: WorkflowConfig & Pick<WorkflowExtras, keyof R['fields'] & keyof WorkflowExtras>
}

/** The workflows Imagine can start, by the name the job runner knows each graph by. */
export type ImagineWorkflows = { [R in WorkflowRow as R['run']]?: LoadedWorkflow }

/**
 * The graphs, plus the high-quality ones, by the name of the run that uses
 * them (`video`, `loopVideo`, ...). An entry with `pathHigh` loads a second
 * one, with the same pins: «Velocita: Veloce» and «Qualita: Alta» pick the
 * graph instead of raising the steps, which buy no detail on distilled
 * weights.
 */
export type WorkflowGraphs = ImagineWorkflows & {
  readonly high?: Readonly<Record<string, LoadedWorkflow>>
}

/** One workflow entry name of the plugin configuration. */
type WorkflowConfigKey = typeof WORKFLOW_ROWS[number]['config']

/** The workflow entries the configuration accepts, in the order the page lists them. */
export const WORKFLOW_KEYS: readonly WorkflowConfigKey[] = WORKFLOW_ROWS.map(row => row.config)

/**
 * Fields an entry used to accept and nothing reads any more.
 *
 * A `config.yaml` passes them through at boot anyway (undeclared keys are
 * kept by the schema and dropped by the loader), but the settings file is
 * refused whole for one field it does not know: so an `imagine-settings.json`
 * written before the field went keeps loading, these are accepted there and
 * ignored, and the page may still remove them. Setting one is refused.
 */
export const RETIRED_WORKFLOW_FIELDS: ReadonlySet<string> = new Set([
  // The windowed object swap (2026-11-15), replaced by Openjutsu's chain graphs.
  'windowStart', 'sceneText', 'canvasMegapixels',
  // The long upscale's combine node: parsed, never read.
  'videoCombineNodeId',
])

/**
 * Every field any workflow entry accepts, with how it is written.
 *
 * The settings page validates against this union rather than per entry, as it
 * always has: a field the graph does not use is ignored at load.
 */
export const ALL_WORKFLOW_FIELDS: Readonly<Record<string, FieldSpec>> = Object.assign(
  {},
  BASE_FIELDS,
  ...WORKFLOW_ROWS.map(row => row.fields as Readonly<Record<string, FieldSpec>>),
) as Readonly<Record<string, FieldSpec>>

/**
 * The run values written as they are into the pin of the same meaning.
 *
 * `parameterize` writes each one when the run carries the value and the
 * workflow the pin; a workflow without the pin ignores the value, and a run
 * without it leaves the graph's own. These were a dozen identical `if` blocks
 * in `index.ts` until 2026-11-07. Values that need more than that — the
 * realism verdict (written both ways), the voice (a closed list), the pitch
 * (rounded), the lyrics (always written), the song slice (tied to the upload)
 * — stay explicit there.
 */
export const OPTION_PINS = [
  /*
   * The graph's selector derives its own canvas from the label. The host used
   * to stamp a fixed lookbook size into the first `ImageScale` it found as
   * well, which no configured graph with this pin carries any more and which
   * broke an H3 graph the one time it did (2026-10-15).
   */
  { option: 'aspectRatio', pin: 'aspectRatio' },
  { option: 'seconds', pin: 'seconds' },
  // A music graph takes the same length as its `max_duration`.
  { option: 'seconds', pin: 'duration' },
  /*
   * The texts of an object swap: the tracker phrase and what it becomes
   * (`object-swap-texts.ts`). The tracker phrase is a text conditioning rather
   * than a prompt, and a phrase the caller wrote from the clip is what makes
   * the tracker land on the thing meant.
   */
  { option: 'subjectText', pin: 'subjectText' },
  { option: 'referenceText', pin: 'referenceText' },
  /*
   * The box of «aggiungi un oggetto»: the graph wants it as a JSON string
   * (`H3ObjectPlacementMask.placement`), and the text arrives already
   * serialised from the job's plan, so its shape is checked in one place.
   */
  { option: 'placementText', pin: 'placementText' },
  // A character swap's lip-sync switch, written both ways so the graph's own default never decides.
  { option: 'noLipSync', pin: 'noLipSync' },
  // The resolution an Openjutsu plan renders at: «480p» on the composer's lower step.
  { option: 'planResolution', pin: 'planResolution' },
  { option: 'planJson', pin: 'planJson' },
  { option: 'runName', pin: 'runName' },
] as const satisfies readonly { readonly option: keyof RunOpts; readonly pin: keyof WorkflowExtras }[]
