/**
 * Absolute dates in the app's own language.
 *
 * The rule: no `toLocaleString`/`toLocaleDateString` anywhere in the studio.
 * They follow the BROWSER language, not the app's: on an Italian page running
 * in an en-US browser they read "9/1/2026, 10:37:51 PM"; and `'it-IT'` pinned
 * by hand fixes the words but leaves the order of the fields to the browser's
 * ICU data. The patterns live in the dictionary (`imagine.dateStamp`,
 * `imagine.moment*`) and the month and day names here, once.
 * @module dates
 */

import { pad2 } from './format.ts'
import { translate } from './locale-store.ts'
import type { ComfyLocaleKey } from './locales.ts'

/** The month names, January first. The short form is the first three letters. */
const MONTH_KEYS = [
  'imagine.month.1', 'imagine.month.2', 'imagine.month.3', 'imagine.month.4',
  'imagine.month.5', 'imagine.month.6', 'imagine.month.7', 'imagine.month.8',
  'imagine.month.9', 'imagine.month.10', 'imagine.month.11', 'imagine.month.12',
] as const satisfies readonly ComfyLocaleKey[]

/** The weekday names, Monday first, the way an Italian calendar is read. */
const DAY_KEYS = [
  'imagine.day.1', 'imagine.day.2', 'imagine.day.3', 'imagine.day.4',
  'imagine.day.5', 'imagine.day.6', 'imagine.day.7',
] as const satisfies readonly ComfyLocaleKey[]

/** The weekdays as the chosen language writes them, Monday first. */
export const WEEKDAYS: readonly string[] = DAY_KEYS.map(key => translate(key))

/**
 * A month's name.
 * @param month - 0 to 11, as `Date.getMonth` gives it.
 * @param short - the three-letter form (`Oct`) instead of the whole word.
 * @returns the name; empty for a month out of range.
 */
export function monthName(month: number, short = false): string {
  const key = MONTH_KEYS[month]
  const name = key === undefined ? '' : translate(key)
  return short ? name.slice(0, 3) : name
}

/**
 * The weekday a date falls on, Monday first.
 * @param date - the day.
 * @returns its short name (`Mon` … `Sun`).
 */
export function weekdayOf(date: Date): string {
  return WEEKDAYS[(date.getDay() + 6) % 7] ?? ''
}

/**
 * An absolute date-and-time through the dictionary's own pattern.
 * @param at - epoch milliseconds.
 * @returns the stamp in the active locale's field order.
 */
export function dateStamp(at: number): string {
  const d = new Date(at)
  return translate('imagine.dateStamp', {
    y: d.getFullYear(),
    m: pad2(d.getMonth() + 1),
    d: pad2(d.getDate()),
    hh: pad2(d.getHours()),
    mm: pad2(d.getMinutes()),
  })
}

/**
 * A moment as a row says it: the day it belongs to, and the hour.
 *
 * Two copies of this lived in the social panels under the same name and with
 * different formats (`SocialStories.tsx`, `SocialComments.tsx`) until
 * 2026-10-22.
 * @param iso - the stored instant, or a datetime-local value.
 * @param pattern - `dayTime` (when a queued story goes out: `25 Oct, 18:00`),
 *   `short` (when a comment arrived: the hour only if it was today) or `full`
 *   (the day with its year: `25 Oct 2026, 18:00`).
 * @param now - the clock "today" is measured against.
 * @returns the label, or an empty string when there is no usable date.
 */
export function momentLabel(
  iso: string | undefined,
  pattern: 'dayTime' | 'short' | 'full',
  now: number = Date.now(),
): string {
  if (iso === undefined) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const clock = { hh: pad2(date.getHours()), mm: pad2(date.getMinutes()) }
  const today = new Date(now).toDateString() === date.toDateString()
  if (pattern === 'short' && today) return translate('imagine.momentTime', clock)
  const day = { ...clock, d: String(date.getDate()), m: monthName(date.getMonth(), true) }
  return pattern === 'full'
    ? translate('imagine.momentFull', { ...day, y: String(date.getFullYear()) })
    : translate('imagine.momentDayTime', day)
}
