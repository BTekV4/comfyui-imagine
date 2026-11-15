/**
 * The words a dated or measured row shows: a file's size and how long ago it
 * was written.
 *
 * Both went through three copies each before 2026-10-22 — `fileSizeText`
 * (bytes, English units), `sizeOf` and `sizeLabel` (KB until 1 MB, MB past it),
 * with three renderings of the same number on screen ("3.2MB", "3200 KB",
 * "3.2 MB"); and `ageOf` in the media wall beside `relativeTime` in the rail.
 * They are one function each now (the rail's own `relativeTime` went on
 * 2026-10-25), and both read the dictionary, because the
 * words belong to the dictionary (see `dates.ts` for why not `toLocaleString`).
 * @module labels
 */

import type { SocialPostStatus, SocialStoryStatus } from './gallery-api.ts'
import type { ComfyLocaleKey } from './locales.ts'
import type { MediaKind } from '../../../shared/imagine-types.ts'
import { translate } from './locale-store.ts'

/**
 * A file size in the largest unit that keeps it readable.
 *
 * Below a kilobyte the exact count is shown; past it one decimal below ten of
 * the chosen unit, whole numbers above, as the dictionary's own suffixes say.
 * @param bytes - the exact byte count.
 * @returns `512 B`, `4.2 KB`, `18 KB`, `1.5 MB`, `2.4 GB`.
 */
export function sizeLabel(bytes: number): string {
  const count = Number.isFinite(bytes) ? Math.max(0, Math.round(bytes)) : 0
  if (count < 1024) return translate('imagine.sizeBytes', { value: String(count) })
  const kb = bytes / 1024
  if (kb < 1024) return translate('imagine.sizeKb', { value: kb < 10 ? kb.toFixed(1) : String(Math.round(kb)) })
  const mb = kb / 1024
  if (mb < 1024) return translate('imagine.sizeMb', { value: mb < 10 ? mb.toFixed(1) : String(Math.round(mb)) })
  return translate('imagine.sizeGb', { value: (mb / 1024).toFixed(1) })
}

/**
 * How long ago something happened, in the dictionary's buckets.
 *
 * The bucket is rounded, not floored, so a row written 50 minutes ago reads
 * "1 h" rather than "0 h": the label answers "roughly when", and the exact
 * instant is the row's own title.
 * @param at - epoch ms of the moment.
 * @param now - the clock the row is drawn at.
 * @returns `now`, `5min`, `3h`, `2d`, `4mo`, `1y`.
 */
export function ageLabel(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return translate('imagine.time.now')
  if (minutes < 60) return translate('imagine.time.minutes', { n: String(minutes) })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return translate('imagine.time.hours', { n: String(hours) })
  const days = Math.round(hours / 24)
  if (days < 30) return translate('imagine.time.days', { n: String(days) })
  if (days < 365) return translate('imagine.time.months', { n: String(Math.round(days / 30)) })
  return translate('imagine.time.years', { n: String(Math.round(days / 365)) })
}

/**
 * The dictionary key of each state of the publication queue.
 *
 * The words belong to the dictionary (4-11-2026): they were Italian written
 * straight in this table, so the states stayed Italian with the page in
 * English.
 */
const POST_STATUS_KEY: Readonly<Partial<Record<SocialPostStatus, ComfyLocaleKey>>> = {
  draft: 'imagine.postStatusDraft',
  scheduled: 'imagine.postStatusScheduled',
  publishing: 'imagine.postStatusPublishing',
  published: 'imagine.postStatusPublished',
  error: 'imagine.postStatusError',
}

/** How each state of the story queue reads: a story is feminine. */
const STORY_STATUS_KEY: Readonly<Partial<Record<SocialStoryStatus, ComfyLocaleKey>>> = {
  scheduled: 'imagine.storyStatusScheduled',
  publishing: 'imagine.storyStatusPublishing',
  published: 'imagine.storyStatusPublished',
  error: 'imagine.storyStatusError',
}

/**
 * How one state of the publication queue reads, in the chosen language.
 * @param status - the stored state.
 * @returns the word, or the state itself when the dictionary has none.
 */
export function postStatusLabel(status: SocialPostStatus): string {
  const key = POST_STATUS_KEY[status]
  return key === undefined ? status : translate(key)
}

/**
 * How one state of the story queue reads, in the chosen language.
 * @param status - the stored state.
 * @returns the word, or the state itself when the dictionary has none.
 */
export function storyStatusLabel(status: SocialStoryStatus): string {
  const key = STORY_STATUS_KEY[status]
  return key === undefined ? status : translate(key)
}

/** A kind of file as a word in a sentence («video»). */
const KIND_KEYS: Readonly<Record<MediaKind, ComfyLocaleKey>> = {
  image: 'imagine.kindImage',
  video: 'imagine.kindVideo',
  audio: 'imagine.kindAudio',
}

/**
 * The kinds a slot takes, as words joined by «or».
 * @param kinds - the accepted kinds.
 * @returns e.g. «image or video».
 */
export function kindsLabel(kinds: readonly MediaKind[]): string {
  return kinds.map(kind => translate(KIND_KEYS[kind])).join(translate('imagine.kindOr'))
}
