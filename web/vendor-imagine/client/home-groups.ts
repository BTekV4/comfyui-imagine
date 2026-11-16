/**
 * The home's one grid: which filter group each card belongs to, and the order
 * the cards come in.
 *
 * Grok Imagine shows its tools as one row; ours were two sections, the
 * workflow cards and the ready-made models under them. They are one grid now,
 * with a row of chips above it (All · Photo · People · Product · Video ·
 * Graphics · Audio). Every flow card and every model has exactly one group,
 * written out below; an uploaded workflow takes its group from what it makes.
 *
 * Audio is a chip of its own rather than a corner of Video: music, a changed
 * voice and speech make sound, not pictures, and under Video they would be the
 * three cards that do not move.
 *
 * Pure: no DOM but the two guarded `localStorage` calls at the bottom.
 * @module home-groups
 */

import { TEMPLATES } from '../../../shared/imagine-templates.ts'
import { JOB_CARDS, type JobCardId } from './job-cards.ts'
import type { ComfyLocaleKey } from './locales.ts'

/** The chips, in the order the row shows them; `all` is not a group. */
export const HOME_GROUPS = ['photo', 'people', 'product', 'video', 'graphics', 'audio'] as const

/** One filter group. */
export type HomeGroupId = (typeof HOME_GROUPS)[number]

/** What a chip filters by: one group, or everything. */
export type HomeFilter = HomeGroupId | 'all'

/** The words of each chip. */
export const FILTER_LABEL: Readonly<Record<HomeFilter, ComfyLocaleKey>> = {
  all: 'imagine.home.group.all',
  photo: 'imagine.home.group.photo',
  people: 'imagine.home.group.people',
  product: 'imagine.home.group.product',
  video: 'imagine.home.group.video',
  graphics: 'imagine.home.group.graphics',
  audio: 'imagine.home.group.audio',
}

/** A model's id, as the catalog spells it. */
export type TemplateId = (typeof TEMPLATES)[number]['id']

/** The group of each workflow card. */
export const FLOW_GROUP: Readonly<Record<JobCardId, HomeGroupId>> = {
  generate: 'photo',
  remix: 'photo',
  style: 'photo',
  video: 'video',
  objectSwap: 'video',
  // A clip whose person is played by the one in a photo: it is about people.
  swapPerson: 'people',
  relight: 'photo',
  recreate: 'video',
  regenerate: 'video',
  compose: 'people',
  loop: 'video',
  bg: 'photo',
  frames: 'video',
  upscale: 'photo',
  music: 'audio',
  voice: 'audio',
  tts: 'audio',
  clip: 'video',
}

/**
 * The group of each model. Mostly its catalog category, except where the
 * category names a channel rather than a kind of result: the UGC set is
 * product photos, the emoji pack and the poster are graphics, the collage is
 * a photo.
 */
export const MODEL_GROUP: Readonly<Record<TemplateId, HomeGroupId>> = {
  'photo-edit': 'photo',
  background: 'photo',
  headshot: 'people',
  'profile-picture': 'people',
  restyle: 'photo',
  'product-color': 'product',
  'smart-resize': 'photo',
  collage: 'photo',
  ecommerce: 'product',
  ugc: 'product',
  'editorial-poster': 'graphics',
  'icon-maker': 'graphics',
  'emoji-pack': 'graphics',
  'mascot-maker': 'graphics',
  'character-sprite': 'graphics',
  'hero-reveal': 'product',
}

/** An uploaded workflow, as much of it as its place in the grid needs. */
export interface CustomCardRef {
  readonly id: string
  readonly output: 'image' | 'video'
}

/** One card of the grid, whichever kind it is. */
export type HomeEntry =
  | { readonly kind: 'flow'; readonly id: JobCardId; readonly group: HomeGroupId }
  | { readonly kind: 'model'; readonly id: TemplateId; readonly group: HomeGroupId }
  | { readonly kind: 'custom'; readonly id: string; readonly group: HomeGroupId }

/**
 * How many flow cards open the grid before anything is mixed in: the four
 * the studio is for (generate, edit, style, video), as on Grok's home.
 */
const CORE_FLOWS = 4

/**
 * The order of «All».
 *
 * The first four flow cards, in their own order; then one card per group in
 * turn (Photo, People, Product, Video, Graphics, Audio, and again), each
 * group giving its flow cards before its models, both in catalog order; the
 * user's uploaded workflows last. So the first screen is the studio's tools
 * with a few models among them, never a wall of models, and the same lists
 * give the same order every time.
 * @param custom - the user's uploaded workflows, in the order the host lists them.
 * @returns every card of the grid.
 */
export function homeOrder(custom: readonly CustomCardRef[] = []): HomeEntry[] {
  const flows: HomeEntry[] = JOB_CARDS.map(card => ({ kind: 'flow', id: card.id, group: FLOW_GROUP[card.id] }))
  const head = flows.slice(0, CORE_FLOWS)
  const queues = new Map<HomeGroupId, HomeEntry[]>(HOME_GROUPS.map(group => [group, []]))
  for (const entry of flows.slice(CORE_FLOWS)) queues.get(entry.group)?.push(entry)
  for (const template of TEMPLATES) {
    queues.get(MODEL_GROUP[template.id])?.push({ kind: 'model', id: template.id, group: MODEL_GROUP[template.id] })
  }
  const mixed: HomeEntry[] = []
  for (let round = 0; mixed.length < flows.length - head.length + TEMPLATES.length; round++) {
    for (const group of HOME_GROUPS) {
      const next = queues.get(group)?.[round]
      if (next !== undefined) mixed.push(next)
    }
  }
  const own: HomeEntry[] = custom.map(workflow => ({
    kind: 'custom', id: workflow.id, group: workflow.output === 'video' ? 'video' : 'photo',
  }))
  return [...head, ...mixed, ...own]
}

/**
 * The cards a chip shows, in the order of «All».
 * @param entries - the whole grid ({@link homeOrder}).
 * @param filter - the chip.
 * @returns the cards it keeps.
 */
export function filterHome(entries: readonly HomeEntry[], filter: HomeFilter): HomeEntry[] {
  return filter === 'all' ? [...entries] : entries.filter(entry => entry.group === filter)
}

/** Whether a stored value is a chip. */
export function isHomeFilter(value: unknown): value is HomeFilter {
  return value === 'all' || HOME_GROUPS.includes(value as HomeGroupId)
}

const FILTER_KEY = 'imagine.homeFilter.v1'

/** The chip this viewer picked last; All when none, or when storage is closed. */
export function storedHomeFilter(): HomeFilter {
  try {
    const raw = localStorage.getItem(FILTER_KEY)
    return isHomeFilter(raw) ? raw : 'all'
  } catch {
    return 'all'
  }
}

/** Remember the chip for this viewer; a closed storage just forgets it. */
export function storeHomeFilter(filter: HomeFilter): void {
  try { localStorage.setItem(FILTER_KEY, filter) } catch { /* private mode */ }
}
