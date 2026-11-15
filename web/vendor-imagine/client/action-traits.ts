/**
 * What the page knows about each studio action, in one table.
 *
 * Until 2026-11-15 the same facts lived in seven hand-kept lists across
 * use-runner.ts and imagine-messages.ts (which actions read no prompt, which
 * read a clip, which render on the video ladder, the line a failure or a
 * finished run leaves…), most of them `Set`s or `Partial<Record>`s the
 * compiler could not check.
 *
 * The plain facts (ladder, prompt, input, reference, title, staging) now live
 * in `shared/imagine-action-table.ts`, which the host reads too. This module
 * adds the page's own sentences, which need the page's locale keys, and joins
 * the two into one row per action. Both tables are typed
 * `Record<ImagineAction, …>`, so a new action does not build until it has a
 * row in each.
 * @module action-traits
 */

import { IMAGINE_ACTIONS, type ImagineAction } from '../../../shared/imagine-types.ts'
import { ACTION_TABLE, type ActionFacts } from '../../../shared/imagine-action-table.ts'
import type { ComfyLocaleKey } from './locales.ts'

export { inputKindOf } from '../../../shared/imagine-action-table.ts'

/** One action's behaviour on the page: the shared facts and the column's sentences. */
export interface ActionTraits extends ActionFacts, ActionSentences {}

/** The column's sentences for one action. */
interface ActionSentences {
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

/** Every action's sentences. */
const ACTION_SENTENCES: Readonly<Record<ImagineAction, ActionSentences>> = {
  generate: { failedKey: 'imagine.failedGenerate' },
  remix: { failedKey: 'imagine.failedRemix', doneKeys: ['imagine.doneRemixOne', 'imagine.doneRemix'] },
  video: { failedKey: 'imagine.failedVideo', doneKeys: VIDEO_DONE },
  loop: { failedKey: 'imagine.failedLoop', doneKeys: ['imagine.doneLoopOne', 'imagine.doneLoop'] },
  extend: { failedKey: 'imagine.failedExtend', doneKeys: ['imagine.doneExtendOne', 'imagine.doneVideo'] },
  upscale: { failedKey: 'imagine.failedUpscale', doneKeys: ['imagine.doneUpscaleOne', 'imagine.doneUpscale'] },
  bg: { failedKey: 'imagine.failedBg', doneKeys: ['imagine.doneBgOne', 'imagine.doneBg'] },
  music: { failedKey: 'imagine.failedMusic', doneKeys: ['imagine.doneMusicOne', 'imagine.doneMusic'] },
  story: { failedKey: 'imagine.failedVideo', doneKeys: VIDEO_DONE },
  voice: { failedKey: 'imagine.failedVoice' },
  speak: { failedKey: 'imagine.failedSpeak', doneKeys: ['imagine.doneSpeakOne', 'imagine.doneSpeak'] },
  redo: { failedKey: 'imagine.failedVideo', doneKeys: VIDEO_DONE },
  resume: { failedKey: 'imagine.failedVideo', doneKeys: VIDEO_DONE },
  scanFrame: { doneKeys: ['imagine.doneScanFrameOne', 'imagine.doneScanFrame'] },
  recreate: {},
  regenerate: {},
  compose: {},
  objectSwap: { failedKey: 'imagine.failedObjectSwap', doneKeys: ['imagine.doneObjectSwapOne', 'imagine.doneObjectSwap'] },
  swapPerson: { failedKey: 'imagine.failedSwapPerson', doneKeys: ['imagine.doneSwapPersonOne', 'imagine.doneSwapPerson'] },
  relight: { failedKey: 'imagine.failedRelight', doneKeys: ['imagine.doneRelightOne', 'imagine.doneRelight'] },
  custom: {},
}

/** Every action's row: the shared facts and the page's sentences. */
export const ACTION_TRAITS: Readonly<Record<ImagineAction, ActionTraits>> = Object.fromEntries(
  IMAGINE_ACTIONS.map(action => [action, { ...ACTION_TABLE[action], ...ACTION_SENTENCES[action] }]),
) as Record<ImagineAction, ActionTraits>
