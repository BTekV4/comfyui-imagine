/**
 * What the page and the host both know about each studio action, in one table.
 *
 * The page's runner (web action-traits.ts) and the host's request reader
 * (server job-request.ts) each kept their own per-action lists: which actions
 * read no prompt, which read a clip, which file kinds the host accepts, what
 * an unnamed run is called, what kind of file a run writes. Adding an action
 * meant writing it into all of them, and the `Set`s and `Partial<Record>`s
 * failed silently when one was forgotten. The table is typed
 * `Record<ImagineAction, …>`, so a new action does not build until it has a
 * row here.
 *
 * Only plain facts live here. The page's localized sentences (failed and done
 * lines) stay in action-traits.ts and the host's messages and graphs stay in
 * job-request.ts, because neither side can reach the other's code.
 *
 * The page and the host check the input at different points and do not agree
 * on every action, on purpose: `input` is what the page checks before a
 * request, `accepts` what the host checks when it reads one. They are two
 * fields so neither check changes.
 *
 * Shared, and so free of Node and of the DOM.
 * @module imagine-action-table
 */

import type { ImagineAction, MediaKind } from './imagine-types.ts'

/** One action's facts. */
export interface ActionFacts {
  /** The resolution ladder the run is rendered on: the photo steps or the clip steps (480p/720p). */
  readonly ladder: 'image' | 'video'
  /**
   * Page: the run can start with no words: its files, or a choice made in a
   * panel, say what to do. Without this flag an empty line is refused before
   * any request.
   */
  readonly promptOptional?: true
  /** Page: the word sent in place of an empty line. */
  readonly emptyLine?: string
  /**
   * Page: the line is only what the caller passed, never the composer's text:
   * a redo carries what should change in the shot, a resume changes nothing.
   */
  readonly ownLineOnly?: true
  /**
   * Page: the file the run reads, checked before the request:
   * - `image` / `video`: the source must be of that kind;
   * - `clip`: a video, and it is looked for by kind wherever it was given
   *   (the caller's source, the clicked tile, the staging), because these
   *   runs also stage a photo beside it.
   */
  readonly input?: 'image' | 'video' | 'clip'
  /**
   * Page: a second photo the run reads:
   * - `staged`: named by the caller or found in the staging by kind;
   * - `named`: only when the caller names one (an edit's reference).
   */
  readonly reference?: 'staged' | 'named'
  /**
   * Page: what a project still on a system-minted name is named from: the
   * input file (the run has no sentence of its own worth a title) or the
   * lyrics. The prompt otherwise.
   */
  readonly titleFrom?: 'input' | 'lyrics'
  /** Page: the staged files stay after the run, for the next variation of the same request. */
  readonly keepsStaging?: true
  /**
   * Host: the kinds of source file the request must name. Absent when the
   * host does not require a source. The messages for a missing or wrong file
   * are the host's (job-request.ts).
   */
  readonly accepts?: readonly MediaKind[]
  /**
   * Host: the name a run takes when nobody describes it (an upscale, a
   * cut-out, a voice change are named by their source).
   */
  readonly untitled?: string
  /**
   * Host: the kind of file the run writes, for the actions whose graph is
   * fixed by the action. Absent when the source decides (an upscale) or the
   * card does (a personal workflow).
   */
  readonly output?: 'image' | 'video' | 'audio'
}

const PHOTO: readonly MediaKind[] = ['image']
const CLIP: readonly MediaKind[] = ['video']

/** Every action's row. */
export const ACTION_TABLE: Readonly<Record<ImagineAction, ActionFacts>> = {
  generate: {
    ladder: 'image',
    keepsStaging: true,
    output: 'image',
  },
  remix: {
    ladder: 'image',
    input: 'image',
    // An edit's reference photo (Grok's «+»): only when the caller names one.
    reference: 'named',
    accepts: PHOTO,
    output: 'image',
  },
  video: {
    ladder: 'video',
    input: 'image',
    accepts: PHOTO,
    output: 'video',
  },
  loop: {
    ladder: 'video',
    input: 'image',
    accepts: PHOTO,
    output: 'video',
  },
  extend: {
    ladder: 'video',
    input: 'video',
    output: 'video',
  },
  upscale: {
    ladder: 'image',
    promptOptional: true,
    emptyLine: 'upscale',
    titleFrom: 'input',
    accepts: ['image', 'video'],
    untitled: 'upscale',
  },
  bg: {
    ladder: 'image',
    promptOptional: true,
    emptyLine: 'bg',
    input: 'image',
    titleFrom: 'input',
    accepts: PHOTO,
    untitled: 'bg',
    output: 'image',
  },
  music: {
    ladder: 'image',
    titleFrom: 'lyrics',
    // A song is often asked again with the same staged files.
    keepsStaging: true,
    output: 'audio',
  },
  story: {
    ladder: 'video',
  },
  voice: {
    ladder: 'image',
    /*
     * A clip is accepted beside a track: the run takes its soundtrack out
     * before the graph sees it.
     */
    accepts: ['audio', 'video'],
    untitled: 'voice',
    output: 'audio',
  },
  speak: {
    ladder: 'image',
  },
  redo: {
    ladder: 'video',
    promptOptional: true,
    ownLineOnly: true,
    input: 'video',
  },
  resume: {
    ladder: 'video',
    promptOptional: true,
    ownLineOnly: true,
    input: 'video',
  },
  scanFrame: {
    ladder: 'video',
    promptOptional: true,
    input: 'clip',
    accepts: CLIP,
    output: 'image',
  },
  recreate: {
    ladder: 'video',
    promptOptional: true,
    input: 'clip',
    titleFrom: 'input',
    accepts: CLIP,
    output: 'video',
  },
  regenerate: {
    ladder: 'video',
    // With no line the studio reuses the prompt the clip was made with, so an
    // empty field is the normal case.
    promptOptional: true,
    input: 'clip',
    titleFrom: 'input',
    accepts: CLIP,
    output: 'video',
  },
  compose: {
    ladder: 'image',
    // Its page check (two different photos) is its own, in the runner.
    reference: 'staged',
    accepts: PHOTO,
    output: 'image',
  },
  objectSwap: {
    ladder: 'video',
    input: 'clip',
    reference: 'staged',
    titleFrom: 'input',
    accepts: CLIP,
    output: 'video',
  },
  swapPerson: {
    ladder: 'video',
    input: 'clip',
    reference: 'staged',
    titleFrom: 'input',
    accepts: CLIP,
    untitled: 'character swap',
    output: 'video',
  },
  relight: {
    ladder: 'image',
    // The text is the chosen look, not a sentence from the user.
    promptOptional: true,
    input: 'image',
    titleFrom: 'input',
    accepts: PHOTO,
    output: 'image',
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
 * The kind of file an action's input must be on the page, or undefined when
 * the runner does not check it before the request.
 * @param action - the action.
 * @returns `image`, `video`, or undefined.
 */
export function inputKindOf(action: ImagineAction): 'image' | 'video' | undefined {
  const input = ACTION_TABLE[action].input
  return input === 'clip' ? 'video' : input
}

/**
 * The kind of file an action with a fixed graph writes, for the host's
 * per-action run table.
 * @param action - the action.
 * @returns the output kind; throws when the row has none, so a server table
 *   that names an action without a fixed output fails at load, not at run.
 */
export function outputKindOf(action: ImagineAction): 'image' | 'video' | 'audio' {
  const output = ACTION_TABLE[action].output
  if (output === undefined) throw new Error(`action ${action} has no fixed output kind`)
  return output
}
