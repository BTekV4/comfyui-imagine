/**
 * The cards of "New generation": their order, their cover and the composer
 * mode each panel opens in.
 *
 * What a card is called and the line under it are its panel's (`titleKey`,
 * `summaryKey` in workflow-specs.ts): the two had been written out twice, one
 * locale key apiece, and agreed on every card (checked 2026-11-15). Every card
 * has a spec; `JobCardId` is the key they share.
 * @module job-cards
 */

import type { GalleryItem } from '../../../shared/imagine-types.ts'
import type { ImagineMode } from './imagine-settings.ts'
import { WORKFLOW_SPECS, type WorkflowCardId, type WorkflowSpec } from './workflow-specs.ts'

/** Each card's id and cover, in the order the home shows them. */
const CARD_COVERS = [
  { id: 'generate', cover: '/imagine/generate.webp' },
  { id: 'remix', cover: '/imagine/edit.webp' },
  { id: 'style', cover: '/imagine/style.webp' },
  { id: 'video', cover: '/imagine/video.webp' },
  /*
   * The two new cards have home-made covers from our own renders: for
   * "Object swap" a before/after diptych of the same frame (the blue dress
   * turning black), for "Light the photo" the same portrait in the sun and
   * under red and blue gels. Before, they reused another card's cover and a
   * looks thumbnail, so on the home page they were indistinguishable
   * (2026-11-06).
   */
  { id: 'objectSwap', cover: '/imagine/objectSwap.webp' },
  // Its cover is our own render of two invented people (2026-11-15).
  { id: 'swapPerson', cover: '/imagine/swapPerson.webp' },
  { id: 'relight', cover: '/imagine/relight.webp' },
  { id: 'recreate', cover: '/imagine/recreate.webp' },
  { id: 'regenerate', cover: '/imagine/regenerate-detail.webp' },
  { id: 'compose', cover: '/imagine/compose.webp' },
  { id: 'loop', cover: '/imagine/loop.webp' },
  { id: 'bg', cover: '/imagine/bg.webp' },
  { id: 'frames', cover: '/imagine/frames.webp' },
  { id: 'upscale', cover: '/imagine/upscale.webp' },
  { id: 'music', cover: '/imagine/music.webp' },
  { id: 'voice', cover: '/imagine/voce.webp' },
  { id: 'tts', cover: '/imagine/tts.webp' },
  { id: 'clip', cover: '/imagine/clip.webp' },
] as const satisfies readonly { readonly id: WorkflowCardId; readonly cover: string }[]

/** The cards, each with its panel's title and summary as the locale keys it shows. */
export const JOB_CARDS = CARD_COVERS.map(card => ({
  ...card,
  title: WORKFLOW_SPECS[card.id].titleKey,
  hint: WORKFLOW_SPECS[card.id].summaryKey,
}))

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
  swapPerson: '/imagine/swapPerson',
  relight: '/imagine/relight',
  recreate: '/imagine/recreate',
}

/** One card of the home's grid. */
export type JobCardId = (typeof CARD_COVERS)[number]['id']

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
  swapPerson: 'image',
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
