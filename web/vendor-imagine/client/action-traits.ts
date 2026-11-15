/**
 * What the page knows about each studio action, in one table.
 *
 * Until 2026-11-15 the same facts lived in seven hand-kept lists across
 * use-runner.ts and imagine-messages.ts (which actions read no prompt, which
 * read a clip, which render on the video ladder, the line a failure or a
 * finished run leaves…), most of them `Set`s or `Partial<Record>`s the
 * compiler could not check. The last three actions added (objectSwap,
 * swapPerson, relight) each had to be written into all of them. The table is
 * typed `Record<ImagineAction, …>`, so a new action does not build until it
 * has a row here, and every list the runner and the messages read is derived
 * from it.
 *
 * The host keeps its own per-action tables (job-request.ts: the graph, the
 * output kind, the input kinds with their messages). They are not imported
 * here because the client cannot reach server code; moving the shared part
 * into `shared/` is the next step.
 * @module action-traits
 */

import type { ImagineAction } from '../../../shared/imagine-types.ts'
import type { ComfyLocaleKey } from './locales.ts'

/** One action's behaviour on the page. */
export interface ActionTraits {
  /** The resolution ladder the run is rendered on: the photo steps or the clip steps (480p/720p). */
  readonly ladder: 'image' | 'video'
  /**
   * The run can start with no words: its files, or a choice made in a panel,
   * say what to do. Without this flag an empty line is refused before any
   * request.
   */
  readonly promptOptional?: true
  /** The word sent in place of an empty line. */
  readonly emptyLine?: string
  /**
   * The line is only what the caller passed, never the composer's text: a
   * redo carries what should change in the shot, a resume changes nothing.
   */
  readonly ownLineOnly?: true
  /**
   * The file the run reads, checked before the request:
   * - `image` / `video`: the source must be of that kind;
   * - `clip`: a video, and it is looked for by kind wherever it was given
   *   (the caller's source, the clicked tile, the staging), because these
   *   runs also stage a photo beside it.
   */
  readonly input?: 'image' | 'video' | 'clip'
  /**
   * A second photo the run reads:
   * - `staged`: named by the caller or found in the staging by kind;
   * - `named`: only when the caller names one (an edit's reference).
   */
  readonly reference?: 'staged' | 'named'
  /**
   * What a project still on a system-minted name is named from: the input
   * file (the run has no sentence of its own worth a title) or the lyrics.
   * The prompt otherwise.
   */
  readonly titleFrom?: 'input' | 'lyrics'
  /** The staged files stay after the run, for the next variation of the same request. */
  readonly keepsStaging?: true
  /**
   * The column's word for what did not happen, when a run of this action
   * failed; a generic one otherwise.
   *
   * A failure used to reach the chat as the reason alone — "workflow has no
   * LoadVideo node for the input video" under a request for a song — and the
   * studio's own reader, given these lines and nothing else, answered the next
   * question by inventing which run had failed (2026-09-09).
   */
  readonly failedKey?: ComfyLocaleKey
  /**
   * The column's sentence for a finished run: one file, then several.
   *
   * Without its own sentence an action falls through to "I generated one
   * image.": a clip, a continued clip and a spoken line all came back
   * announced as a picture, and that line became the project's title
   * (2026-10-17). The scan half of "Recreate video" says the recreation has
   * NOT happened yet, or the frames under a sentence about a video read as
   * the video having gone missing.
   */
  readonly doneKeys?: readonly [one: ComfyLocaleKey, many: ComfyLocaleKey]
}

const VIDEO_DONE = ['imagine.doneVideoOne', 'imagine.doneVideo'] as const

/** Every action's row. */
export const ACTION_TRAITS: Readonly<Record<ImagineAction, ActionTraits>> = {
  generate: {
    ladder: 'image',
    keepsStaging: true,
    failedKey: 'imagine.failedGenerate',
  },
  remix: {
    ladder: 'image',
    input: 'image',
    // An edit's reference photo (Grok's «+»): only when the caller names one.
    reference: 'named',
    failedKey: 'imagine.failedRemix',
    doneKeys: ['imagine.doneRemixOne', 'imagine.doneRemix'],
  },
  video: {
    ladder: 'video',
    input: 'image',
    failedKey: 'imagine.failedVideo',
    doneKeys: VIDEO_DONE,
  },
  loop: {
    ladder: 'video',
    input: 'image',
    failedKey: 'imagine.failedLoop',
    doneKeys: ['imagine.doneLoopOne', 'imagine.doneLoop'],
  },
  extend: {
    ladder: 'video',
    input: 'video',
    failedKey: 'imagine.failedExtend',
    doneKeys: ['imagine.doneExtendOne', 'imagine.doneVideo'],
  },
  upscale: {
    ladder: 'image',
    promptOptional: true,
    emptyLine: 'upscale',
    titleFrom: 'input',
    failedKey: 'imagine.failedUpscale',
    doneKeys: ['imagine.doneUpscaleOne', 'imagine.doneUpscale'],
  },
  bg: {
    ladder: 'image',
    promptOptional: true,
    emptyLine: 'bg',
    input: 'image',
    titleFrom: 'input',
    failedKey: 'imagine.failedBg',
    doneKeys: ['imagine.doneBgOne', 'imagine.doneBg'],
  },
  music: {
    ladder: 'image',
    titleFrom: 'lyrics',
    // A song is often asked again with the same staged files.
    keepsStaging: true,
    failedKey: 'imagine.failedMusic',
    doneKeys: ['imagine.doneMusicOne', 'imagine.doneMusic'],
  },
  story: {
    ladder: 'video',
    failedKey: 'imagine.failedVideo',
    doneKeys: VIDEO_DONE,
  },
  voice: {
    ladder: 'image',
    failedKey: 'imagine.failedVoice',
  },
  speak: {
    ladder: 'image',
    failedKey: 'imagine.failedSpeak',
    doneKeys: ['imagine.doneSpeakOne', 'imagine.doneSpeak'],
  },
  redo: {
    ladder: 'video',
    promptOptional: true,
    ownLineOnly: true,
    input: 'video',
    failedKey: 'imagine.failedVideo',
    doneKeys: VIDEO_DONE,
  },
  resume: {
    ladder: 'video',
    promptOptional: true,
    ownLineOnly: true,
    input: 'video',
    failedKey: 'imagine.failedVideo',
    doneKeys: VIDEO_DONE,
  },
  scanFrame: {
    ladder: 'video',
    promptOptional: true,
    input: 'clip',
    doneKeys: ['imagine.doneScanFrameOne', 'imagine.doneScanFrame'],
  },
  recreate: {
    ladder: 'video',
    promptOptional: true,
    input: 'clip',
    titleFrom: 'input',
  },
  regenerate: {
    ladder: 'video',
    // With no line the studio reuses the prompt the clip was made with, so an
    // empty field is the normal case.
    promptOptional: true,
    input: 'clip',
    titleFrom: 'input',
  },
  compose: {
    ladder: 'image',
    // Its input check (two different photos) is its own, in the runner.
    reference: 'staged',
  },
  objectSwap: {
    ladder: 'video',
    input: 'clip',
    reference: 'staged',
    titleFrom: 'input',
    failedKey: 'imagine.failedObjectSwap',
    doneKeys: ['imagine.doneObjectSwapOne', 'imagine.doneObjectSwap'],
  },
  swapPerson: {
    ladder: 'video',
    input: 'clip',
    reference: 'staged',
    titleFrom: 'input',
    failedKey: 'imagine.failedSwapPerson',
    doneKeys: ['imagine.doneSwapPersonOne', 'imagine.doneSwapPerson'],
  },
  relight: {
    ladder: 'image',
    // The text is the chosen look, not a sentence from the user.
    promptOptional: true,
    input: 'image',
    titleFrom: 'input',
    failedKey: 'imagine.failedRelight',
    doneKeys: ['imagine.doneRelightOne', 'imagine.doneRelight'],
  },
  custom: {
    ladder: 'image',
    /*
     * An uploaded card can have its own controls instead of the sentence (the
     * lookbook: title and pose from the catalogue): the panel already knows
     * whether something is missing, and the host accepts the job with no text.
     */
    promptOptional: true,
  },
}

/**
 * The kind of file an action's input must be, or undefined when the runner
 * does not check it before the request.
 * @param action - the action.
 * @returns `image`, `video`, or undefined.
 */
export function inputKindOf(action: ImagineAction): 'image' | 'video' | undefined {
  const input = ACTION_TRAITS[action].input
  return input === 'clip' ? 'video' : input
}
