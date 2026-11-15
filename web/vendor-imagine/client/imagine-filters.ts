/**
 * What made a file, and the filters over the inventory: the History's
 * (period, kind, origin, order), and what the Library and All media
 * share with it (the kind, the tool's name).
 *
 * All of it is a derivation over the inventory the host already sent, so a
 * filter costs no request: the gallery holds every file either way.
 */

import type { ComfyLocaleKey } from './locales.ts'
import { translate } from './locale-store.ts'
import { MEDIA_KINDS, type GalleryItem, type GalleryTool, type HostEdit, type ImagineAction, type MediaKind } from '../../../shared/imagine-types.ts'

/** How far back the History looks; `all` keeps every file. */
export type HistoryPeriod = 'all' | 'day' | 'week' | 'month'

/**
 * What a file came from, as one seat. The host's actions are grouped: what
 * matters when looking through a day's work is "the upscales" or "the animated
 * backgrounds", not which of two upscale tools ran.
 */
export type HistoryOrigin =
  | 'generated' | 'edited' | 'video' | 'loop' | 'upscale' | 'music' | 'voice' | 'clip' | 'other'

/** How the filtered files are ordered. */
export type HistoryOrder = 'recent' | 'oldest' | 'name' | 'size'

/** How the History draws the filtered files. */
export type HistoryView = 'grid' | 'list'

/** The History's period, kinds, origins, order and view, all together. */
export interface HistoryFilters {
  readonly period: HistoryPeriod
  /** Empty means every kind. */
  readonly kinds: readonly MediaKind[]
  /** Empty means every origin. */
  readonly origins: readonly HistoryOrigin[]
  readonly order: HistoryOrder
  readonly view: HistoryView
}

/** The History as it opens: everything, newest first, on the board. */
export const HISTORY_FILTERS_DEFAULT: HistoryFilters = {
  period: 'all',
  kinds: [],
  origins: [],
  order: 'recent',
  view: 'grid',
}

/** The period seats, in the order the bar draws them. */
export const HISTORY_PERIODS: readonly HistoryPeriod[] = ['all', 'day', 'week', 'month']

/** The kind seats, in the order the bar draws them. */
export const HISTORY_KINDS: readonly MediaKind[] = MEDIA_KINDS

/** The origin seats, in the order the menu lists them. */
export const HISTORY_ORIGINS: readonly HistoryOrigin[] = [
  'generated', 'edited', 'video', 'loop', 'upscale', 'music', 'voice', 'clip', 'other',
]

/** The order seats, in the order the menu lists them. */
export const HISTORY_ORDERS: readonly HistoryOrder[] = ['recent', 'oldest', 'name', 'size']

/*
 * Seat to copy key. Kept beside the seats so the bar and the list cannot end up
 * naming the same seat two ways; the text itself is the dictionary's.
 */

/** Copy key per period seat. */
export const HISTORY_PERIOD_KEYS: Readonly<Record<HistoryPeriod, ComfyLocaleKey>> = {
  all: 'imagine.periodAll',
  day: 'imagine.periodDay',
  week: 'imagine.periodWeek',
  month: 'imagine.periodMonth',
}

/** Copy key per kind seat; the counts arrive through the copy's own field. */
export const HISTORY_KIND_KEYS: Readonly<Record<MediaKind, ComfyLocaleKey>> = {
  image: 'imagine.images',
  video: 'imagine.videos',
  audio: 'imagine.audios',
}

/** Copy key per origin seat. */
export const HISTORY_ORIGIN_KEYS: Readonly<Record<HistoryOrigin, ComfyLocaleKey>> = {
  generated: 'imagine.originGenerated',
  edited: 'imagine.originEdited',
  video: 'imagine.originVideo',
  loop: 'imagine.originLoop',
  upscale: 'imagine.originUpscale',
  music: 'imagine.originMusic',
  voice: 'imagine.originVoice',
  clip: 'imagine.originClip',
  other: 'imagine.originOther',
}

/** Copy key per order seat. */
export const HISTORY_ORDER_KEYS: Readonly<Record<HistoryOrder, ComfyLocaleKey>> = {
  recent: 'imagine.orderRecent',
  oldest: 'imagine.orderOldest',
  name: 'imagine.orderName',
  size: 'imagine.orderSize',
}

/** How many hours each period reaches back; `all` has no bound. */
const PERIOD_HOURS: Readonly<Record<HistoryPeriod, number | undefined>> = {
  all: undefined,
  day: 24,
  week: 24 * 7,
  // Thirty days, which is what the seat says: the calendar month would move
  // the boundary under the user without a word.
  month: 24 * 30,
}

/*
 * What made a file has three tables, kept together here so a label is named
 * once: the host tool read off an output name (`GALLERY_TOOLS`), the host's
 * own edits that carry only a name prefix (`EDIT_PREFIX_LABELS`), and the
 * action a file's origin note records (`ACTION_LABEL_KEYS`, for Details).
 */

/** Each host tool once: the History seat it belongs to and what the Library calls the file it made. */
const GALLERY_TOOLS: Readonly<Record<GalleryTool, { readonly origin: HistoryOrigin; readonly labelKey: ComfyLocaleKey }>> = {
  generate_image: { origin: 'generated', labelKey: 'imagine.label.immagine-generata' },
  generate_lookbook: { origin: 'generated', labelKey: 'imagine.label.lookbook' },
  edit_image: { origin: 'edited', labelKey: 'imagine.label.foto-modificata' },
  remove_background: { origin: 'edited', labelKey: 'imagine.label.sfondo-tolto' },
  create_video: { origin: 'video', labelKey: 'imagine.label.video-da-foto' },
  extend_video: { origin: 'video', labelKey: 'imagine.label.video-continuato' },
  recreate_video: { origin: 'video', labelKey: 'imagine.label.video-ricreato' },
  // Not an upscale: the clip is redrawn, so the History keeps it among the
  // videos and not under "Upscale" (where the user would look for it by mistake).
  regenerate_detail: { origin: 'video', labelKey: 'imagine.label.dettaglio-rigenerato' },
  // An object changed, removed or added: for the History it is an edited
  // video, not an upscale.
  object_swap: { origin: 'video', labelKey: 'imagine.label.oggetto-cambiato' },
  swap_person: { origin: 'video', labelKey: 'imagine.label.personaggio-cambiato' },
  // A photo relit by a light look: for the History it is an edited photo.
  relight: { origin: 'edited', labelKey: 'imagine.label.illuminata' },
  animated_background: { origin: 'loop', labelKey: 'imagine.label.sfondo-animato' },
  upscale_image: { origin: 'upscale', labelKey: 'imagine.label.upscale-foto' },
  upscale_video: { origin: 'upscale', labelKey: 'imagine.label.upscale-video' },
  generate_music: { origin: 'music', labelKey: 'imagine.label.brano' },
  change_voice: { origin: 'voice', labelKey: 'imagine.label.voce-cambiata' },
  speak_text: { origin: 'voice', labelKey: 'imagine.label.voce-da-testo' },
  videoclip: { origin: 'clip', labelKey: 'imagine.label.videoclip' },
}

/** The host's own edits, which carry no tool: what the name's prefix says. */
const EDIT_PREFIX_LABELS: readonly (readonly [string, ComfyLocaleKey])[] = [
  ['upload-', 'imagine.label.file-caricato'],
  ['crop_image-', 'imagine.label.ritaglio'],
  ['trim_video-', 'imagine.label.video-tagliato'],
  ['merge_video-', 'imagine.label.video-unito'],
  ['extract_frame-', 'imagine.label.fotogramma'],
]

/**
 * What each action recorded in a file's origin is called on screen. Every
 * action and host edit has one: a missing entry is a compile error, not the
 * raw word («recreate») in Details.
 */
const ACTION_LABEL_KEYS: Readonly<Record<ImagineAction | HostEdit, ComfyLocaleKey>> = {
  generate: 'imagine.label.generata-da-testo',
  remix: 'imagine.label.foto-modificata',
  video: 'imagine.label.video-da-foto',
  extend: 'imagine.label.video-continuato',
  loop: 'imagine.label.sfondo-animato',
  story: 'imagine.label.video-lungo',
  // A redone or resumed shot is filed as `video`; these two name the request.
  redo: 'imagine.label.video-lungo',
  resume: 'imagine.label.video-lungo',
  upscale: 'imagine.label.upscale',
  bg: 'imagine.label.sfondo-tolto',
  music: 'imagine.label.brano-generato',
  voice: 'imagine.label.voce-cambiata',
  speak: 'imagine.label.voce-da-testo',
  scanFrame: 'imagine.label.fotogramma-disegnato',
  recreate: 'imagine.label.video-ricreato',
  regenerate: 'imagine.label.dettaglio-rigenerato',
  compose: 'imagine.label.composta',
  objectSwap: 'imagine.label.oggetto-cambiato',
  swapPerson: 'imagine.label.personaggio-cambiato',
  relight: 'imagine.label.illuminata',
  custom: 'imagine.label.workflow-personale',
  crop: 'imagine.label.ritaglio',
  duplicate: 'imagine.fileDuplicate',
  erase: 'imagine.label.oggetto-rimosso',
  trim: 'imagine.label.video-tagliato',
  merge: 'imagine.label.video-uniti',
  frame: 'imagine.label.fotogramma-estratto',
}

/**
 * The on-screen name of the action a file's origin records.
 * @param action - the action as filed (older notes may carry one no longer known).
 * @returns the label, or undefined for an action the studio does not name.
 */
export function actionLabelOf(action: string): string | undefined {
  return Object.hasOwn(ACTION_LABEL_KEYS, action)
    ? translate(ACTION_LABEL_KEYS[action as keyof typeof ACTION_LABEL_KEYS])
    : undefined
}

/** A file's kind, as a word, when nothing else names it. */
const KIND_LABEL: Readonly<Record<MediaKind, ComfyLocaleKey>> = { image: 'imagine.label.image', video: 'imagine.label.video', audio: 'imagine.label.audio' }

/**
 * What made a file, in the studio's words: the tool, else the host edit its
 * name starts with, else a copy, else its kind.
 * @param item - the gallery file.
 * @returns the label ("Edited photo", "Crop", "Copy", "Video"…).
 */
export function toolLabelOf(item: GalleryItem): string {
  if (item.tool !== undefined) return translate(GALLERY_TOOLS[item.tool].labelKey)
  const prefix = EDIT_PREFIX_LABELS.find(([start]) => item.name.startsWith(start))
  if (prefix !== undefined) return translate(prefix[1])
  if (item.name.includes('-copia-')) return translate('imagine.label.copia')
  return translate(KIND_LABEL[item.kind])
}

/**
 * The origin seat of one file.
 * @param tool - what the host read off the declared output name.
 * @returns the seat; an upload, or a file written before the host read the
 *   prefix, has none and lands in `other`.
 */
export function originOf(tool: GalleryTool | undefined): HistoryOrigin {
  return tool === undefined ? 'other' : GALLERY_TOOLS[tool].origin
}

/**
 * The History's filters as one test on a file, without the order: the
 * counting below needs which files pass, not in what order.
 * @param filters - the seats in force.
 * @param now - epoch milliseconds the periods are measured back from.
 * @returns whether a file is kept.
 */
function historyMatcher(filters: HistoryFilters, now: number): (item: GalleryItem) => boolean {
  const hours = PERIOD_HOURS[filters.period]
  const floor = hours === undefined ? undefined : now - hours * 60 * 60 * 1000
  const kinds = new Set(filters.kinds)
  const origins = new Set(filters.origins)
  return item =>
    (floor === undefined || item.mtime >= floor)
    && (kinds.size === 0 || kinds.has(item.kind))
    && (origins.size === 0 || origins.has(originOf(item.tool)))
}

/**
 * Narrow and order the inventory for the History.
 *
 * The order runs after the filters. `recent` returns the filtered array
 * untouched: the host already sent the inventory newest first, so that seat
 * costs no comparison at all.
 * @param items - the inventory, newest first as the host sent it.
 * @param filters - the seats in force.
 * @param now - epoch milliseconds the periods are measured back from.
 * @returns the files to draw, in the order asked for.
 */
export function filterHistory(
  items: readonly GalleryItem[],
  filters: HistoryFilters,
  now: number,
): readonly GalleryItem[] {
  const kept = items.filter(historyMatcher(filters, now))
  // `filter` already made a new array, so it is sorted in place.
  if (filters.order === 'oldest') kept.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name))
  if (filters.order === 'name') kept.sort((a, b) => a.name.localeCompare(b.name))
  if (filters.order === 'size') kept.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name))
  return kept
}

/**
 * How many files each kind seat would keep, so the chips can carry a count.
 *
 * The kind filter itself is left out of the counting on purpose: a seat that
 * counted only itself would read zero the moment it was picked, which is not a
 * number anyone can use.
 * @param items - the inventory, newest first.
 * @param filters - the seats in force.
 * @param now - epoch milliseconds the periods are measured back from.
 * @returns one count per kind.
 */
export function historyKindCounts(
  items: readonly GalleryItem[],
  filters: HistoryFilters,
  now: number,
): Readonly<Record<MediaKind, number>> {
  // Filtered only: sorting the whole result to count it was wasted work.
  return kindCounts(items.filter(historyMatcher({ ...filters, kinds: [] }, now)))
}

/**
 * How many files of each kind a list holds, in one pass.
 * @param items - the files.
 * @returns one count per kind.
 */
export function kindCounts(items: readonly GalleryItem[]): Readonly<Record<MediaKind, number>> {
  const counts: Record<MediaKind, number> = { image: 0, video: 0, audio: 0 }
  for (const item of items) counts[item.kind] += 1
  return counts
}

/**
 * Whether the History is showing anything less than everything.
 * @param filters - the seats in force.
 * @returns true when a period, a kind or an origin is set.
 */
export function historyNarrowed(filters: HistoryFilters): boolean {
  return filters.period !== 'all' || filters.kinds.length > 0 || filters.origins.length > 0
}
