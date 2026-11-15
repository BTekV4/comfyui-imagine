/**
 * The cards of "New generation": what each one is called, the line under
 * it, its cover and the composer mode its panel opens in.
 *
 * Kept beside `WORKFLOW_SPECS` rather than inside it: the cards speak through
 * the locale keys and the panels in plain Italian, and the two read
 * differently on purpose (a card says "Generate", its panel explains what to
 * write). Every card has a spec; `JobCardId` is the key they share.
 * @module job-cards
 */

import type { GalleryItem } from '../../../shared/imagine-types.ts'
import type { ImagineMode } from './imagine-settings.ts'
import type { WorkflowSpec } from './workflow-specs.ts'

export const JOB_CARDS = [
  { id: 'generate', title: 'imagine.generate', hint: 'imagine.actionGenerateHint', cover: '/imagine/generate.webp' },
  { id: 'remix', title: 'imagine.remix', hint: 'imagine.actionRemixHint', cover: '/imagine/edit.webp' },
  { id: 'style', title: 'imagine.changeStyle', hint: 'imagine.actionStyleHint', cover: '/imagine/style.webp' },
  { id: 'video', title: 'imagine.makeVideo', hint: 'imagine.actionVideoHint', cover: '/imagine/video.webp' },
  /*
   * The two new cards have home-made covers from our own renders: for
   * "Object swap" a before/after diptych of the same frame (the blue dress
   * turning black), for "Light the photo" the same portrait in the sun and
   * under red and blue gels. Before, they reused another card's cover and a
   * looks thumbnail, so on the home page they were indistinguishable
   * (2026-11-06).
   */
  { id: 'objectSwap', title: 'imagine.objectSwap', hint: 'imagine.actionObjectSwapHint', cover: '/imagine/objectSwap.webp' },
  { id: 'relight', title: 'imagine.relight', hint: 'imagine.actionRelightHint', cover: '/imagine/relight.webp' },
  { id: 'recreate', title: 'imagine.recreateVideo', hint: 'imagine.actionRecreateHint', cover: '/imagine/recreate.webp' },
  { id: 'regenerate', title: 'imagine.regenerateDetail', hint: 'imagine.actionRegenerateHint', cover: '/imagine/regenerate-detail.webp' },
  { id: 'compose', title: 'imagine.compose', hint: 'imagine.actionComposeHint', cover: '/imagine/compose.webp' },
  { id: 'loop', title: 'imagine.makeLoop', hint: 'imagine.actionLoopHint', cover: '/imagine/loop.webp' },
  { id: 'bg', title: 'imagine.bgRemoval', hint: 'imagine.actionBgHint', cover: '/imagine/bg.webp' },
  { id: 'frames', title: 'imagine.extractFrames', hint: 'imagine.actionFramesHint', cover: '/imagine/frames.webp' },
  { id: 'upscale', title: 'imagine.upscale', hint: 'imagine.actionUpscaleHint', cover: '/imagine/upscale.webp' },
  { id: 'music', title: 'imagine.makeMusic', hint: 'imagine.actionMusicHint', cover: '/imagine/music.webp' },
  { id: 'voice', title: 'imagine.changeVoice', hint: 'imagine.actionVoiceHint', cover: '/imagine/voce.webp' },
  { id: 'tts', title: 'imagine.makeSpeech', hint: 'imagine.actionSpeechHint', cover: '/imagine/tts.webp' },
  { id: 'clip', title: 'imagine.makeClip', hint: 'imagine.actionClipHint', cover: '/imagine/clip.webp' },
] as const

/**
 * The cards that move: the animated file that covers them (2026-11-02).
 *
 * Covers are stills drawn at 275 px; where motion IS the action — a video, a
 * loop, an object swap, a recreated clip — next to the cover there is a short
 * clip the card plays muted and looped, with the cover as poster. The others
 * stay still: in a still there is nothing to animate.
 */
export const CARD_MOTION: Partial<Record<JobCardId, string>> = {
  video: '/imagine/video',
  loop: '/imagine/loop',
  objectSwap: '/imagine/objectSwap',
  relight: '/imagine/relight',
  recreate: '/imagine/recreate',
}

/** One card of the home's grid. */
export type JobCardId = (typeof JOB_CARDS)[number]['id']

/**
 * The composer mode each card's panel opens in.
 *
 * A card used to go through a chain of branches (`startJobCard`) that also
 * checked the staged files and set notes; the panel opens with nothing
 * staged and clears the note, so every one of those checks was undone in the
 * same batch, and four of the branches (background removal, upscale, voice,
 * clip) could never be reached. What is left is the mode.
 */
export const CARD_MODE: Readonly<Record<JobCardId, ImagineMode>> = {
  generate: 'image',
  remix: 'image',
  style: 'style',
  video: 'video',
  objectSwap: 'image',
  relight: 'image',
  recreate: 'recreate',
  regenerate: 'regenerate',
  compose: 'image',
  loop: 'loop',
  bg: 'image',
  frames: 'image',
  upscale: 'image',
  music: 'music',
  voice: 'image',
  tts: 'speak',
  clip: 'video',
}

/**
 * The staged files as a panel's slots: each slot takes the first staged file
 * of a kind it accepts that no earlier slot took. The files stay in the
 * composer's `sources`, which every run already reads; the slots are a view.
 * @param spec - the panel's workflow.
 * @param list - the staged files.
 * @returns the file in each slot, by its key.
 */
export function slotsOf(spec: WorkflowSpec, list: readonly GalleryItem[]): Record<string, GalleryItem | undefined> {
  const taken = new Set<string>()
  const out: Record<string, GalleryItem | undefined> = {}
  for (const slot of spec.slots) {
    const match = list.find(item => !taken.has(item.name) && slot.kinds.includes(item.kind))
    if (match !== undefined) taken.add(match.name)
    out[slot.key] = match
  }
  return out
}
