/**
 * The HTTP contract between the Imagine server and the studio page: types and
 * the one list of studio actions, no imports, read by both sides.
 *
 * Until 2026-10-20 the page re-declared each of these by hand beside the
 * server's own, and a field added on one side went missing on the other
 * without a type error to say so.
 */

/** The kinds of media the gallery lists. */
export const MEDIA_KINDS = ['image', 'video', 'audio'] as const

/** One kind of gallery media. */
export type MediaKind = typeof MEDIA_KINDS[number]

/** A gallery file by name and kind, as messages and jobs carry it. */
export interface MediaFileRef {
  readonly name: string
  readonly kind: MediaKind
}

/** A provider/model pair, as the host routes a model call. */
export interface ModelRoute {
  readonly provider: string
  readonly model: string
}

/** One model the host can route to (GET /api/models, the host settings). */
export interface ModelEntry {
  readonly provider: string
  readonly id: string
  readonly name?: string
}

/** One tag of «Tutti i media» (GET/POST /api/tags). */
export interface MediaTag {
  readonly id: string
  readonly name: string
  /** Files in the tag, the last added first. */
  readonly names: readonly string[]
}

/**
 * Which studio tool produced a gallery file, read off its declared name.
 *
 * One member per prefix the producers write: the eight tool calls, the
 * studio's own chained actions, the spoken line, and the music video's files —
 * its shots and its cut are named `videoclip-…` rather than after a tool.
 */
export type GalleryTool =
  | 'generate_image' | 'edit_image' | 'create_video' | 'upscale_image' | 'upscale_video'
  | 'remove_background' | 'generate_music' | 'generate_lookbook'
  | 'animated_background' | 'extend_video' | 'change_voice' | 'speak_text' | 'videoclip'
  | 'recreate_video' | 'regenerate_detail' | 'object_swap' | 'swap_person' | 'relight'

/** One produced media file the Imagine page can render (GET /comfy-media). */
export interface GalleryItem {
  readonly name: string
  readonly kind: MediaKind
  readonly size: number
  readonly mtime: number
  readonly width?: number
  readonly height?: number
  /** Clip length in seconds, read from the MP4/MOV `mvhd` box; absent for other containers. */
  readonly duration?: number
  readonly tool?: GalleryTool
}

/** One edit the settings page asks for, addressed by path from the file's root. */
export type ImagineSettingOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

/**
 * Every Imagine studio action, as the job API spells it.
 *
 * The one list: the type, the request guard in `index.ts`, the chat's
 * accepted actions and the page's type are all read off it (2026-10-20).
 * Before, a new action had to be added in four places, and a miss in the
 * chat's copy dropped the run without a word.
 */
export const IMAGINE_ACTIONS = [
  'generate', 'remix', 'video', 'loop', 'extend', 'upscale', 'bg', 'music', 'story', 'voice',
  'speak', 'redo', 'resume', 'scanFrame', 'recreate',
  'regenerate', 'compose', 'objectSwap', 'swapPerson', 'relight', 'custom',
] as const

/** One Imagine studio action. */
export type ImagineAction = typeof IMAGINE_ACTIONS[number]

/**
 * The speeds a clip can be rendered at, as the composer's «Velocità» pill
 * shows them (2026-11-03).
 *
 * `fast` is the graph as it ships, distilled to the few steps its LoRA was
 * trained at (the Pika recipe at four steps since 2026-11-05). `slow` is the
 * high-quality half: the second graph the workflow declares as `pathHigh`
 * (the official six-step Pika graph), and a workflow without one falls back to
 * its own `steps.high`, the higher count it was saved with.
 *
 * The old recipe that swapped in the base weights and sampled at 24 steps is
 * gone for good (removed 2026-10-29: 26,8 minutes per five-second window
 * against 10,5): a body asking for `high` is still refused by name
 * (`invalidChoiceReason`), because that word meant those weights.
 */
export const IMAGINE_SPEEDS = ['fast', 'slow'] as const

/** One speed setting. */
export type ImagineSpeed = typeof IMAGINE_SPEEDS[number]

/**
 * The image recipe the composer's «Qualità» pill chooses: the graph as it
 * ships (`standard`), or the same graph at the higher step count each
 * workflow declares as `steps.high` (Krea 2 draws at sixteen instead of ten).
 *
 * It is the same mechanism as `speed`, on the other kind of media: a workflow
 * with no `steps` pin ignores both.
 */
export const IMAGINE_QUALITIES = ['standard', 'high'] as const

/** One image quality setting. */
export type ImagineQuality = typeof IMAGINE_QUALITIES[number]

/**
 * What an object swap does with the thing it tracks in the clip (2026-11-06).
 *
 * One action, four recipes, because they are one gesture with four answers:
 * `change` puts in the object of the photo, `remove` takes the tracked object
 * out of the shot, `background` replaces the setting around the tracked
 * subject keeping their look and performance, `add` introduces an object that
 * was not there. The texts the graph is given are written per mode
 * (`object-swap-texts.ts`), not by swapping a word in one template.
 *
 * Only `change` needs a photo: the other three are described by the line the
 * user writes (what has to disappear, or what the place becomes).
 */
export const IMAGINE_OBJECT_MODES = ['change', 'remove', 'background', 'add'] as const

/** One object swap recipe. */
export type ImagineObjectMode = typeof IMAGINE_OBJECT_MODES[number]

/**
 * The box a new object goes into, for the `add` mode of an object swap.
 *
 * Normalised to the frame: `x` and `y` are the top-left corner as a share of
 * the width and height, `width` and `height` its size, all between 0 and 1.
 * One box holds for the whole clip, which is what the graph's placement node
 * does with a single keyframe. Absent, the studio puts the box in the middle
 * of the frame, so `add` runs from the chat as well as from the panel.
 */
export interface ImaginePlacement {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The box `add` uses when the request names none: the middle of the frame. */
export const DEFAULT_OBJECT_PLACEMENT: ImaginePlacement = { x: 0.35, y: 0.45, width: 0.3, height: 0.3 }

/**
 * The edits the host makes itself, without ComfyUI (`server/src`): filed as a
 * file's origin beside the studio actions, never queued as a job.
 */
export type HostEdit = 'trim' | 'merge' | 'crop' | 'duplicate' | 'erase' | 'frame'

/** A rectangle on a photo, in fractions of its width and height (0–1). */
export interface ImagineRegion {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * The smallest side of a region, as a fraction of the photo's: a zone thinner
 * than 2% is a stray click, not an edit. One number for the server, which
 * clamps a region and drops one under it, and the MCP, which refuses it with
 * a reason before queueing anything.
 */
export const MIN_REGION_SIDE = 0.02

/** Job states the studio page polls. */
export type ImagineJobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

/** Live denoising progress attached to a live Imagine job. */
export interface ImagineJobProgress {
  /**
   * Completion percentage (0..100) of the whole run: every pass that reports
   * progress, weighted by its steps, never going backwards. It used to be the
   * current sampler's percentage, which restarted at zero on the second pass
   * of a graph that has more than one.
   */
  readonly percent?: number
  /** Sampler step reached, for the pass that is running now. */
  readonly step?: number
  /** Sampler total steps, for the pass that is running now. */
  readonly maxSteps?: number
  /** The class type of the node currently executing. */
  readonly nodeClass?: string
  /** The latest denoising preview frame as a JPEG/PNG data URL. */
  readonly preview?: string
  /** Seconds left at the pace the run is going, when one can be measured. */
  readonly etaSeconds?: number
  /** Seconds since the prompt was submitted. */
  readonly elapsedSeconds?: number
}

/**
 * What ComfyUI is missing for a job, as comfyui-imagine's setup reported it:
 * the node packs to install and the model files to download.
 */
/** A node pack the install would add, and where it comes from. */
export interface ImagineSetupPack {
  readonly id: string
  readonly name: string
  /** `registry`: the Comfy Registry's zip; `github`: a pinned commit of a pack the registry does not carry. */
  readonly source: 'registry' | 'github'
  /** What the registry says of the pinned version (`Active`, `Flagged`…), when it answered. */
  readonly registryStatus?: string
}

/** True when a pack is not a plain, active registry entry: the user is always asked first. */
export function setupPackUnverified(pack: ImagineSetupPack): boolean {
  return pack.source !== 'registry' || pack.registryStatus !== 'Active'
}

export interface ImagineSetupPlan {
  readonly packs: readonly ImagineSetupPack[]
  readonly models: readonly {
    readonly name: string
    readonly folder: string
    readonly size: number
    /** The Hugging Face page whose licence has to be accepted before the download (a gated repo). */
    readonly gated?: string
  }[]
  /** Bytes to download in all. */
  readonly bytes: number
}

/** The fields of an Imagine job the page reads; the server's job carries more. */
export interface ImagineJobFields {
  readonly id: string
  readonly action: ImagineAction
  readonly prompt: string
  readonly status: ImagineJobStatus
  readonly createdAt: number
  readonly source?: string
  /**
   * The second photo, when the run has one: the object of an object swap, or
   * the reference of «Componi con riferimenti».
   */
  readonly reference?: string
  /** `custom` only: the uploaded workflow this job runs. */
  readonly customWorkflowId?: string
  /** `custom` only: the card's own controls, keyed `<node>.<field>`. */
  readonly customFields?: Readonly<Record<string, unknown>>
  /**
   * `relight` only: which of the seventeen light looks the run paints
   * (`shared/relight-looks.ts`). Absent is the recipe's first look.
   */
  readonly light?: string
  /**
   * The opening frame of a recreation, once the run has one: drawn by the run
   * itself, or one of the candidates a «Ricrea video» scan left on the board.
   *
   * The page reads it to know which candidate was already used, so the block
   * that offers them can say so instead of looking untouched.
   */
  readonly frame?: string
  /**
   * `objectSwap` only: what the run does with the thing it tracks in the clip.
   *
   * Absent on every other action, and absent on an object swap means `change`
   * — the recipe with the photo. Kept on the job so a retry, the tile and the
   * file's own note all say which of the four was asked for.
   */
  readonly objectMode?: ImagineObjectMode
  /**
   * `objectSwap` only, `add` mode: where the new object goes, as a share of
   * the frame. Absent means the box in the middle of the frame, which is what
   * the chat's own runs use.
   */
  readonly placement?: ImaginePlacement
  readonly size?: string
  readonly aspectRatio?: string
  readonly seconds?: number
  readonly megapixels?: number
  /** How the clip was rendered: the fast recipe or the slow one. */
  readonly speed?: ImagineSpeed
  /** How a photo was drawn: the graph's own steps or the high recipe. */
  readonly quality?: ImagineQuality
  readonly error?: string
  readonly files?: readonly MediaFileRef[]
  /**
   * What ComfyUI has to install before this job can run, while the job waits
   * for the user's yes (notice `setup-needed`) or installs it
   * (`setup-running`, with `setupProgress`).
   */
  readonly setup?: ImagineSetupPlan
  /** The install in progress: the file being downloaded (or `restart`), how far, how long left. */
  readonly setupProgress?: { readonly stage: string; readonly percent: number; readonly etaSeconds?: number }
  readonly lyrics?: string
  /**
   * The prompt the vision pass wrote from the source image, when it ran: H3
   * form for a clip, a grounded instruction for an edit.
   * Kept beside `prompt` rather than replacing it so the studio can still show
   * what the user asked for next to what the sampler was actually given.
   */
  readonly writtenPrompt?: string
  /** The ComfyUI prompt id, once the workflow has been submitted. */
  readonly promptId?: string
  /**
   * A machine-readable thing that happened mid-run and that the studio says
   * out loud — `comfy-restart` when ComfyUI was restarted under the job,
   * `chain-broken`, `lipsync-retry`, `montage-failed` and the rest set by
   * `setJobNotice` in the job runner. The page owns the wording.
   */
  readonly notice?: string
  /**
   * How far a «Ricrea video» scan has got with its candidate frames.
   *
   * A scan draws a set — several renders, each with its own percentage — so the
   * column counts the set off ("fotogramma 3 di 4") instead of following a
   * bar that restarts from zero ten times and reads as a studio looping.
   */
  readonly scanProgress?: { readonly done: number; readonly total: number }
  /** Groups batch jobs started from a single user request. */
  readonly batchId?: string
  /** Index within the batch (0-based). */
  readonly batchIndex?: number
  /** A track to lay over the finished video, replacing the generated audio. */
  readonly song?: string
  /** Groups the clips of one long video. */
  readonly storyId?: string
  /**
   * Which shot of the story this job renders, from 0. Absent on the job that
   * generates the opening frame, which is not a shot.
   */
  readonly storyIndex?: number
  /** How many shots the story has, for the studio to count them off. */
  readonly storyCount?: number
  /**
   * The music video this job belongs to, when it is a stage of one.
   *
   * A music video is queued in three waves — the photos, the song, and the
   * montage the chain starts once those have names — so the studio cannot know
   * every job at the moment it asks. This is the thread they share: the page
   * adopts each wave into the project as it appears, which is also what keeps
   * its progress poll alive, since that only runs while a job the project owns
   * is live.
   */
  readonly clipId?: string
}

/** One in-flight or finished Imagine job as GET /comfy-imagine/jobs sends it. */
export interface ImagineJobView extends ImagineJobFields {
  /** Live progress while the job is queued or running. */
  readonly progress?: ImagineJobProgress
}

/** What the studio's music-video form sends (POST /comfy-imagine/clip). */
export interface MusicClipRequest {
  /** The lookbook entry every photo is generated from. */
  readonly look: string
  /** The song's genre and production, in the user's words. */
  readonly genre: string
  /** Which voice sings it. */
  readonly voice: 'female' | 'male'
  /** The words to sing; empty makes an instrumental. */
  readonly lyrics: string
  /** How long the finished video runs; the host reads it off the words when absent. */
  readonly seconds?: number
  /** Aspect and resolution, as the composer would have sent them. */
  readonly aspectRatio?: string
  readonly size?: string
  /** The model the composer's chip is showing. */
  readonly model?: ModelRoute
  /**
   * The project the video belongs to, when the studio has one.
   *
   * Every wave is recorded into it by the host, so a page reload between the
   * waves — or a second browser — still finds the song and the shots on that
   * board, instead of only in the history.
   */
  readonly projectId?: string
}

/** What the host answers a music video with: the jobs to watch, in the order they run. */
export interface MusicClipPlan {
  /**
   * The thread every stage of this video carries, the montage included.
   *
   * The montage does not exist yet when this answers, so the studio adopts the
   * clips by this rather than by id.
   */
  readonly clipId: string
  /** The photo jobs, one per shot. */
  readonly photos: readonly string[]
  /** The song job. */
  readonly song: string
  /** How many shots the montage will have. */
  readonly shots: number
  /** The finished video's length in seconds. */
  readonly seconds: number
}
